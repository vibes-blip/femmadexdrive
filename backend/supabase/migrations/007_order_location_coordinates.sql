-- Persist the exact reverse-geocoded pickup and dropoff points used for routing.
alter table public.orders
  add column if not exists pickup_latitude double precision,
  add column if not exists pickup_longitude double precision,
  add column if not exists dropoff_latitude double precision,
  add column if not exists dropoff_longitude double precision;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid='public.orders'::regclass and conname='orders_pickup_coordinates_pair') then
    alter table public.orders add constraint orders_pickup_coordinates_pair
      check ((pickup_latitude is null)=(pickup_longitude is null));
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.orders'::regclass and conname='orders_dropoff_coordinates_pair') then
    alter table public.orders add constraint orders_dropoff_coordinates_pair
      check ((dropoff_latitude is null)=(dropoff_longitude is null));
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.orders'::regclass and conname='orders_pickup_latitude_range') then
    alter table public.orders add constraint orders_pickup_latitude_range
      check (pickup_latitude is null or pickup_latitude between -90 and 90);
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.orders'::regclass and conname='orders_pickup_longitude_range') then
    alter table public.orders add constraint orders_pickup_longitude_range
      check (pickup_longitude is null or pickup_longitude between -180 and 180);
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.orders'::regclass and conname='orders_dropoff_latitude_range') then
    alter table public.orders add constraint orders_dropoff_latitude_range
      check (dropoff_latitude is null or dropoff_latitude between -90 and 90);
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.orders'::regclass and conname='orders_dropoff_longitude_range') then
    alter table public.orders add constraint orders_dropoff_longitude_range
      check (dropoff_longitude is null or dropoff_longitude between -180 and 180);
  end if;
end
$$;

-- Riders use this filtered RPC for available work, so include the map points.
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
  goods_description text,
  weight_kg numeric,
  length_cm numeric,
  width_cm numeric,
  height_cm numeric,
  package_size text,
  vehicle_type text,
  distance_km numeric,
  duration_minutes integer,
  status text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path=public
as $$
begin
  if not exists (
    select 1 from public.riders r
    where r.id=auth.uid() and r.approval_status='approved' and r.is_online=true
  ) then
    return;
  end if;

  return query
  select o.id,o.tracking_number,o.pickup_address,o.pickup_latitude,o.pickup_longitude,
         o.dropoff_address,o.dropoff_latitude,o.dropoff_longitude,o.goods_description,
         o.weight_kg,o.length_cm,o.width_cm,o.height_cm,o.package_size,o.vehicle_type,
         o.distance_km,o.duration_minutes,o.status,o.created_at
  from public.orders o
  join public.riders r on r.id=auth.uid()
  where o.status='paid'
    and o.rider_id is null
    and public.vehicle_rank(r.vehicle_type) >= public.vehicle_rank(o.vehicle_type)
  order by o.created_at asc
  limit 100;
end
$$;

revoke execute on function public.get_rider_available_orders() from public;
grant execute on function public.get_rider_available_orders() to authenticated;
