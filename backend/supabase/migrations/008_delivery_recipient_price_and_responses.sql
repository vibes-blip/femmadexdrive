alter table public.orders
  add column if not exists recipient_name text,
  add column if not exists recipient_phone text;

update public.orders o
set recipient_name = p.full_name
from public.profiles p
where p.id = o.customer_id
  and o.recipient_name is null;

create index if not exists order_events_rider_declines_idx
  on public.order_events(order_id, actor_id, event);

create or replace function public.set_order_price(p_order_id uuid, p_price numeric)
returns public.orders
language plpgsql
security definer
set search_path=public
as $$
declare r public.orders;
begin
  if public.current_user_role() not in ('admin','supervisor') then
    raise exception 'Operations access required';
  end if;
  if p_price is null or p_price <= 0 then
    raise exception 'Price must be positive';
  end if;

  update public.orders
  set final_price=p_price,
      status=case when payment_status='paid' then status else 'awaiting_payment' end
  where id=p_order_id
    and payment_status in ('unpaid','failed')
    and status in ('price_review','awaiting_payment')
  returning * into r;

  if r.id is null then
    raise exception 'Delivery price cannot be changed after payment or dispatch';
  end if;

  insert into public.order_events(order_id,actor_id,event,note)
  values(r.id,auth.uid(),'price_changed','Operations updated final price');
  return r;
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
         o.dropoff_address,o.dropoff_latitude,o.dropoff_longitude,o.recipient_name,
         o.recipient_phone,o.goods_description,o.weight_kg,o.length_cm,o.width_cm,
         o.height_cm,o.package_size,o.vehicle_type,o.distance_km,o.duration_minutes,
         o.final_price,o.status,o.created_at
  from public.orders o
  join public.riders r on r.id=auth.uid()
  where o.status='paid'
    and o.rider_id is null
    and public.vehicle_rank(r.vehicle_type) >= public.vehicle_rank(o.vehicle_type)
    and not exists (
      select 1 from public.order_events e
      where e.order_id=o.id
        and e.actor_id=auth.uid()
        and e.event='rider_declined'
    )
  order by o.created_at asc
  limit 100;
end
$$;

create or replace function public.decline_order(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path=public
as $$
declare rider_vehicle text;
begin
  select vehicle_type into rider_vehicle
  from public.riders
  where id=auth.uid() and approval_status='approved' and is_online=true;
  if rider_vehicle is null then
    raise exception 'Approved rider must be online';
  end if;

  perform 1 from public.orders o
  where o.id=p_order_id
    and o.status='paid'
    and o.rider_id is null
    and public.vehicle_rank(rider_vehicle) >= public.vehicle_rank(o.vehicle_type)
  for update;
  if not found then
    raise exception 'Delivery is no longer available or requires a different vehicle';
  end if;

  if not exists (
    select 1 from public.order_events e
    where e.order_id=p_order_id and e.actor_id=auth.uid() and e.event='rider_declined'
  ) then
    insert into public.order_events(order_id,actor_id,event,note)
    values(p_order_id,auth.uid(),'rider_declined','Rider declined this delivery');
  end if;
end
$$;

revoke execute on function public.get_rider_available_orders() from public;
revoke execute on function public.decline_order(uuid) from public;
grant execute on function public.get_rider_available_orders() to authenticated;
grant execute on function public.decline_order(uuid) to authenticated;
