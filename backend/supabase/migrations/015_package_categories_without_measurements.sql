-- Store the customer's package category separately from legacy size and
-- measurement columns. Existing orders retain their measurements unchanged.
alter table public.orders
  add column if not exists package_category text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_package_category_valid'
  ) then
    alter table public.orders
      add constraint orders_package_category_valid
      check (package_category is null or package_category in ('small', 'medium', 'bulky'));
  end if;
end
$$;

alter table public.delivery_quote_reviews
  add column if not exists vehicle_reviewed_at timestamptz,
  add column if not exists vehicle_reviewed_by uuid references public.profiles(id),
  add column if not exists vehicle_review_note text;

create or replace function public.create_delivery_quote_with_category(
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
  p_requires_manual_review boolean
)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  order_row public.orders;
begin
  if p_package_category not in ('small', 'medium', 'bulky') then
    raise exception 'A valid package category is required';
  end if;

  order_row := public.create_delivery_quote(
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
    p_vehicle_type,
    p_distance_meters,
    p_duration_seconds,
    p_suggested_price,
    p_requires_manual_review
  );

  update public.orders
  set package_category = p_package_category
  where id = order_row.id
  returning * into order_row;

  return order_row;
end
$$;

revoke all on function public.create_delivery_quote_with_category(
  uuid, text, double precision, double precision, text, double precision,
  double precision, text, text, text, numeric, numeric, numeric, numeric,
  text, text, text, numeric, numeric, numeric, boolean
) from public, anon, authenticated;
grant execute on function public.create_delivery_quote_with_category(
  uuid, text, double precision, double precision, text, double precision,
  double precision, text, text, text, numeric, numeric, numeric, numeric,
  text, text, text, numeric, numeric, numeric, boolean
) to service_role;

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
  offer_expires_at timestamptz,
  package_category text
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
         )
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

revoke execute on function public.get_rider_available_orders() from public, anon;
grant execute on function public.get_rider_available_orders() to authenticated;

create or replace function public.set_delivery_quote_vehicle(
  p_order_id uuid,
  p_vehicle_type text,
  p_reason text
)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  order_row public.orders;
  previous_vehicle text;
  quote_expires_at timestamptz;
begin
  if public.current_user_role() not in ('admin', 'supervisor') then
    raise exception 'Operations access required';
  end if;
  if p_vehicle_type not in ('motorcycle', 'car', 'van', 'truck', 'lorry') then
    raise exception 'Select a supported delivery vehicle';
  end if;
  if p_reason is null or length(trim(p_reason)) not between 3 and 1000 then
    raise exception 'Record the vehicle inspection or decision reason';
  end if;

  select q.expires_at into quote_expires_at
  from public.delivery_quote_reviews q
  where q.order_id = p_order_id
    and q.status = 'pending_admin_review'
    and q.expires_at > now()
  for update;
  if quote_expires_at is null then
    raise exception 'Only an unpaid, unassigned quote awaiting operations review can change vehicle';
  end if;

  select o.vehicle_type into previous_vehicle
  from public.orders o
  where o.id = p_order_id
    and o.status = 'pending_admin_review'
    and o.payment_status = 'unpaid'
    and o.rider_id is null
  for update;
  if previous_vehicle is null then
    raise exception 'Only an unpaid, unassigned quote awaiting operations review can change vehicle';
  end if;

  update public.orders
  set vehicle_type = p_vehicle_type
  where id = p_order_id
  returning * into order_row;

  update public.delivery_quote_reviews
  set vehicle_reviewed_at = now(),
      vehicle_reviewed_by = (select auth.uid()),
      vehicle_review_note = left(trim(p_reason), 1000)
  where order_id = p_order_id
    and status = 'pending_admin_review'
    and expires_at > now();
  if not found then
    raise exception 'Delivery quote is no longer awaiting vehicle review';
  end if;

  insert into public.order_events(order_id, actor_id, event, note)
  values (
    p_order_id, (select auth.uid()), 'quote_vehicle_reviewed',
    'Operations verified the delivery vehicle as ' || p_vehicle_type ||
      (case when previous_vehicle = p_vehicle_type then '' else ' (updated from ' || previous_vehicle || ')' end)
  );
  return order_row;
end
$$;

revoke execute on function public.set_delivery_quote_vehicle(uuid, text, text) from public, anon;
grant execute on function public.set_delivery_quote_vehicle(uuid, text, text) to authenticated;

drop function if exists public.get_admin_delivery_quote(uuid);
create function public.get_admin_delivery_quote(p_order_id uuid)
returns table (
  order_id uuid,
  distance_meters numeric,
  duration_seconds numeric,
  suggested_price numeric,
  approved_price numeric,
  status text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  admin_note text,
  requires_manual_review boolean,
  expires_at timestamptz,
  vehicle_reviewed_at timestamptz,
  vehicle_reviewed_by uuid,
  vehicle_review_note text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.current_user_role() not in ('admin', 'supervisor') then
    raise exception 'Operations access required';
  end if;

  update public.delivery_quote_reviews q
  set status = 'expired'
  where q.order_id = p_order_id
    and q.status = 'pending_admin_review'
    and q.expires_at <= now();

  if found then
    update public.orders
    set status = 'expired'
    where id = p_order_id and status = 'pending_admin_review';
  end if;

  return query
  select q.order_id, q.distance_meters, q.duration_seconds,
         q.suggested_price, q.approved_price, q.status, q.reviewed_by,
         q.reviewed_at, q.admin_note, q.requires_manual_review, q.expires_at,
         q.vehicle_reviewed_at, q.vehicle_reviewed_by, q.vehicle_review_note
  from public.delivery_quote_reviews q
  where q.order_id = p_order_id;
end
$$;

create or replace function public.approve_delivery_quote(
  p_order_id uuid,
  p_price numeric,
  p_admin_note text default null
)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  order_row public.orders;
begin
  if public.current_user_role() not in ('admin', 'supervisor') then
    raise exception 'Operations access required';
  end if;
  if not exists (
    select 1
    from public.delivery_quote_reviews q
    where q.order_id = p_order_id
      and q.status = 'pending_admin_review'
      and q.expires_at > now()
      and q.vehicle_reviewed_at is not null
  ) then
    raise exception 'Verify and record the safe delivery vehicle before approving a customer price';
  end if;

  order_row := public.set_order_price(p_order_id, p_price);
  update public.delivery_quote_reviews
  set admin_note = nullif(left(trim(coalesce(p_admin_note, '')), 1000), '')
  where order_id = p_order_id;

  return order_row;
end
$$;

revoke execute on function public.get_admin_delivery_quote(uuid) from public, anon;
grant execute on function public.get_admin_delivery_quote(uuid) to authenticated;
revoke execute on function public.approve_delivery_quote(uuid, numeric, text) from public, anon;
grant execute on function public.approve_delivery_quote(uuid, numeric, text) to authenticated;

notify pgrst, 'reload schema';
