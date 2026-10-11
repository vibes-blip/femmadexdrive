-- Preserve unpaid/price-review quote expiry. Paid deliveries do not expire from
-- the rider queue; offer acceptance remains atomic and fast service requires a
-- fresh, server-calculated route estimate to pickup.
--
-- Apply only after the validated 017_fast_delivery.sql schema is installed.

alter table public.rider_offers
  add column if not exists route_check_status text,
  add column if not exists pickup_eta_minutes integer,
  add column if not exists route_checked_at timestamptz;

do $$
declare
  definition text;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='rider_offers'
      and column_name='route_check_status' and data_type='text'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='rider_offers'
      and column_name='pickup_eta_minutes' and data_type='integer'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='rider_offers'
      and column_name='route_checked_at' and data_type='timestamp with time zone'
  ) then
    raise exception 'rider_offers route-check columns have incompatible definitions';
  end if;

  select pg_get_constraintdef(oid) into definition
  from pg_constraint
  where conrelid='public.rider_offers'::regclass
    and conname='rider_offers_route_check_status_valid';
  if definition is not null and (
    definition not ilike '%route_check_status%'
    or definition not ilike '%eligible%'
    or definition not ilike '%too_far%'
    or definition not ilike '%unavailable%'
  ) then
    raise exception 'rider_offers_route_check_status_valid exists with an incompatible definition';
  end if;
  if definition is null then
    alter table public.rider_offers
      add constraint rider_offers_route_check_status_valid
      check (
        route_check_status is null
        or route_check_status in ('eligible', 'too_far', 'unavailable')
      ) not valid;
    alter table public.rider_offers
      validate constraint rider_offers_route_check_status_valid;
  end if;

  select pg_get_constraintdef(oid) into definition
  from pg_constraint
  where conrelid='public.rider_offers'::regclass
    and conname='rider_offers_pickup_eta_nonnegative';
  if definition is not null and (
    definition not ilike '%pickup_eta_minutes%'
    or definition not ilike '%>= 0%'
  ) then
    raise exception 'rider_offers_pickup_eta_nonnegative exists with an incompatible definition';
  end if;
  if definition is null then
    alter table public.rider_offers
      add constraint rider_offers_pickup_eta_nonnegative
      check (pickup_eta_minutes is null or pickup_eta_minutes >= 0) not valid;
    alter table public.rider_offers
      validate constraint rider_offers_pickup_eta_nonnegative;
  end if;
end
$$;

create index if not exists rider_offers_fast_route_check_idx
  on public.rider_offers(order_id, route_check_status, route_checked_at)
  where status='offered';

-- Re-open legacy timed-out offers on the next dispatcher pass. A declined offer
-- remains declined for that rider; other compatible riders remain eligible.
update public.rider_offers
set expires_at='infinity'::timestamptz
where status='offered' and expires_at<>'infinity'::timestamptz;

do $$
declare
  alert_constraint record;
  alert_definition text;
begin
  select conname, pg_get_constraintdef(oid) as definition
  into alert_constraint
  from pg_constraint
  where conrelid='public.dispatch_alerts'::regclass
    and contype='c'
    and pg_get_constraintdef(oid) ilike '%alert_type%';
  if alert_constraint.conname is null then
    raise exception 'dispatch_alerts alert-type check constraint was not found';
  end if;

  alert_definition:=alert_constraint.definition;
  if alert_definition not ilike '%fast_pickup_unavailable%'
     or alert_definition not ilike '%pickup_deadline_missed%' then
    execute format('alter table public.dispatch_alerts drop constraint %I',alert_constraint.conname);
    alter table public.dispatch_alerts
      add constraint dispatch_alerts_alert_type_check
      check (alert_type in (
        'no_compatible_rider',
        'all_offers_exhausted',
        'unassigned_overdue',
        'rider_problem',
        'reassignment_required',
        'fast_pickup_unavailable',
        'pickup_deadline_missed'
      ));
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
  unassigned_minutes integer;
  created_count integer := 0;
  order_row record;
begin
  if (select auth.uid()) is not null
     and public.current_user_role() not in ('rider', 'admin', 'supervisor') then
    raise exception 'Dispatch access required';
  end if;

  select unassigned_alert_minutes
  into unassigned_minutes
  from public.dispatch_settings where id=true;

  update public.rider_offers ro
  set status='revoked', responded_at=clock_timestamp()
  from public.orders o, public.riders r
  where ro.order_id=o.id
    and ro.rider_id=r.id
    and ro.status='offered'
    and (
      o.rider_id is not null
      or o.payment_status<>'paid'
      or o.status not in ('paid','searching')
      or r.approval_status<>'approved'
      or not r.is_online
      or not exists (
        select 1 from public.profiles p
        where p.id=r.id and p.role='rider'
      )
      or not public.vehicle_compatible(r.vehicle_type,o.vehicle_type)
      or exists (
        select 1 from public.orders active_order
        where active_order.rider_id=r.id
          and active_order.status not in ('completed','cancelled')
      )
    );

  insert into public.rider_offers(order_id,rider_id,status,offered_at,expires_at)
  select o.id,r.id,'offered',clock_timestamp(),'infinity'::timestamptz
  from public.orders o
  cross join public.riders r
  where o.rider_id is null
    and o.payment_status='paid'
    and o.status in ('paid','searching')
    and r.approval_status='approved'
    and r.is_online
    and exists (
      select 1 from public.profiles p
      where p.id=r.id and p.role='rider'
    )
    and public.vehicle_compatible(r.vehicle_type,o.vehicle_type)
    and not exists (
      select 1 from public.orders active_order
      where active_order.rider_id=r.id
        and active_order.status not in ('completed','cancelled')
    )
    and not exists (
      select 1 from public.rider_offers previous
      where previous.order_id=o.id
        and previous.rider_id=r.id
        and previous.status in ('declined','accepted')
    )
  on conflict(order_id,rider_id) do update
    set status='offered',
        offered_at=excluded.offered_at,
        expires_at='infinity'::timestamptz,
        responded_at=null,
        decline_reason=null,
        route_check_status=null,
        pickup_eta_minutes=null,
        route_checked_at=null
    where public.rider_offers.status in ('revoked','timed_out');
  get diagnostics created_count=row_count;

  for order_row in
    select o.id,
      greatest(
        o.created_at,
        coalesce((
          select max(e.created_at) from public.order_events e
          where e.order_id=o.id
            and e.event in ('payment_confirmed','admin_returned_to_pool')
        ),o.created_at)
      ) as queue_started_at,
      exists (
        select 1 from public.riders r
        where r.approval_status='approved' and r.is_online
          and exists (
            select 1 from public.profiles p
            where p.id=r.id and p.role='rider'
          )
          and public.vehicle_compatible(r.vehicle_type,o.vehicle_type)
          and not exists (
            select 1 from public.orders active_order
            where active_order.rider_id=r.id
              and active_order.status not in ('completed','cancelled')
          )
      ) as has_eligible_rider,
      exists (
        select 1 from public.rider_offers ro
        where ro.order_id=o.id and ro.status='offered'
      ) as has_open_offer,
      exists (
        select 1 from public.rider_offers ro
        where ro.order_id=o.id and ro.status in ('declined','timed_out')
      ) as has_offer_history
    from public.orders o
    where o.rider_id is null
      and o.payment_status='paid'
      and o.status in ('paid','searching')
  loop
    if not order_row.has_eligible_rider then
      perform public.add_dispatch_alert(
        order_row.id,'no_compatible_rider',
        'No approved, online, compatible rider is currently available.'
      );
    elsif not order_row.has_open_offer and order_row.has_offer_history then
      perform public.add_dispatch_alert(
        order_row.id,'all_offers_exhausted',
        'All compatible riders declined this delivery; the paid order remains pending.'
      );
    end if;

    if order_row.queue_started_at<=clock_timestamp()-make_interval(mins=>unassigned_minutes) then
      perform public.add_dispatch_alert(
        order_row.id,'unassigned_overdue',
        'The paid delivery has remained unassigned beyond the configured dispatch threshold.'
      );
    end if;
  end loop;

  update public.dispatch_alerts a
  set resolved_at=clock_timestamp(),resolved_by=(select auth.uid())
  from public.orders o
  where a.order_id=o.id
    and a.resolved_at is null
    and a.alert_type in ('no_compatible_rider','all_offers_exhausted','unassigned_overdue')
    and (
      (o.rider_id is not null and a.alert_type in (
        'no_compatible_rider','all_offers_exhausted','unassigned_overdue'
      ))
      or o.status in ('completed','cancelled')
      or o.payment_status<>'paid'
    );

  return coalesce(created_count,0);
end
$$;

revoke execute on function public.dispatch_pending_orders() from public,anon;
grant execute on function public.dispatch_pending_orders() to authenticated,service_role;

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
  fast_eta integer;
  fast_route_status text;
  fast_route_checked_at timestamptz;
  max_pickup_minutes integer;
  accepted_at_value timestamptz:=clock_timestamp();
begin
  if public.current_user_role()<>'rider' then
    raise exception 'Rider access required';
  end if;

  select r.vehicle_type into rider_vehicle
  from public.riders r
  join public.profiles p on p.id=r.id
  where r.id=(select auth.uid())
    and p.role='rider'
    and r.approval_status='approved'
    and r.is_online
  for update;
  if rider_vehicle is null then
    raise exception 'Approved rider must be online and have a registered vehicle type';
  end if;

  if exists (
    select 1 from public.orders o
    where o.rider_id=(select auth.uid())
      and o.status not in ('completed','cancelled')
  ) then
    raise exception 'Complete your current delivery before accepting another';
  end if;

  select ro.id,ro.pickup_eta_minutes,ro.route_check_status,ro.route_checked_at
  into offer_id,fast_eta,fast_route_status,fast_route_checked_at
  from public.rider_offers ro
  where ro.order_id=p_order_id
    and ro.rider_id=(select auth.uid())
    and ro.status='offered'
    and ro.expires_at>accepted_at_value
  for update;
  if offer_id is null then
    raise exception 'This delivery offer is no longer available';
  end if;

  if exists (
    select 1 from public.orders o
    where o.id=p_order_id and o.delivery_speed='fast'
  ) then
    select pickup_deadline_minutes into max_pickup_minutes
    from public.delivery_service_rules where delivery_speed='fast';
    if fast_route_status<>'eligible'
       or fast_eta is null
       or max_pickup_minutes is null
       or fast_eta>max_pickup_minutes
       or fast_route_checked_at is null
       or fast_route_checked_at<accepted_at_value-interval '2 minutes'
       or fast_route_checked_at>accepted_at_value+interval '30 seconds' then
      raise exception 'A current eligible route estimate to pickup is required for fast delivery';
    end if;
  end if;

  update public.orders o
  set rider_id=(select auth.uid()),
      status='accepted',
      accepted_at=accepted_at_value,
      pickup_deadline_at=accepted_at_value+make_interval(
        mins=>(select rules.pickup_deadline_minutes
               from public.delivery_service_rules rules
               where rules.delivery_speed=o.delivery_speed)
      )
  where o.id=p_order_id
    and o.status in ('paid','searching')
    and o.payment_status='paid'
    and o.rider_id is null
    and public.vehicle_compatible(rider_vehicle,o.vehicle_type)
  returning o.* into accepted_order;
  if accepted_order.id is null then
    raise exception 'Delivery is unavailable or requires a different vehicle';
  end if;

  update public.rider_offers
  set status=case when rider_id=(select auth.uid()) then 'accepted' else 'revoked' end,
      responded_at=accepted_at_value
  where order_id=p_order_id and status='offered';

  insert into public.order_assignment_history(
    order_id,previous_rider_id,new_rider_id,actor_id,action,reason
  ) values (
    accepted_order.id,null,(select auth.uid()),(select auth.uid()),
    'assigned','Rider accepted an eligible delivery offer'
  );
  insert into public.order_events(order_id,actor_id,event,note)
  values (
    accepted_order.id,(select auth.uid()),'rider_accepted',
    case when accepted_order.delivery_speed='fast'
      then 'Rider accepted a fast delivery; configured pickup-arrival deadline started'
      else 'Rider accepted an eligible delivery offer'
    end
  );

  perform public.dispatch_pending_orders();
  return accepted_order;
end
$$;

revoke execute on function public.accept_order(uuid) from public,anon;
grant execute on function public.accept_order(uuid) to authenticated;

create or replace function public.admin_assign_order(
  p_order_id uuid,
  p_rider_id uuid,
  p_reason text
)
returns public.orders
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  result_order public.orders;
  rider_vehicle text;
  route_status text;
  pickup_eta integer;
  route_checked timestamptz;
  max_pickup_minutes integer;
  assignment_time timestamptz:=clock_timestamp();
begin
  if public.current_user_role() not in ('admin','supervisor') then
    raise exception 'Operations access required';
  end if;
  if p_reason is null or length(trim(p_reason)) not between 3 and 1000 then
    raise exception 'A manual assignment reason is required';
  end if;

  select r.vehicle_type into rider_vehicle
  from public.riders r
  join public.profiles p on p.id=r.id
  where r.id=p_rider_id and p.role='rider'
    and r.approval_status='approved' and r.is_online
  for update;
  if rider_vehicle is null then
    raise exception 'The selected rider must be approved and online';
  end if;
  if exists (
    select 1 from public.orders o
    where o.rider_id=p_rider_id and o.status not in ('completed','cancelled')
  ) then
    raise exception 'The selected rider already has an unfinished delivery';
  end if;
  if exists (
    select 1 from public.rider_offers ro
    where ro.order_id=p_order_id and ro.rider_id=p_rider_id
      and ro.status='declined'
  ) then
    raise exception 'The selected rider previously declined this delivery';
  end if;
  if exists (
    select 1 from public.orders o
    where o.id=p_order_id and o.delivery_speed='fast'
  ) then
    select ro.route_check_status,ro.pickup_eta_minutes,ro.route_checked_at
    into route_status,pickup_eta,route_checked
    from public.rider_offers ro
    where ro.order_id=p_order_id and ro.rider_id=p_rider_id
      and ro.status='offered'
    for update;
    select pickup_deadline_minutes into max_pickup_minutes
    from public.delivery_service_rules where delivery_speed='fast';
    if route_status<>'eligible' or pickup_eta is null
       or max_pickup_minutes is null or pickup_eta>max_pickup_minutes
       or route_checked is null
       or route_checked<assignment_time-interval '2 minutes'
       or route_checked>assignment_time+interval '30 seconds' then
      raise exception 'A current eligible route estimate to pickup is required for fast delivery';
    end if;
  end if;

  update public.orders o
  set rider_id=p_rider_id,
      status='accepted',
      accepted_at=assignment_time,
      pickup_deadline_at=assignment_time+make_interval(
        mins=>(select rules.pickup_deadline_minutes
               from public.delivery_service_rules rules
               where rules.delivery_speed=o.delivery_speed)
      )
  where o.id=p_order_id
    and o.rider_id is null
    and o.status in ('paid','searching')
    and o.payment_status='paid'
    and public.vehicle_compatible(rider_vehicle,o.vehicle_type)
  returning o.* into result_order;
  if result_order.id is null then
    raise exception 'The paid order is unavailable or the rider vehicle is incompatible';
  end if;

  update public.rider_offers
  set status=case when rider_id=p_rider_id then 'accepted' else 'revoked' end,
      responded_at=assignment_time
  where order_id=p_order_id and status='offered';
  insert into public.rider_offers(
    order_id,rider_id,status,offered_at,expires_at,responded_at
  ) values (
    p_order_id,p_rider_id,'accepted',assignment_time,assignment_time,assignment_time
  )
  on conflict(order_id,rider_id) do update
    set status='accepted',responded_at=assignment_time
    where public.rider_offers.status<>'declined';

  insert into public.order_assignment_history(
    order_id,previous_rider_id,new_rider_id,actor_id,action,reason
  ) values (
    p_order_id,null,p_rider_id,(select auth.uid()),'assigned',left(trim(p_reason),1000)
  );
  insert into public.order_events(order_id,actor_id,event,note)
  values (
    p_order_id,(select auth.uid()),'admin_assigned_rider',left(trim(p_reason),1000)
  );
  perform public.dispatch_pending_orders();
  return result_order;
end
$$;

revoke execute on function public.admin_assign_order(uuid,uuid,text) from public,anon;
grant execute on function public.admin_assign_order(uuid,uuid,text) to authenticated;

create or replace function public.refresh_fast_delivery_alerts()
returns integer
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  order_row record;
  created_count integer:=0;
begin
  if auth.role()<>'service_role' then
    raise exception 'Service role access required';
  end if;

  for order_row in
    select o.id,o.tracking_number,o.pickup_deadline_at,o.pickup_at,o.status
    from public.orders o
    where o.delivery_speed='fast'
      and o.rider_id is not null
      and o.pickup_deadline_at is not null
      and (
        (o.status='accepted' and o.pickup_deadline_at<=clock_timestamp())
        or (o.pickup_at is not null and o.pickup_at>o.pickup_deadline_at)
      )
      and not exists (
        select 1 from public.order_events e
        where e.order_id=o.id and e.event='pickup_deadline_missed'
      )
    for update of o skip locked
  loop
    insert into public.order_events(order_id,actor_id,event,note)
    values (
      order_row.id,null,'pickup_deadline_missed',
      'Fast delivery pickup-arrival deadline passed. Delivery remains active; operations review is required.'
    );
    insert into public.dispatch_alerts(order_id,alert_type,details)
    values (
      order_row.id,'pickup_deadline_missed',
      'The fast-service pickup-arrival deadline passed before collection. The delivery remains active and may continue; contact the rider/customer and review the delay.'
    )
    on conflict(order_id,alert_type) where resolved_at is null do nothing;
    created_count:=created_count+1;
  end loop;
  return created_count;
end
$$;

revoke all on function public.refresh_fast_delivery_alerts() from public,anon,authenticated;
grant execute on function public.refresh_fast_delivery_alerts() to service_role;
