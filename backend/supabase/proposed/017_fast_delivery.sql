-- PROPOSAL ONLY: do not apply until reviewed and approved.
-- Depends on migrations 001 through 015. Adds a distinct fast-service choice,
-- preserves the existing standard quote, and sets a configured pickup deadline
-- from the trusted acceptance timestamp. Proposal only; staging validation is
-- required before any deployment.

alter table public.orders
  add column if not exists delivery_speed text not null default 'standard',
  add column if not exists pickup_deadline_at timestamptz;

do $$
declare
  speed_type text;
  speed_default text;
  deadline_type text;
begin
  select data_type, column_default
  into speed_type, speed_default
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'orders'
    and column_name = 'delivery_speed';

  select data_type
  into deadline_type
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'orders'
    and column_name = 'pickup_deadline_at';

  if speed_type is distinct from 'text'
     or speed_default not like '%standard%'
     or deadline_type is distinct from 'timestamp with time zone' then
    raise exception 'orders delivery timing columns do not match the expected text/timestamptz definitions';
  end if;

  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_delivery_speed_valid'
      and (
        contype <> 'c'
        or pg_get_constraintdef(oid) not ilike '%standard%'
        or pg_get_constraintdef(oid) not ilike '%fast%'
        or pg_get_constraintdef(oid) not ilike '%delivery_speed%'
      )
  ) then
    raise exception 'orders_delivery_speed_valid exists with an incompatible definition';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_delivery_speed_valid'
  ) then
    alter table public.orders
      add constraint orders_delivery_speed_valid
      check (delivery_speed in ('standard', 'fast')) not valid;
    alter table public.orders
      validate constraint orders_delivery_speed_valid;
  end if;

  if exists (
    select 1
    from public.orders
    where delivery_speed = 'fast'
      and coalesce(package_category, 'medium') = 'bulky'
  ) then
    raise exception 'Existing fast bulky orders require manual review before installing fast-delivery validation';
  end if;
end
$$;

create table if not exists public.delivery_service_rules (
  delivery_speed text primary key check (delivery_speed in ('standard', 'fast')),
  pickup_deadline_minutes integer not null check (pickup_deadline_minutes between 1 and 1440),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'delivery_service_rules'
      and column_name = 'delivery_speed' and data_type = 'text'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'delivery_service_rules'
      and column_name = 'pickup_deadline_minutes' and data_type = 'integer'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'delivery_service_rules'
      and column_name = 'updated_at' and data_type = 'timestamp with time zone'
  ) then
    raise exception 'delivery_service_rules exists with an incompatible schema';
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.delivery_service_rules'::regclass
      and contype = 'p'
      and pg_get_constraintdef(oid) = 'PRIMARY KEY (delivery_speed)'
  ) or not exists (
    select 1 from pg_constraint
    where conrelid = 'public.delivery_service_rules'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%delivery_speed%'
      and pg_get_constraintdef(oid) ilike '%standard%'
      and pg_get_constraintdef(oid) ilike '%fast%'
  ) or not exists (
    select 1 from pg_constraint
    where conrelid = 'public.delivery_service_rules'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%pickup_deadline_minutes%'
      and pg_get_constraintdef(oid) ilike '%1440%'
      and pg_get_constraintdef(oid) ilike '%1%'
  ) then
    raise exception 'delivery_service_rules is missing compatible key or value constraints';
  end if;
end
$$;

insert into public.delivery_service_rules(delivery_speed, pickup_deadline_minutes)
values ('standard', 180), ('fast', 120)
on conflict (delivery_speed) do nothing;

alter table public.delivery_service_rules enable row level security;
revoke all on public.delivery_service_rules from public, anon, authenticated;
grant select, update on public.delivery_service_rules to authenticated;
drop policy if exists delivery_service_rules_admin_read on public.delivery_service_rules;
create policy delivery_service_rules_admin_read on public.delivery_service_rules
  for select to authenticated
  using (public.current_user_role() in ('admin', 'supervisor'));
drop policy if exists delivery_service_rules_admin_update on public.delivery_service_rules;
create policy delivery_service_rules_admin_update on public.delivery_service_rules
  for update to authenticated
  using (public.current_user_role() in ('admin', 'supervisor'))
  with check (public.current_user_role() in ('admin', 'supervisor'));

create or replace function public.create_delivery_quote_with_options(
  p_customer_id uuid,
  p_pickup_address text,
  p_pickup_latitude double precision,
  p_pickup_longitude double precision,
  p_dropoff_address text,
  p_dropoff_latitude double precision,
  p_dropoff_longitude double precision,
  p_recipient_name text,
  p_recipient_phone text,
  p_goods_description text,
  p_weight_kg numeric,
  p_length_cm numeric,
  p_width_cm numeric,
  p_height_cm numeric,
  p_package_size text,
  p_package_category text,
  p_vehicle_type text,
  p_distance_meters numeric,
  p_duration_seconds numeric,
  p_suggested_price numeric,
  p_requires_manual_review boolean,
  p_delivery_speed text
)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  order_row public.orders;
begin
  if p_delivery_speed not in ('standard', 'fast') then
    raise exception 'Select a valid delivery speed';
  end if;
  if p_delivery_speed = 'fast' and p_package_category not in ('small', 'medium') then
    raise exception 'Fast delivery is available for small and medium packages only';
  end if;

  order_row := public.create_delivery_quote_with_category(
    p_customer_id,
    p_pickup_address,
    p_pickup_latitude,
    p_pickup_longitude,
    p_dropoff_address,
    p_dropoff_latitude,
    p_dropoff_longitude,
    p_recipient_name,
    p_recipient_phone,
    p_goods_description,
    p_weight_kg,
    p_length_cm,
    p_width_cm,
    p_height_cm,
    p_package_size,
    p_package_category,
    p_vehicle_type,
    p_distance_meters,
    p_duration_seconds,
    p_suggested_price,
    p_requires_manual_review
  );

  update public.orders
  set delivery_speed = p_delivery_speed
  where id = order_row.id
  returning * into order_row;

  return order_row;
end
$$;

revoke all on function public.create_delivery_quote_with_options(
  uuid, text, double precision, double precision, text, double precision,
  double precision, text, text, text, numeric, numeric, numeric, numeric,
  text, text, text, numeric, numeric, numeric, boolean, text
) from public, anon, authenticated;
grant execute on function public.create_delivery_quote_with_options(
  uuid, text, double precision, double precision, text, double precision,
  double precision, text, text, text, numeric, numeric, numeric, numeric,
  text, text, text, numeric, numeric, numeric, boolean, text
) to service_role;

-- The RPC result adds two fields. Drop/recreate because PostgreSQL does not
-- allow CREATE OR REPLACE to change a table-returning function's row type.
drop function public.get_rider_available_orders();
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
  offer_expires_at timestamptz,
  package_category text,
  delivery_speed text,
  pickup_deadline_at timestamptz
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
         null::text, null::double precision, null::double precision,
         null::text, null::double precision, null::double precision,
         null::text, null::text,
         o.goods_description, o.weight_kg, o.length_cm, o.width_cm, o.height_cm,
         o.package_size, o.vehicle_type, o.distance_km, o.duration_minutes,
         o.final_price, o.status, o.created_at, offer.expires_at,
         coalesce(
           o.package_category,
           case when o.package_size in ('large', 'very_large') then 'bulky'
                when o.package_size = 'small' then 'small'
                else 'medium'
           end
         ),
         o.delivery_speed, o.pickup_deadline_at
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
  order by case when o.delivery_speed = 'fast' then 0 else 1 end,
           o.created_at asc
  limit 100;
end
$$;

revoke execute on function public.get_rider_available_orders() from public, anon;
grant execute on function public.get_rider_available_orders() to authenticated;

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
  accepted_at_value timestamptz := clock_timestamp();
  pickup_deadline_minutes_value integer;
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
    and ro.expires_at > accepted_at_value
  for update;

  if offer_id is null then
    raise exception 'This delivery offer expired or is no longer available';
  end if;

  select rules.pickup_deadline_minutes
  into pickup_deadline_minutes_value
  from public.orders o
  join public.delivery_service_rules rules on rules.delivery_speed = o.delivery_speed
  where o.id = p_order_id;
  if pickup_deadline_minutes_value is null then
    raise exception 'Pickup timing rules are not configured for this delivery';
  end if;

  update public.orders o
  set rider_id = (select auth.uid()),
      status = 'accepted',
      accepted_at = accepted_at_value,
      pickup_deadline_at = accepted_at_value
        + make_interval(mins => pickup_deadline_minutes_value)
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
      responded_at = accepted_at_value
  where order_id = p_order_id and status = 'offered';

  insert into public.order_assignment_history(
    order_id, previous_rider_id, new_rider_id, actor_id, action, reason
  ) values (
    accepted_order.id, null, (select auth.uid()), (select auth.uid()),
    'assigned', 'Rider accepted an eligible delivery offer'
  );
  insert into public.order_events(order_id, actor_id, event, note)
  values (
    accepted_order.id,
    (select auth.uid()),
    'rider_accepted',
    case when accepted_order.delivery_speed = 'fast'
      then 'Rider accepted a fast delivery; configured pickup-arrival deadline started'
      else 'Rider accepted an eligible delivery offer'
    end
  );

  perform public.dispatch_pending_orders();
  return accepted_order;
end
$$;

revoke execute on function public.accept_order(uuid) from public, anon;
grant execute on function public.accept_order(uuid) to authenticated;

create or replace function public.update_assigned_rider_location(
  p_lat double precision,
  p_lng double precision
)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  location_updated_at timestamptz;
begin
  if public.current_user_role() <> 'rider' then
    raise exception 'Rider access required';
  end if;
  if p_lat is null or p_lat not between -90 and 90
     or p_lng is null or p_lng not between -180 and 180 then
    raise exception 'Rider coordinates are invalid';
  end if;
  if not exists (
    select 1 from public.riders r
    where r.id = (select auth.uid())
      and r.approval_status = 'approved'
  ) then
    raise exception 'Approved rider access required';
  end if;
  if not exists (
    select 1 from public.orders o
    where o.rider_id = (select auth.uid())
      and o.status in ('accepted', 'picked_up', 'on_the_way', 'at_door')
  ) then
    raise exception 'A current active delivery assignment is required';
  end if;

  update public.riders
  set lat = p_lat,
      lng = p_lng,
      last_seen_at = clock_timestamp()
  where id = (select auth.uid())
    and approval_status = 'approved'
  returning last_seen_at into location_updated_at;

  return location_updated_at;
end
$$;

revoke all on function public.update_assigned_rider_location(double precision, double precision) from public, anon;
grant execute on function public.update_assigned_rider_location(double precision, double precision) to authenticated;
