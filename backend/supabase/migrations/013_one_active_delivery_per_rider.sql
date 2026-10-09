-- A rider may accept one active delivery at a time.
-- Only approved, paid, compatible deliveries remain visible in the feed.
create or replace function public.get_rider_available_orders()
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
  created_at timestamptz
)
language plpgsql
security definer
set search_path=public
as $$
begin
  if not exists (
    select 1
    from public.riders r
    where r.id=(select auth.uid())
      and r.approval_status='approved'
      and r.is_online=true
  ) then
    return;
  end if;

  if exists (
    select 1
    from public.orders o
    where o.rider_id=(select auth.uid())
      and o.status not in ('completed','cancelled')
  ) then
    return;
  end if;

  return query
  select o.id,o.tracking_number,
         null::text,null::double precision,null::double precision,
         null::text,null::double precision,null::double precision,
         null::text,null::text,
         o.goods_description,o.weight_kg,o.length_cm,o.width_cm,o.height_cm,
         o.package_size,o.vehicle_type,o.distance_km,o.duration_minutes,
         o.final_price,o.status,o.created_at
  from public.orders o
  join public.riders r on r.id=(select auth.uid())
  where o.status='paid'
    and o.rider_id is null
    and public.vehicle_rank(r.vehicle_type) >= public.vehicle_rank(o.vehicle_type)
    and not exists (
      select 1 from public.order_events e
      where e.order_id=o.id
        and e.actor_id=(select auth.uid())
        and e.event='rider_declined'
    )
  order by o.created_at asc
  limit 100;
end
$$;

create or replace function public.accept_order(p_order_id uuid)
returns public.orders
language plpgsql
security definer
set search_path=public
as $$
declare
  accepted_order public.orders;
  rider_vehicle text;
begin
  select r.vehicle_type into rider_vehicle
  from public.riders r
  where r.id=(select auth.uid())
    and r.approval_status='approved'
    and r.is_online=true
  for update;

  if rider_vehicle is null then
    raise exception 'Approved rider must be online and have a registered vehicle type';
  end if;

  if exists (
    select 1
    from public.orders o
    where o.rider_id=(select auth.uid())
      and o.status not in ('completed','cancelled')
  ) then
    raise exception 'Complete your current delivery before accepting another';
  end if;

  update public.orders o
  set rider_id=(select auth.uid()),
      status='accepted',
      accepted_at=now()
  where o.id=p_order_id
    and o.status='paid'
    and o.rider_id is null
    and public.vehicle_rank(rider_vehicle) >= public.vehicle_rank(o.vehicle_type)
  returning o.* into accepted_order;

  if accepted_order.id is null then
    raise exception 'Delivery is unavailable or requires a different vehicle';
  end if;

  insert into public.order_events(order_id,actor_id,event,note)
  values(accepted_order.id,(select auth.uid()),'rider_accepted','Rider accepted a compatible delivery');

  return accepted_order;
end
$$;

revoke execute on function public.get_rider_available_orders() from public, anon;
revoke execute on function public.accept_order(uuid) from public, anon;
grant execute on function public.get_rider_available_orders() to authenticated;
grant execute on function public.accept_order(uuid) to authenticated;

notify pgrst, 'reload schema';
