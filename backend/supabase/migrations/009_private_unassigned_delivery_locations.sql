-- Unassigned riders may review eligible jobs, but exact private addresses,
-- recipient details, and coordinates are returned only after assignment.
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

revoke execute on function public.get_rider_available_orders() from public, anon;
grant execute on function public.get_rider_available_orders() to authenticated;

-- Preserve RLS while making private order visibility an explicit customer,
-- assigned-rider, or operations-only rule.
alter table public.orders enable row level security;

drop policy if exists orders_select on public.orders;
create policy orders_select on public.orders
for select to authenticated
using (
  customer_id=(select auth.uid())
  or rider_id=(select auth.uid())
  or public.current_user_role() in ('admin','supervisor')
);

alter table public.riders enable row level security;
drop policy if exists riders_select on public.riders;
create policy riders_select on public.riders
for select to authenticated
using (
  id=(select auth.uid())
  or public.current_user_role() in ('admin','supervisor')
);
