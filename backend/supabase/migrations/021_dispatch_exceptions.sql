-- Audited no-show handling, returned-goods custody and Paystack-backed redelivery.

create table if not exists public.dispatch_returns (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders(id),
  customer_id uuid not null references public.profiles(id),
  original_price numeric(12,2) not null check (original_price >= 0),
  redelivery_fee numeric(12,0) not null check (redelivery_fee >= 0),
  reason text not null,
  status text not null default 'awaiting_collection'
    check (status in ('awaiting_collection', 'redelivery_requested', 'collected', 'unclaimed')),
  customer_notified_at timestamptz,
  collection_deadline_at timestamptz,
  redelivery_order_id uuid references public.orders(id),
  collected_at timestamptz,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  constraint dispatch_returns_notification_deadline_pair
    check ((customer_notified_at is null) = (collection_deadline_at is null))
);

create index if not exists dispatch_returns_customer_idx
  on public.dispatch_returns(customer_id, created_at desc);
create index if not exists dispatch_returns_open_idx
  on public.dispatch_returns(status, collection_deadline_at)
  where status = 'awaiting_collection';

alter table public.dispatch_returns enable row level security;
revoke all on public.dispatch_returns from public, anon, authenticated;
grant select on public.dispatch_returns to authenticated;
grant all on public.dispatch_returns to service_role;

drop policy if exists dispatch_returns_select on public.dispatch_returns;
create policy dispatch_returns_select on public.dispatch_returns
for select to authenticated
using (
  customer_id = (select auth.uid())
  or public.current_user_role() in ('admin', 'supervisor')
);

create or replace function public.report_delivery_exception(
  p_order_id uuid,
  p_issue text,
  p_reason text
)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  order_row public.orders;
begin
  if public.current_user_role() <> 'rider'
     or p_issue not in ('sender_unavailable', 'recipient_unavailable')
     or p_reason is null
     or length(trim(p_reason)) not between 3 and 1000 then
    raise exception 'Select an availability issue and provide 3 to 1000 characters of detail';
  end if;

  select * into order_row
  from public.orders
  where id = p_order_id and rider_id = auth.uid()
  for update;
  if order_row.id is null then
    raise exception 'An active delivery assigned to you was not found';
  end if;

  if p_issue = 'sender_unavailable' then
    if order_row.status <> 'accepted' then
      raise exception 'Sender unavailable can only be reported before the package is picked up';
    end if;
    update public.orders
    set status = 'cancelled', rider_id = null
    where id = order_row.id
    returning * into order_row;
    insert into public.order_events(order_id, actor_id, event, note)
    values (
      order_row.id, auth.uid(), 'sender_unavailable_at_pickup',
      left(trim(p_reason), 1000)
    );
    perform public.add_dispatch_alert(
      order_row.id, 'rider_problem',
      'Sender was unavailable at pickup. Dispatch cancelled; payment record was not changed.'
    );
    return order_row;
  end if;

  if order_row.status not in ('on_the_way', 'at_door') or order_row.pickup_at is null then
    raise exception 'Recipient unavailable can only be reported after the package has been picked up';
  end if;
  insert into public.order_events(order_id, actor_id, event, note)
  values (
    order_row.id, auth.uid(), 'recipient_unavailable_reported',
    left(trim(p_reason), 1000)
  );
  perform public.add_dispatch_alert(
    order_row.id, 'rider_problem',
    'Recipient unavailable after pickup. Operations must confirm return and custody arrangements.'
  );
  perform public.add_dispatch_alert(
    order_row.id, 'reassignment_required',
    'Recipient unavailable; Operations must record the return to sender and goods custody.'
  );
  return order_row;
end
$$;

create or replace function public.admin_record_goods_return(
  p_order_id uuid,
  p_reason text,
  p_handover_details text
)
returns public.dispatch_returns
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  order_row public.orders;
  return_row public.dispatch_returns;
begin
  if public.current_user_role() not in ('admin', 'supervisor') then
    raise exception 'Operations access required';
  end if;
  if p_reason is null or length(trim(p_reason)) not between 3 and 1000
     or p_handover_details is null
     or length(trim(p_handover_details)) not between 5 and 2000 then
    raise exception 'Record the return reason and confirmed goods custody/handover details';
  end if;

  select * into order_row
  from public.orders
  where id = p_order_id
  for update;
  if order_row.id is null
     or order_row.status not in ('picked_up', 'on_the_way', 'at_door')
     or order_row.payment_status <> 'paid' then
    raise exception 'Only a paid, collected delivery can be recorded as returned';
  end if;
  if not exists (
    select 1 from public.order_events report
    where report.order_id = p_order_id
      and report.event = 'recipient_unavailable_reported'
      and not exists (
        select 1 from public.order_events resolution
        where resolution.order_id = report.order_id
          and resolution.event = 'recipient_unavailability_resolved'
          and resolution.created_at > report.created_at
      )
  ) then
    raise exception 'A rider recipient-unavailable report is required before recording a return';
  end if;
  if exists (select 1 from public.dispatch_returns where order_id = p_order_id) then
    raise exception 'A goods return is already recorded for this delivery';
  end if;

  perform public.admin_cancel_order(
    p_order_id,
    'Recipient unavailable; returned to sender. ' || left(trim(p_reason), 900),
    true,
    p_handover_details
  );

  insert into public.dispatch_returns(
    order_id, customer_id, original_price, redelivery_fee, reason, created_by
  ) values (
    order_row.id,
    order_row.customer_id,
    order_row.final_price,
    round(order_row.final_price * 0.45, 0),
    left(trim(p_reason), 1000),
    auth.uid()
  )
  returning * into return_row;
  return return_row;
end
$$;

create or replace function public.admin_confirm_return_notification(p_return_id uuid)
returns public.dispatch_returns
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  return_row public.dispatch_returns;
  deadline timestamptz;
  working_days integer := 0;
begin
  if public.current_user_role() not in ('admin', 'supervisor') then
    raise exception 'Operations access required';
  end if;
  select * into return_row
  from public.dispatch_returns
  where id = p_return_id and status = 'awaiting_collection'
  for update;
  if return_row.id is null then
    raise exception 'An open goods return was not found';
  end if;

  deadline := clock_timestamp();
  while working_days < 3 loop
    deadline := deadline + interval '1 day';
    if extract(isodow from (deadline at time zone 'Africa/Lagos')) between 1 and 5 then
      working_days := working_days + 1;
    end if;
  end loop;

  update public.dispatch_returns
  set customer_notified_at = clock_timestamp(),
      collection_deadline_at = deadline
  where id = p_return_id
  returning * into return_row;
  insert into public.order_events(order_id, actor_id, event, note)
  values (
    return_row.order_id, auth.uid(), 'customer_notified_goods_ready',
    'Customer notification confirmed. Collection deadline: ' || deadline::text
  );
  return return_row;
end
$$;

create or replace function public.admin_mark_return_collected(p_return_id uuid)
returns public.dispatch_returns
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  return_row public.dispatch_returns;
begin
  if public.current_user_role() not in ('admin', 'supervisor') then
    raise exception 'Operations access required';
  end if;
  update public.dispatch_returns
  set status = 'collected', collected_at = now()
  where id = p_return_id and status = 'awaiting_collection'
  returning * into return_row;
  if return_row.id is null then
    raise exception 'An open goods return was not found';
  end if;
  insert into public.order_events(order_id, actor_id, event, note)
  values (return_row.order_id, auth.uid(), 'returned_goods_collected', 'Customer collected returned goods');
  return return_row;
end
$$;

create or replace function public.admin_mark_return_unclaimed(p_return_id uuid)
returns public.dispatch_returns
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  return_row public.dispatch_returns;
begin
  if public.current_user_role() not in ('admin', 'supervisor') then
    raise exception 'Operations access required';
  end if;
  update public.dispatch_returns
  set status = 'unclaimed'
  where id = p_return_id
    and status = 'awaiting_collection'
    and collection_deadline_at is not null
    and collection_deadline_at <= now()
  returning * into return_row;
  if return_row.id is null then
    raise exception 'The collection period has not ended or the return is no longer open';
  end if;
  insert into public.order_events(order_id, actor_id, event, note)
  values (
    return_row.order_id, auth.uid(), 'returned_goods_unclaimed',
    'Three-working-day collection period ended. Further handling requires Operations review under applicable law.'
  );
  return return_row;
end
$$;

create or replace function public.admin_resolve_recipient_unavailability(
  p_order_id uuid,
  p_note text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  order_status text;
begin
  if public.current_user_role() not in ('admin', 'supervisor') then
    raise exception 'Operations access required';
  end if;
  if p_note is null or length(trim(p_note)) not between 3 and 1000 then
    raise exception 'Record how recipient availability was confirmed';
  end if;
  select status into order_status
  from public.orders
  where id = p_order_id and status in ('on_the_way', 'at_door')
  for update;
  if order_status is null
     or not exists (
       select 1 from public.order_events report
       where report.order_id = p_order_id
         and report.event = 'recipient_unavailable_reported'
         and not exists (
           select 1 from public.order_events resolution
           where resolution.order_id = report.order_id
             and resolution.event = 'recipient_unavailability_resolved'
             and resolution.created_at > report.created_at
         )
     ) then
    raise exception 'An unresolved recipient-unavailable report was not found';
  end if;
  insert into public.order_events(order_id, actor_id, event, note)
  values (
    p_order_id, auth.uid(), 'recipient_unavailability_resolved',
    left(trim(p_note), 1000)
  );
  update public.dispatch_alerts
  set resolved_at = now(), resolved_by = auth.uid()
  where order_id = p_order_id
    and alert_type in ('rider_problem', 'reassignment_required')
    and resolved_at is null;
end
$$;

create or replace function public.advance_order(p_order_id uuid, p_status text)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  order_row public.orders;
  old_status text;
begin
  select status into old_status
  from public.orders
  where id = p_order_id and rider_id = auth.uid()
  for update;
  if old_status is null then
    raise exception 'Assigned delivery not found';
  end if;
  if exists (
    select 1 from public.order_events report
    where report.order_id = p_order_id
      and report.event = 'recipient_unavailable_reported'
      and not exists (
        select 1 from public.order_events resolution
        where resolution.order_id = report.order_id
          and resolution.event = 'recipient_unavailability_resolved'
          and resolution.created_at > report.created_at
      )
  ) then
    raise exception 'Operations must resolve the recipient-unavailable report before delivery can continue';
  end if;
  if not (
    (old_status = 'accepted' and p_status = 'picked_up')
    or (old_status = 'picked_up' and p_status = 'on_the_way')
    or (old_status = 'on_the_way' and p_status = 'at_door')
    or (old_status = 'at_door' and p_status = 'delivered')
  ) then
    raise exception 'Invalid delivery stage';
  end if;
  update public.orders
  set status = p_status,
      pickup_at = case when p_status = 'picked_up' then now() else pickup_at end,
      at_door_at = case when p_status = 'at_door' then now() else at_door_at end,
      delivered_at = case when p_status = 'delivered' then now() else delivered_at end
  where id = p_order_id
  returning * into order_row;
  insert into public.order_events(order_id, actor_id, event)
  values (order_row.id, auth.uid(), 'status_changed');
  return order_row;
end
$$;

create or replace function public.request_return_redelivery(p_return_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  return_row public.dispatch_returns;
  original_order public.orders;
  redelivery_order public.orders;
begin
  if auth.uid() is null or public.current_user_role() <> 'customer' then
    raise exception 'A signed-in customer account is required';
  end if;
  select * into return_row
  from public.dispatch_returns
  where id = p_return_id and customer_id = auth.uid()
  for update;
  if return_row.id is null or return_row.status <> 'awaiting_collection'
     or return_row.customer_notified_at is null
     or return_row.collection_deadline_at <= now() then
    raise exception 'Redelivery is available only before the notified collection deadline';
  end if;
  select * into original_order
  from public.orders
  where id = return_row.order_id and customer_id = auth.uid();
  if original_order.id is null or return_row.redelivery_fee <= 0 then
    raise exception 'The original delivery or redelivery price is unavailable';
  end if;

  insert into public.orders(
    customer_id, pickup_address, pickup_latitude, pickup_longitude,
    dropoff_address, dropoff_latitude, dropoff_longitude, recipient_name,
    recipient_phone, goods_description, weight_kg, length_cm, width_cm,
    height_cm, package_size, package_category, vehicle_type,
    distance_meters, distance_km, duration_seconds, duration_minutes,
    system_price, final_price, quote_expires_at, status, payment_status,
    delivery_speed
  ) values (
    original_order.customer_id, original_order.pickup_address,
    original_order.pickup_latitude, original_order.pickup_longitude,
    original_order.dropoff_address, original_order.dropoff_latitude,
    original_order.dropoff_longitude, original_order.recipient_name,
    original_order.recipient_phone, original_order.goods_description,
    original_order.weight_kg, original_order.length_cm, original_order.width_cm,
    original_order.height_cm, original_order.package_size,
    original_order.package_category, original_order.vehicle_type,
    original_order.distance_meters, original_order.distance_km,
    original_order.duration_seconds, original_order.duration_minutes,
    return_row.redelivery_fee, return_row.redelivery_fee,
    least(now() + interval '24 hours', return_row.collection_deadline_at),
    'approved', 'unpaid', original_order.delivery_speed
  )
  returning * into redelivery_order;

  insert into public.delivery_quote_reviews(
    order_id, customer_id, distance_meters, duration_seconds,
    suggested_price, approved_price, status, reviewed_by, reviewed_at,
    admin_note, requires_manual_review, expires_at
  ) values (
    redelivery_order.id, auth.uid(), original_order.distance_meters,
    original_order.duration_seconds, return_row.redelivery_fee,
    return_row.redelivery_fee, 'approved', null, now(),
    'Contract redelivery price: 45% of the original dispatch price.',
    false, redelivery_order.quote_expires_at
  );

  update public.dispatch_returns
  set status = 'redelivery_requested', redelivery_order_id = redelivery_order.id
  where id = p_return_id;
  insert into public.order_events(order_id, actor_id, event, note)
  values (
    redelivery_order.id, auth.uid(), 'redelivery_quote_created',
    'Redelivery quote created for 45% of the original dispatch price; normal Paystack checkout required.'
  );
  return redelivery_order.id;
end
$$;

revoke all on function public.report_delivery_exception(uuid, text, text) from public, anon;
revoke all on function public.admin_record_goods_return(uuid, text, text) from public, anon;
revoke all on function public.admin_confirm_return_notification(uuid) from public, anon;
revoke all on function public.admin_mark_return_collected(uuid) from public, anon;
revoke all on function public.admin_mark_return_unclaimed(uuid) from public, anon;
revoke all on function public.admin_resolve_recipient_unavailability(uuid, text) from public, anon;
revoke all on function public.request_return_redelivery(uuid) from public, anon;
grant execute on function public.report_delivery_exception(uuid, text, text) to authenticated;
grant execute on function public.admin_record_goods_return(uuid, text, text) to authenticated;
grant execute on function public.admin_confirm_return_notification(uuid) to authenticated;
grant execute on function public.admin_mark_return_collected(uuid) to authenticated;
grant execute on function public.admin_mark_return_unclaimed(uuid) to authenticated;
grant execute on function public.admin_resolve_recipient_unavailability(uuid, text) to authenticated;
grant execute on function public.request_return_redelivery(uuid) to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'dispatch_returns'
  ) then
    alter publication supabase_realtime add table public.dispatch_returns;
  end if;
end
$$;
