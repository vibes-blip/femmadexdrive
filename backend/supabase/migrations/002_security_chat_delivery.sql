-- FEMADEXDRIVE production hardening: least-privilege rider access,
-- realtime chat safeguards, vehicle matching, and five-minute auto-completion.

create or replace function public.vehicle_rank(v text) returns integer
language sql immutable as $$
  select case lower(coalesce(v,''))
    when 'motorcycle' then 1
    when 'car' then 2
    when 'van' then 3
    when 'lorry' then 4
    else 0
  end
$$;

-- Riders receive only jobs they can physically handle and only when online/approved.
create or replace function public.get_rider_available_orders()
returns table(
  id uuid,
  tracking_number text,
  pickup_address text,
  dropoff_address text,
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
  select o.id,o.tracking_number,o.pickup_address,o.dropoff_address,o.goods_description,
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

-- Atomic acceptance also enforces vehicle compatibility server-side.
create or replace function public.accept_order(p_order_id uuid)
returns public.orders
language plpgsql
security definer
set search_path=public
as $$
declare r public.orders; rider_vehicle text;
begin
 select vehicle_type into rider_vehicle
 from public.riders
 where id=auth.uid() and approval_status='approved' and is_online=true;
 if rider_vehicle is null then raise exception 'Approved rider must be online'; end if;

 update public.orders o
 set rider_id=auth.uid(),status='accepted',accepted_at=now()
 where o.id=p_order_id
   and o.status='paid'
   and o.rider_id is null
   and public.vehicle_rank(rider_vehicle) >= public.vehicle_rank(o.vehicle_type)
 returning o.* into r;

 if r.id is null then raise exception 'Delivery is unavailable or requires a different vehicle'; end if;
 insert into public.order_events(order_id,actor_id,event,note)
 values(r.id,auth.uid(),'rider_accepted','Rider accepted a compatible delivery');
 return r;
end
$$;

-- Rider/customer chat is allowed only while a rider is assigned and the order is active.
drop policy if exists chat_insert on public.chat_messages;
create policy chat_insert on public.chat_messages
for insert to authenticated
with check (
  sender_id=auth.uid()
  and exists(
    select 1 from public.orders o
    where o.id=order_id
      and o.rider_id is not null
      and (o.customer_id=auth.uid() or o.rider_id=auth.uid())
      and o.status not in ('completed','cancelled')
  )
  and char_length(trim(body)) between 1 and 2000
);

-- Do not expose every paid order directly to riders; they use the filtered RPC above.
drop policy if exists orders_select on public.orders;
create policy orders_select on public.orders
for select to authenticated
using (
  customer_id=auth.uid()
  or rider_id=auth.uid()
  or public.current_user_role() in ('admin','supervisor')
);

-- Five-minute automatic completion is performed server-side by a scheduled Netlify function.
create or replace function public.auto_complete_deliveries()
returns integer
language plpgsql
security definer
set search_path=public
as $$
declare changed integer;
begin
  update public.orders
  set status='completed', completed_at=now()
  where status='delivered'
    and delivered_at is not null
    and delivered_at <= now() - interval '5 minutes';
  get diagnostics changed = row_count;

  insert into public.order_events(order_id,actor_id,event,note)
  select o.id,null,'auto_completed','Automatically completed after five-minute customer confirmation window'
  from public.orders o
  where o.status='completed'
    and o.completed_at >= now() - interval '1 minute'
    and o.delivered_at is not null
    and o.delivered_at <= now() - interval '5 minutes'
    and not exists (
      select 1 from public.order_events e
      where e.order_id=o.id and e.event='auto_completed'
        and e.created_at >= now() - interval '2 minutes'
    );
  return changed;
end
$$;

-- Contact information is exposed only to the two participants of an assigned delivery.
create or replace function public.get_delivery_contacts(p_order_id uuid)
returns table(
  customer_name text,
  customer_phone text,
  rider_name text,
  rider_phone text
)
language plpgsql
security definer
set search_path=public
as $$
begin
  return query
  select cp.full_name,cp.phone,rp.display_name,rp.phone
  from public.orders o
  left join public.profiles cp on cp.id=o.customer_id
  left join public.riders r on r.id=o.rider_id
  left join public.profiles rp on rp.id=r.id
  where o.id=p_order_id
    and (o.customer_id=auth.uid() or o.rider_id=auth.uid() or public.current_user_role() in ('admin','supervisor'))
    and o.rider_id is not null;
end
$$;

-- Sensitive RPCs should never be callable by anonymous clients.
revoke execute on function public.get_rider_available_orders() from public;
revoke execute on function public.accept_order(uuid) from public;
revoke execute on function public.advance_order(uuid,text) from public;
revoke execute on function public.confirm_delivery(uuid) from public;
revoke execute on function public.set_order_price(uuid,numeric) from public;
revoke execute on function public.approve_rider(uuid,boolean) from public;
revoke execute on function public.update_rider_presence(boolean,double precision,double precision) from public;
revoke execute on function public.get_delivery_contacts(uuid) from public;
revoke execute on function public.auto_complete_deliveries() from public;

grant execute on function public.get_rider_available_orders() to authenticated;
grant execute on function public.accept_order(uuid) to authenticated;
grant execute on function public.advance_order(uuid,text) to authenticated;
grant execute on function public.confirm_delivery(uuid) to authenticated;
grant execute on function public.set_order_price(uuid,numeric) to authenticated;
grant execute on function public.approve_rider(uuid,boolean) to authenticated;
grant execute on function public.update_rider_presence(boolean,double precision,double precision) to authenticated;
grant execute on function public.get_delivery_contacts(uuid) to authenticated;

-- auto_complete_deliveries is invoked only by the server-side scheduled function using service role.
