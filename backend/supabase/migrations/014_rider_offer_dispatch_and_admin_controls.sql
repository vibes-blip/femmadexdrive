-- Durable rider offers, explicit vehicle eligibility, and audited operations
-- for the existing Paystack-backed delivery workflow.

create or replace function public.vehicle_rank(v text)
returns integer
language sql
immutable
as $$
  select case lower(trim(coalesce(v, '')))
    when 'motorcycle' then 1
    when 'bike' then 1
    when 'car' then 2
    when 'van' then 3
    when 'truck' then 4
    when 'lorry' then 4
    else 0
  end
$$;

-- Compatibility is deliberately exact by vehicle class. Bike/motorcycle and
-- truck/lorry are aliases; larger vehicles do not implicitly match smaller jobs.
create or replace function public.vehicle_compatible(p_rider_vehicle text, p_order_vehicle text)
returns boolean
language sql
immutable
as $$
  select case
    when lower(trim(coalesce(p_order_vehicle, ''))) in ('motorcycle', 'bike')
      then lower(trim(coalesce(p_rider_vehicle, ''))) in ('motorcycle', 'bike')
    when lower(trim(coalesce(p_order_vehicle, ''))) = 'car'
      then lower(trim(coalesce(p_rider_vehicle, ''))) = 'car'
    when lower(trim(coalesce(p_order_vehicle, ''))) = 'van'
      then lower(trim(coalesce(p_rider_vehicle, ''))) = 'van'
    when lower(trim(coalesce(p_order_vehicle, ''))) in ('truck', 'lorry')
      then lower(trim(coalesce(p_rider_vehicle, ''))) in ('truck', 'lorry')
    else false
  end
$$;

create table if not exists public.dispatch_settings (
  id boolean primary key default true check (id),
  offer_timeout_seconds integer not null default 90 check (offer_timeout_seconds between 30 and 3600),
  unassigned_alert_minutes integer not null default 15 check (unassigned_alert_minutes between 1 and 10080),
  updated_at timestamptz not null default now()
);

insert into public.dispatch_settings(id) values (true)
on conflict (id) do nothing;

create table if not exists public.rider_offers (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  rider_id uuid not null references public.riders(id) on delete cascade,
  status text not null default 'offered'
    check (status in ('offered', 'accepted', 'declined', 'timed_out', 'revoked')),
  offered_at timestamptz not null default now(),
  expires_at timestamptz not null,
  responded_at timestamptz,
  decline_reason text,
  unique (order_id, rider_id)
);

create index if not exists rider_offers_rider_status_idx
  on public.rider_offers(rider_id, status, expires_at);
create index if not exists rider_offers_order_status_idx
  on public.rider_offers(order_id, status);

create table if not exists public.order_assignment_history (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  previous_rider_id uuid references public.riders(id),
  new_rider_id uuid references public.riders(id),
  actor_id uuid references public.profiles(id),
  action text not null check (action in ('assigned', 'reassigned', 'returned_to_pool', 'cancelled')),
  reason text not null,
  handover_confirmed boolean not null default false,
  handover_details text,
  created_at timestamptz not null default now()
);

create index if not exists order_assignment_history_order_idx
  on public.order_assignment_history(order_id, created_at desc);

create table if not exists public.dispatch_alerts (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  alert_type text not null
    check (alert_type in (
      'no_compatible_rider',
      'all_offers_exhausted',
      'unassigned_overdue',
      'rider_problem',
      'reassignment_required'
    )),
  details text not null,
  created_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid references public.profiles(id),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id)
);

create table if not exists public.rider_admin_events (
  id uuid primary key default gen_random_uuid(),
  rider_id uuid not null references public.riders(id) on delete cascade,
  actor_id uuid references public.profiles(id),
  event text not null,
  details text not null,
  created_at timestamptz not null default now()
);

alter table public.dispatch_alerts
  add column if not exists acknowledged_at timestamptz,
  add column if not exists acknowledged_by uuid references public.profiles(id);

create unique index if not exists dispatch_alerts_one_open_type_per_order_idx
  on public.dispatch_alerts(order_id, alert_type)
  where resolved_at is null;
create index if not exists dispatch_alerts_open_idx
  on public.dispatch_alerts(created_at desc)
  where resolved_at is null;

alter table public.dispatch_settings enable row level security;
alter table public.rider_offers enable row level security;
alter table public.order_assignment_history enable row level security;
alter table public.dispatch_alerts enable row level security;
alter table public.rider_admin_events enable row level security;

drop policy if exists rider_offers_select on public.rider_offers;
create policy rider_offers_select on public.rider_offers
for select to authenticated
using (
  rider_id = (select auth.uid())
  or public.current_user_role() in ('admin', 'supervisor')
);

drop policy if exists order_assignment_history_select on public.order_assignment_history;
create policy order_assignment_history_select on public.order_assignment_history
for select to authenticated
using (
  public.current_user_role() in ('admin', 'supervisor')
  or previous_rider_id = (select auth.uid())
  or new_rider_id = (select auth.uid())
);

drop policy if exists dispatch_alerts_select on public.dispatch_alerts;
create policy dispatch_alerts_select on public.dispatch_alerts
for select to authenticated
using (public.current_user_role() in ('admin', 'supervisor'));

drop policy if exists rider_admin_events_select on public.rider_admin_events;
create policy rider_admin_events_select on public.rider_admin_events
for select to authenticated
using (
  rider_id = (select auth.uid())
  or public.current_user_role() in ('admin', 'supervisor')
);

revoke all on public.dispatch_settings from public, anon, authenticated;
grant all on public.dispatch_settings to service_role;
revoke all on public.rider_offers from public, anon, authenticated;
grant select on public.rider_offers to authenticated;
revoke all on public.order_assignment_history from public, anon, authenticated;
grant select on public.order_assignment_history to authenticated;
revoke all on public.dispatch_alerts from public, anon, authenticated;
grant select on public.dispatch_alerts to authenticated;
revoke all on public.rider_admin_events from public, anon, authenticated;
grant select on public.rider_admin_events to authenticated;

-- Customers may edit their own basic profile, but never elevate their role.
create or replace function public.prevent_profile_role_escalation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.id = (select auth.uid())
     and public.current_user_role() not in ('admin', 'supervisor')
     and (new.role is distinct from old.role or new.id is distinct from old.id) then
    raise exception 'Account roles and identity can only be changed by operations';
  end if;
  return new;
end
$$;

drop trigger if exists profiles_prevent_role_escalation on public.profiles;
create trigger profiles_prevent_role_escalation
before update on public.profiles
for each row execute function public.prevent_profile_role_escalation();

-- Rider approval, vehicle and availability are server-owned; rider clients use
-- narrowly-scoped RPCs instead of direct table updates.
drop policy if exists riders_update on public.riders;
create policy riders_update on public.riders
for update to authenticated
using (public.current_user_role() in ('admin', 'supervisor'))
with check (public.current_user_role() in ('admin', 'supervisor'));

create or replace function public.prevent_ineligible_rider_active_delivery()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.approval_status = 'approved'
     and new.approval_status <> 'approved'
     and exists (
       select 1 from public.orders o
       where o.rider_id = old.id
         and o.status not in ('completed', 'cancelled')
     ) then
    raise exception 'Return or reassign the active delivery before suspending or rejecting this rider';
  end if;
  return new;
end
$$;

drop trigger if exists riders_prevent_ineligible_active_delivery on public.riders;
create trigger riders_prevent_ineligible_active_delivery
before update of approval_status on public.riders
for each row execute function public.prevent_ineligible_rider_active_delivery();

create or replace function public.save_rider_document_path(p_kind text, p_path text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.current_user_role() <> 'rider' or p_path is null
     or p_path !~ ('^' || (select auth.uid())::text || '/(bike|identity)-[A-Za-z0-9._-]+$') then
    raise exception 'Invalid rider document path';
  end if;

  if p_kind = 'bike' then
    update public.riders set bike_image_path = p_path where id = (select auth.uid());
  elsif p_kind = 'identity' then
    update public.riders set identity_document_path = p_path where id = (select auth.uid());
  else
    raise exception 'Unsupported rider document type';
  end if;

  if not found then
    raise exception 'Rider profile not found';
  end if;
end
$$;

create or replace function public.add_dispatch_alert(
  p_order_id uuid,
  p_type text,
  p_details text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  alert_id uuid;
begin
  insert into public.dispatch_alerts(order_id, alert_type, details)
  values (p_order_id, p_type, left(coalesce(p_details, ''), 2000))
  on conflict (order_id, alert_type) where resolved_at is null do nothing
  returning id into alert_id;

  if alert_id is not null then
    insert into public.order_events(order_id, actor_id, event, note)
    values (p_order_id, null, 'dispatch_' || p_type, left(coalesce(p_details, ''), 2000));
  end if;
end
$$;

create or replace function public.dispatch_pending_orders()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  timeout_seconds integer;
  unassigned_minutes integer;
  created_count integer := 0;
  order_row record;
begin
  if (select auth.uid()) is not null
     and public.current_user_role() not in ('rider', 'admin', 'supervisor') then
    raise exception 'Dispatch access required';
  end if;

  select offer_timeout_seconds, unassigned_alert_minutes
  into timeout_seconds, unassigned_minutes
  from public.dispatch_settings where id = true;

  with timed_out as (
    update public.rider_offers
    set status = 'timed_out', responded_at = now()
    where status = 'offered' and expires_at <= now()
    returning order_id, rider_id
  )
  insert into public.order_events(order_id, actor_id, event, note)
  select order_id, rider_id, 'rider_offer_timed_out', 'Rider offer expired without acceptance'
  from timed_out;

  update public.rider_offers ro
  set status = 'revoked', responded_at = now()
  from public.orders o, public.riders r
  where ro.order_id = o.id
    and ro.rider_id = r.id
    and ro.status = 'offered'
    and (
      o.rider_id is not null
      or o.payment_status <> 'paid'
      or o.status not in ('paid', 'searching')
      or r.approval_status <> 'approved'
      or not r.is_online
      or not exists (
        select 1 from public.profiles rider_profile
        where rider_profile.id = r.id and rider_profile.role = 'rider'
      )
      or not public.vehicle_compatible(r.vehicle_type, o.vehicle_type)
      or exists (
        select 1 from public.orders active_order
        where active_order.rider_id = r.id
          and active_order.status not in ('completed', 'cancelled')
      )
    );

  insert into public.rider_offers(order_id, rider_id, status, offered_at, expires_at)
  select o.id, r.id, 'offered', now(), now() + make_interval(secs => timeout_seconds)
  from public.orders o
  cross join public.riders r
  where o.rider_id is null
    and o.payment_status = 'paid'
    and o.status in ('paid', 'searching')
    and r.approval_status = 'approved'
    and r.is_online
    and exists (
      select 1 from public.profiles rider_profile
      where rider_profile.id = r.id and rider_profile.role = 'rider'
    )
    and public.vehicle_compatible(r.vehicle_type, o.vehicle_type)
    and not exists (
      select 1 from public.orders active_order
      where active_order.rider_id = r.id
        and active_order.status not in ('completed', 'cancelled')
    )
    and not exists (
      select 1 from public.rider_offers prior
      where prior.order_id = o.id
        and prior.rider_id = r.id
        and prior.status in ('declined', 'timed_out', 'accepted')
    )
  on conflict (order_id, rider_id) do update
    set status = 'offered', offered_at = excluded.offered_at,
        expires_at = excluded.expires_at, responded_at = null,
        decline_reason = null
    where public.rider_offers.status = 'revoked';
  get diagnostics created_count = row_count;

  for order_row in
    select o.id,
      greatest(
        o.created_at,
        coalesce((
          select max(e.created_at) from public.order_events e
          where e.order_id = o.id
            and e.event in ('payment_confirmed', 'admin_returned_to_pool')
        ), o.created_at)
      ) as queue_started_at,
      exists (
        select 1 from public.riders r
        where r.approval_status = 'approved' and r.is_online
          and exists (
            select 1 from public.profiles rider_profile
            where rider_profile.id = r.id and rider_profile.role = 'rider'
          )
          and public.vehicle_compatible(r.vehicle_type, o.vehicle_type)
          and not exists (
            select 1 from public.orders active_order
            where active_order.rider_id = r.id
              and active_order.status not in ('completed', 'cancelled')
          )
      ) as has_eligible_rider,
      exists (
        select 1 from public.rider_offers ro
        where ro.order_id = o.id and ro.status = 'offered' and ro.expires_at > now()
      ) as has_open_offer,
      exists (
        select 1 from public.rider_offers ro
        where ro.order_id = o.id and ro.status in ('declined', 'timed_out')
      ) as has_offer_history
    from public.orders o
    where o.rider_id is null
      and o.payment_status = 'paid'
      and o.status in ('paid', 'searching')
  loop
    if not order_row.has_eligible_rider then
      perform public.add_dispatch_alert(
        order_row.id, 'no_compatible_rider',
        'No approved, online, compatible rider is currently available.'
      );
    elsif not order_row.has_open_offer and order_row.has_offer_history then
      perform public.add_dispatch_alert(
        order_row.id, 'all_offers_exhausted',
        'All current compatible rider offers were declined or timed out; the paid order remains pending.'
      );
    end if;

    if order_row.queue_started_at <= now() - make_interval(mins => unassigned_minutes) then
      perform public.add_dispatch_alert(
        order_row.id, 'unassigned_overdue',
        'The paid delivery has remained unassigned beyond the configured dispatch threshold.'
      );
    end if;
  end loop;

  update public.dispatch_alerts a
  set resolved_at = now(), resolved_by = (select auth.uid())
  from public.orders o
  where a.order_id = o.id
    and a.resolved_at is null
    and (
      (o.rider_id is not null and a.alert_type in (
        'no_compatible_rider', 'all_offers_exhausted', 'unassigned_overdue'
      ))
      or o.status in ('completed', 'cancelled')
      or o.payment_status <> 'paid'
    );

  return coalesce(created_count, 0);
end
$$;

drop function if exists public.get_rider_available_orders();
create function public.get_rider_available_orders()
returns table(
  id uuid,
  tracking_number text,
  pickup_address text,
  pickup_latitude double precision,
  pickup_longitude double precision,
  dropoff_address text,
  dropoff_latitude double precision,
  dropoff_longitude double precision,
  recipient_name text,
  recipient_phone text,
  goods_description text,
  weight_kg numeric,
  length_cm numeric,
  width_cm numeric,
  height_cm numeric,
  package_size text,
  vehicle_type text,
  distance_km numeric,
  duration_minutes integer,
  final_price numeric,
  status text,
  created_at timestamptz,
  offer_expires_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.current_user_role() <> 'rider'
     or not exists (
       select 1 from public.riders r
       where r.id = (select auth.uid())
         and r.approval_status = 'approved'
         and r.is_online
         and exists (
           select 1 from public.profiles rider_profile
           where rider_profile.id = r.id and rider_profile.role = 'rider'
         )
     )
     or exists (
       select 1 from public.orders o
       where o.rider_id = (select auth.uid())
         and o.status not in ('completed', 'cancelled')
     ) then
    return;
  end if;

  perform public.dispatch_pending_orders();

  return query
  select o.id, o.tracking_number,
         o.pickup_address, o.pickup_latitude, o.pickup_longitude,
         o.dropoff_address, o.dropoff_latitude, o.dropoff_longitude,
         o.recipient_name, o.recipient_phone,
         o.goods_description, o.weight_kg, o.length_cm, o.width_cm, o.height_cm,
         o.package_size, o.vehicle_type, o.distance_km, o.duration_minutes,
         o.final_price, o.status, o.created_at, offer.expires_at
  from public.rider_offers offer
  join public.orders o on o.id = offer.order_id
  join public.riders r on r.id = offer.rider_id
  where offer.rider_id = (select auth.uid())
    and offer.status = 'offered'
    and offer.expires_at > now()
    and o.rider_id is null
    and o.payment_status = 'paid'
    and o.status in ('paid', 'searching')
    and r.approval_status = 'approved'
    and r.is_online
    and public.vehicle_compatible(r.vehicle_type, o.vehicle_type)
  order by o.created_at asc
  limit 100;
end
$$;

drop function if exists public.decline_order(uuid, text);
drop function if exists public.decline_order(uuid);
create function public.decline_order(p_order_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  offer_row public.rider_offers;
begin
  if public.current_user_role() <> 'rider' then
    raise exception 'Rider access required';
  end if;

  select ro.* into offer_row
  from public.rider_offers ro
  join public.orders o on o.id = ro.order_id
  where ro.order_id = p_order_id
    and ro.rider_id = (select auth.uid())
    and ro.status = 'offered'
    and ro.expires_at > now()
    and o.rider_id is null
    and o.payment_status = 'paid'
    and o.status in ('paid', 'searching')
  for update of ro;

  if offer_row.id is null then
    raise exception 'This delivery offer is no longer available';
  end if;

  update public.rider_offers
  set status = 'declined', responded_at = now(),
      decline_reason = nullif(left(trim(coalesce(p_reason, '')), 1000), '')
  where id = offer_row.id;

  insert into public.order_events(order_id, actor_id, event, note)
  values (
    p_order_id, (select auth.uid()), 'rider_declined',
    nullif(left(trim(coalesce(p_reason, '')), 1000), '')
  );

  perform public.dispatch_pending_orders();
end
$$;

create or replace function public.accept_order(p_order_id uuid)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  accepted_order public.orders;
  rider_vehicle text;
  offer_id uuid;
begin
  if public.current_user_role() <> 'rider' then
    raise exception 'Rider access required';
  end if;

  select r.vehicle_type into rider_vehicle
  from public.riders r
  join public.profiles rider_profile on rider_profile.id = r.id
  where r.id = (select auth.uid())
    and rider_profile.role = 'rider'
    and r.approval_status = 'approved'
    and r.is_online
  for update;

  if rider_vehicle is null then
    raise exception 'Approved rider must be online and have a registered vehicle type';
  end if;

  if exists (
    select 1 from public.orders o
    where o.rider_id = (select auth.uid())
      and o.status not in ('completed', 'cancelled')
  ) then
    raise exception 'Complete your current delivery before accepting another';
  end if;

  select ro.id into offer_id
  from public.rider_offers ro
  where ro.order_id = p_order_id
    and ro.rider_id = (select auth.uid())
    and ro.status = 'offered'
    and ro.expires_at > now()
  for update;

  if offer_id is null then
    raise exception 'This delivery offer expired or is no longer available';
  end if;

  update public.orders o
  set rider_id = (select auth.uid()), status = 'accepted', accepted_at = now()
  where o.id = p_order_id
    and o.status in ('paid', 'searching')
    and o.payment_status = 'paid'
    and o.rider_id is null
    and public.vehicle_compatible(rider_vehicle, o.vehicle_type)
  returning o.* into accepted_order;

  if accepted_order.id is null then
    raise exception 'Delivery is unavailable or requires a different vehicle';
  end if;

  update public.rider_offers
  set status = case when rider_id = (select auth.uid()) then 'accepted' else 'revoked' end,
      responded_at = now()
  where order_id = p_order_id and status = 'offered';

  insert into public.order_assignment_history(
    order_id, previous_rider_id, new_rider_id, actor_id, action, reason
  ) values (
    accepted_order.id, null, (select auth.uid()), (select auth.uid()),
    'assigned', 'Rider accepted an eligible delivery offer'
  );
  insert into public.order_events(order_id, actor_id, event, note)
  values (accepted_order.id, (select auth.uid()), 'rider_accepted', 'Rider accepted an eligible delivery offer');

  perform public.dispatch_pending_orders();
  return accepted_order;
end
$$;

create or replace function public.update_rider_presence(
  p_is_online boolean,
  p_lat double precision default null,
  p_lng double precision default null
)
returns public.riders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  rider_row public.riders;
begin
  if public.current_user_role() <> 'rider' then
    raise exception 'Rider access required';
  end if;

  if p_is_online and (
    p_lat is not null and p_lat not between -90 and 90
    or p_lng is not null and p_lng not between -180 and 180
  ) then
    raise exception 'Rider coordinates are invalid';
  end if;

  update public.riders
  set is_online = p_is_online,
      lat = p_lat,
      lng = p_lng,
      last_seen_at = now()
  where id = (select auth.uid())
    and (
      not p_is_online
      or (
        approval_status = 'approved'
        and public.vehicle_rank(vehicle_type) > 0
      )
    )
  returning * into rider_row;

  if rider_row.id is null then
    raise exception 'Only an approved rider with a registered vehicle can go online';
  end if;

  if not p_is_online then
    update public.rider_offers
    set status = 'revoked', responded_at = now()
    where rider_id = rider_row.id and status = 'offered';
  end if;

  perform public.dispatch_pending_orders();
  return rider_row;
end
$$;

create or replace function public.set_rider_approval_status(
  p_rider_id uuid,
  p_status text
)
returns public.riders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  rider_row public.riders;
begin
  if public.current_user_role() not in ('admin', 'supervisor') then
    raise exception 'Operations access required';
  end if;
  if p_status not in ('pending', 'approved', 'rejected', 'suspended') then
    raise exception 'Unsupported rider approval status';
  end if;

  update public.riders r
  set approval_status = p_status::public.rider_approval,
      is_online = case when p_status = 'approved' then is_online else false end
  where r.id = p_rider_id
    and exists (
      select 1 from public.profiles rider_profile
      where rider_profile.id = r.id and rider_profile.role = 'rider'
    )
  returning * into rider_row;
  if rider_row.id is null then
    raise exception 'Rider application not found';
  end if;

  if p_status <> 'approved' then
    update public.rider_offers
    set status = 'revoked', responded_at = now()
    where rider_id = p_rider_id and status = 'offered';
  end if;

  insert into public.order_events(order_id, actor_id, event, note)
  select o.id, (select auth.uid()), 'rider_status_changed',
         'Operations changed rider eligibility to ' || p_status
  from public.orders o
  where o.rider_id = p_rider_id and o.status not in ('completed', 'cancelled');

  insert into public.rider_admin_events(rider_id, actor_id, event, details)
  values (
    p_rider_id, (select auth.uid()), 'approval_status_changed',
    'Operations changed rider approval status to ' || p_status
  );

  perform public.dispatch_pending_orders();
  return rider_row;
end
$$;

create or replace function public.approve_rider(p_rider_id uuid, p_approved boolean)
returns public.riders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  rider_row public.riders;
begin
  if public.current_user_role() not in ('admin', 'supervisor') then
    raise exception 'Operations access required';
  end if;
  select * into rider_row
  from public.set_rider_approval_status(
    p_rider_id,
    case when p_approved then 'approved' else 'rejected' end
  );
  return rider_row;
end
$$;

create or replace function public.report_delivery_problem(p_order_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  order_status text;
begin
  if public.current_user_role() <> 'rider'
     or p_reason is null or length(trim(p_reason)) not between 3 and 1000 then
    raise exception 'Provide a rider account and a problem description of 3 to 1000 characters';
  end if;

  select o.status into order_status
  from public.orders o
  where o.id = p_order_id
    and o.rider_id = (select auth.uid())
    and o.status in ('accepted', 'picked_up', 'on_the_way', 'at_door')
  for update;
  if order_status is null then
    raise exception 'An active delivery assigned to you was not found';
  end if;

  insert into public.order_events(order_id, actor_id, event, note)
  values (
    p_order_id, (select auth.uid()), 'rider_problem_reported',
    'Reported at stage ' || order_status || ': ' || left(trim(p_reason), 1000)
  );
  perform public.add_dispatch_alert(
    p_order_id, 'rider_problem',
    'Rider reported a problem at stage ' || order_status || ': ' || left(trim(p_reason), 1000)
  );
  perform public.add_dispatch_alert(
    p_order_id, 'reassignment_required',
    'Operations must review the rider problem and confirm package custody before reassignment.'
  );
end
$$;

create or replace function public.admin_assign_order(
  p_order_id uuid,
  p_rider_id uuid,
  p_reason text
)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  result_order public.orders;
  rider_vehicle text;
begin
  if public.current_user_role() not in ('admin', 'supervisor') then
    raise exception 'Operations access required';
  end if;
  if p_reason is null or length(trim(p_reason)) not between 3 and 1000 then
    raise exception 'A manual assignment reason is required';
  end if;

  select r.vehicle_type into rider_vehicle
  from public.riders r
  join public.profiles rider_profile on rider_profile.id = r.id
  where r.id = p_rider_id
    and rider_profile.role = 'rider'
    and r.approval_status = 'approved'
    and r.is_online
  for update;
  if rider_vehicle is null then
    raise exception 'The selected rider must be approved and online';
  end if;
  if exists (
    select 1 from public.orders o
    where o.rider_id = p_rider_id and o.status not in ('completed', 'cancelled')
  ) then
    raise exception 'The selected rider already has an unfinished delivery';
  end if;
  if exists (
    select 1 from public.rider_offers ro
    where ro.order_id = p_order_id and ro.rider_id = p_rider_id
      and ro.status = 'declined'
  ) then
    raise exception 'The selected rider previously declined this delivery';
  end if;

  update public.orders o
  set rider_id = p_rider_id, status = 'accepted', accepted_at = now()
  where o.id = p_order_id
    and o.rider_id is null
    and o.status in ('paid', 'searching')
    and o.payment_status = 'paid'
    and public.vehicle_compatible(rider_vehicle, o.vehicle_type)
  returning o.* into result_order;
  if result_order.id is null then
    raise exception 'The paid order is unavailable or the rider vehicle is incompatible';
  end if;

  update public.rider_offers
  set status = case when rider_id = p_rider_id then 'accepted' else 'revoked' end,
      responded_at = now()
  where order_id = p_order_id and status = 'offered';

  insert into public.rider_offers(
    order_id, rider_id, status, offered_at, expires_at, responded_at
  ) values (
    p_order_id, p_rider_id, 'accepted', now(), now(), now()
  )
  on conflict (order_id, rider_id) do update
    set status = 'accepted', responded_at = now()
    where public.rider_offers.status <> 'declined';

  insert into public.order_assignment_history(
    order_id, previous_rider_id, new_rider_id, actor_id, action, reason
  ) values (
    p_order_id, null, p_rider_id, (select auth.uid()), 'assigned', left(trim(p_reason), 1000)
  );
  insert into public.order_events(order_id, actor_id, event, note)
  values (p_order_id, (select auth.uid()), 'admin_assigned_rider', left(trim(p_reason), 1000));
  perform public.dispatch_pending_orders();
  return result_order;
end
$$;

create or replace function public.return_order_to_rider_pool(
  p_order_id uuid,
  p_reason text,
  p_handover_confirmed boolean default false,
  p_handover_details text default null
)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  result_order public.orders;
  previous_rider uuid;
  old_status text;
  requires_handover boolean;
begin
  if public.current_user_role() not in ('admin', 'supervisor') then
    raise exception 'Operations access required';
  end if;
  if p_reason is null or length(trim(p_reason)) not between 3 and 1000 then
    raise exception 'A reassignment reason is required';
  end if;

  select o.rider_id, o.status into previous_rider, old_status
  from public.orders o
  where o.id = p_order_id and o.rider_id is not null
  for update;
  if previous_rider is null then
    raise exception 'The order has no current rider assignment';
  end if;
  if old_status not in ('accepted', 'picked_up', 'on_the_way', 'at_door') then
    raise exception 'Only an active assigned delivery can be returned to the rider pool';
  end if;
  if not exists (
    select 1 from public.orders o
    where o.id = p_order_id and o.payment_status = 'paid'
  ) then
    raise exception 'Only a paid delivery can return to the rider pool';
  end if;

  requires_handover := old_status in ('picked_up', 'on_the_way', 'at_door');
  if requires_handover and (
    not coalesce(p_handover_confirmed, false)
    or p_handover_details is null
    or length(trim(p_handover_details)) < 5
    or length(trim(p_handover_details)) > 2000
  ) then
    raise exception 'Confirm package custody and record recovery/handover arrangements before reassignment';
  end if;

  update public.orders
  set rider_id = null, status = 'paid', accepted_at = null, pickup_at = null,
      at_door_at = null, delivered_at = null
  where id = p_order_id
  returning * into result_order;

  update public.rider_offers
  set status = 'revoked', responded_at = now()
  where order_id = p_order_id and status = 'offered';

  insert into public.order_assignment_history(
    order_id, previous_rider_id, new_rider_id, actor_id, action, reason,
    handover_confirmed, handover_details
  ) values (
    p_order_id, previous_rider, null, (select auth.uid()), 'returned_to_pool',
    left(trim(p_reason), 1000), coalesce(p_handover_confirmed, false),
    nullif(left(trim(coalesce(p_handover_details, '')), 2000), '')
  );
  insert into public.order_events(order_id, actor_id, event, note)
  values (p_order_id, (select auth.uid()), 'admin_returned_to_pool', left(trim(p_reason), 1000));

  update public.dispatch_alerts
  set resolved_at = now(), resolved_by = (select auth.uid())
  where order_id = p_order_id and resolved_at is null;

  perform public.dispatch_pending_orders();
  return result_order;
end
$$;

create or replace function public.admin_cancel_order(
  p_order_id uuid,
  p_reason text,
  p_handover_confirmed boolean default false,
  p_handover_details text default null
)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  result_order public.orders;
  previous_rider uuid;
  old_status text;
  needs_handover boolean;
begin
  if public.current_user_role() not in ('admin', 'supervisor') then
    raise exception 'Operations access required';
  end if;
  if p_reason is null or length(trim(p_reason)) not between 3 and 1000 then
    raise exception 'A cancellation reason is required';
  end if;

  select rider_id, status into previous_rider, old_status
  from public.orders where id = p_order_id for update;
  if old_status is null or old_status in ('completed', 'cancelled') then
    raise exception 'The delivery cannot be cancelled';
  end if;
  needs_handover := old_status in ('picked_up', 'on_the_way', 'at_door');
  if needs_handover and (
    not coalesce(p_handover_confirmed, false)
    or p_handover_details is null
    or length(trim(p_handover_details)) < 5
    or length(trim(p_handover_details)) > 2000
  ) then
    raise exception 'Confirm package custody and record recovery arrangements before cancellation';
  end if;

  update public.orders set status = 'cancelled', rider_id = null
  where id = p_order_id returning * into result_order;
  update public.rider_offers
  set status = 'revoked', responded_at = now()
  where order_id = p_order_id and status = 'offered';

  insert into public.order_assignment_history(
    order_id, previous_rider_id, new_rider_id, actor_id, action, reason,
    handover_confirmed, handover_details
  ) values (
    p_order_id, previous_rider, null, (select auth.uid()), 'cancelled',
    left(trim(p_reason), 1000), coalesce(p_handover_confirmed, false),
    nullif(left(trim(coalesce(p_handover_details, '')), 2000), '')
  );
  insert into public.order_events(order_id, actor_id, event, note)
  values (p_order_id, (select auth.uid()), 'admin_cancelled', left(trim(p_reason), 1000));
  perform public.dispatch_pending_orders();
  return result_order;
end
$$;

create or replace function public.acknowledge_dispatch_alert(p_alert_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.current_user_role() not in ('admin', 'supervisor') then
    raise exception 'Operations access required';
  end if;
  update public.dispatch_alerts
  set acknowledged_at = now(), acknowledged_by = (select auth.uid())
  where id = p_alert_id and resolved_at is null;
  if not found then
    raise exception 'Open dispatch alert not found';
  end if;
end
$$;

create or replace function public.refresh_admin_dispatch_queue()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.current_user_role() not in ('admin', 'supervisor') then
    raise exception 'Operations access required';
  end if;
  return public.dispatch_pending_orders();
end
$$;

create or replace function public.get_delivery_contacts(p_order_id uuid)
returns table(
  customer_name text,
  customer_phone text,
  rider_name text,
  rider_phone text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  select cp.full_name, cp.phone, r.display_name, r.phone
  from public.orders o
  left join public.profiles cp on cp.id = o.customer_id
  left join public.riders r on r.id = o.rider_id
  where o.id = p_order_id
    and (
      o.customer_id = (select auth.uid())
      or o.rider_id = (select auth.uid())
      or public.current_user_role() in ('admin', 'supervisor')
    )
    and (
      o.rider_id is not null
      or public.current_user_role() in ('admin', 'supervisor')
    );
end
$$;

do $$
begin
  if exists (
    select 1
    from public.orders
    where rider_id is not null and status not in ('completed', 'cancelled')
    group by rider_id
    having count(*) > 1
  ) then
    raise exception 'Cannot enforce one active delivery per rider: resolve existing duplicate active assignments before applying migration 014';
  end if;
end
$$;

create unique index if not exists orders_one_active_delivery_per_rider_idx
  on public.orders(rider_id)
  where rider_id is not null and status not in ('completed', 'cancelled');

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'rider_offers', 'order_assignment_history', 'dispatch_alerts', 'rider_admin_events'
  ] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = table_name
    ) then
      execute format('alter publication supabase_realtime add table public.%I', table_name);
    end if;
  end loop;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'order_events'
  ) then
    alter publication supabase_realtime add table public.order_events;
  end if;
end
$$;

revoke execute on function public.vehicle_compatible(text, text) from public, anon;
revoke execute on function public.save_rider_document_path(text, text) from public, anon;
revoke execute on function public.add_dispatch_alert(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.dispatch_pending_orders() from public, anon;
revoke execute on function public.get_rider_available_orders() from public, anon;
revoke execute on function public.accept_order(uuid) from public, anon;
revoke execute on function public.decline_order(uuid, text) from public, anon;
revoke execute on function public.update_rider_presence(boolean, double precision, double precision) from public, anon;
revoke execute on function public.set_rider_approval_status(uuid, text) from public, anon;
revoke execute on function public.report_delivery_problem(uuid, text) from public, anon;
revoke execute on function public.admin_assign_order(uuid, uuid, text) from public, anon;
revoke execute on function public.return_order_to_rider_pool(uuid, text, boolean, text) from public, anon;
revoke execute on function public.admin_cancel_order(uuid, text, boolean, text) from public, anon;
revoke execute on function public.acknowledge_dispatch_alert(uuid) from public, anon;
revoke execute on function public.refresh_admin_dispatch_queue() from public, anon;
revoke execute on function public.get_delivery_contacts(uuid) from public, anon;

grant execute on function public.vehicle_compatible(text, text) to authenticated;
grant execute on function public.save_rider_document_path(text, text) to authenticated;
grant execute on function public.dispatch_pending_orders() to authenticated;
grant execute on function public.get_rider_available_orders() to authenticated;
grant execute on function public.accept_order(uuid) to authenticated;
grant execute on function public.decline_order(uuid, text) to authenticated;
grant execute on function public.update_rider_presence(boolean, double precision, double precision) to authenticated;
grant execute on function public.set_rider_approval_status(uuid, text) to authenticated;
grant execute on function public.report_delivery_problem(uuid, text) to authenticated;
grant execute on function public.admin_assign_order(uuid, uuid, text) to authenticated;
grant execute on function public.return_order_to_rider_pool(uuid, text, boolean, text) to authenticated;
grant execute on function public.admin_cancel_order(uuid, text, boolean, text) to authenticated;
grant execute on function public.acknowledge_dispatch_alert(uuid) to authenticated;
grant execute on function public.refresh_admin_dispatch_queue() to authenticated;
grant execute on function public.get_delivery_contacts(uuid) to authenticated;

notify pgrst, 'reload schema';