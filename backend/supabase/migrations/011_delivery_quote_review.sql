-- Store durable delivery quotes on orders while keeping the suggested price
-- and review audit private from customer and rider table reads.

alter table public.orders
  add column if not exists distance_meters numeric(12,2),
  add column if not exists duration_seconds numeric(12,2),
  add column if not exists quote_expires_at timestamptz;

alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders drop constraint if exists orders_status_check_v2;
alter table public.orders
  add constraint orders_status_check_v2
  check (status in (
    'price_review',
    'pending_admin_review',
    'approved',
    'rejected',
    'expired',
    'awaiting_payment',
    'paid',
    'searching',
    'accepted',
    'picked_up',
    'on_the_way',
    'at_door',
    'delivered',
    'completed',
    'cancelled'
  ));

create table if not exists public.delivery_quote_reviews (
  order_id uuid primary key references public.orders(id) on delete cascade,
  customer_id uuid not null references public.profiles(id),
  distance_meters numeric(12,2) not null check (distance_meters >= 0),
  duration_seconds numeric(12,2) not null check (duration_seconds >= 0),
  suggested_price numeric(12,0) not null check (suggested_price > 0),
  approved_price numeric(12,0) check (approved_price is null or approved_price > 0),
  status text not null check (status in ('pending_admin_review','approved','rejected','expired')),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  admin_note text,
  requires_manual_review boolean not null default false,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists delivery_quote_reviews_pending_idx
  on public.delivery_quote_reviews(status, created_at)
  where status = 'pending_admin_review';

alter table public.delivery_quote_reviews enable row level security;
revoke all on public.delivery_quote_reviews from public, anon, authenticated;
grant all on public.delivery_quote_reviews to service_role;

drop trigger if exists delivery_quote_reviews_touch on public.delivery_quote_reviews;
create trigger delivery_quote_reviews_touch
  before update on public.delivery_quote_reviews
  for each row execute function public.touch_updated_at();

create or replace function public.create_delivery_quote(
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
  quote_expiry timestamptz := now() + interval '24 hours';
begin
  if p_customer_id is null
     or p_pickup_latitude is null or p_pickup_latitude not between -90 and 90
     or p_pickup_longitude is null or p_pickup_longitude not between -180 and 180
     or p_dropoff_latitude is null or p_dropoff_latitude not between -90 and 90
     or p_dropoff_longitude is null or p_dropoff_longitude not between -180 and 180
     or p_distance_meters is null or p_distance_meters < 0
     or p_duration_seconds is null or p_duration_seconds < 0
     or p_suggested_price is null or p_suggested_price <= 0 then
    raise exception 'Delivery quote details are invalid';
  end if;

  insert into public.orders (
    customer_id,
    pickup_address,
    pickup_latitude,
    pickup_longitude,
    dropoff_address,
    dropoff_latitude,
    dropoff_longitude,
    recipient_name,
    recipient_phone,
    goods_description,
    weight_kg,
    length_cm,
    width_cm,
    height_cm,
    package_size,
    vehicle_type,
    distance_meters,
    distance_km,
    duration_seconds,
    duration_minutes,
    system_price,
    final_price,
    quote_expires_at,
    status,
    payment_status
  ) values (
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
    round(p_distance_meters::numeric / 1000, 2),
    p_duration_seconds,
    ceil(p_duration_seconds::numeric / 60)::integer,
    0,
    0,
    quote_expiry,
    'pending_admin_review',
    'unpaid'
  )
  returning * into order_row;

  insert into public.delivery_quote_reviews (
    order_id,
    customer_id,
    distance_meters,
    duration_seconds,
    suggested_price,
    status,
    requires_manual_review,
    expires_at
  ) values (
    order_row.id,
    p_customer_id,
    p_distance_meters,
    p_duration_seconds,
    round(p_suggested_price),
    'pending_admin_review',
    coalesce(p_requires_manual_review, false),
    quote_expiry
  );

  insert into public.order_events(order_id, actor_id, event, note)
  values (
    order_row.id,
    p_customer_id,
    'delivery_quote_created',
    'Road distance and duration calculated by OpenRouteService'
  );

  return order_row;
end
$$;

revoke all on function public.create_delivery_quote(
  uuid,text,double precision,double precision,text,double precision,double precision,
  text,text,text,numeric,numeric,numeric,numeric,text,text,numeric,numeric,numeric,boolean
) from public, anon, authenticated;
grant execute on function public.create_delivery_quote(
  uuid,text,double precision,double precision,text,double precision,double precision,
  text,text,text,numeric,numeric,numeric,numeric,text,text,numeric,numeric,numeric,boolean
) to service_role;

create or replace function public.get_admin_delivery_quote(p_order_id uuid)
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
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.current_user_role() not in ('admin','supervisor') then
    raise exception 'Operations access required';
  end if;

  update public.delivery_quote_reviews q
  set status = 'expired'
  where q.order_id = p_order_id
    and q.status = 'pending_admin_review'
    and q.expires_at <= now();

  if found then
    update public.orders set status = 'expired'
    where id = p_order_id and status = 'pending_admin_review';
  end if;

  return query
  select q.order_id,q.distance_meters,q.duration_seconds,q.suggested_price,
         q.approved_price,q.status,q.reviewed_by,q.reviewed_at,q.admin_note,
         q.requires_manual_review,q.expires_at
  from public.delivery_quote_reviews q
  where q.order_id = p_order_id;
end
$$;

create or replace function public.set_order_price(p_order_id uuid, p_price numeric)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  order_row public.orders;
  quote_row public.delivery_quote_reviews;
begin
  if public.current_user_role() not in ('admin','supervisor') then
    raise exception 'Operations access required';
  end if;
  if p_price is null or p_price <= 0 or p_price <> round(p_price) then
    raise exception 'Price must be a positive whole-naira amount';
  end if;

  select * into quote_row
  from public.delivery_quote_reviews
  where order_id = p_order_id
  for update;

  if quote_row.order_id is not null then
    if quote_row.status <> 'pending_admin_review' or quote_row.expires_at <= now() then
      raise exception 'This delivery quote is no longer awaiting review';
    end if;

    update public.delivery_quote_reviews
    set approved_price = p_price,
        status = 'approved',
        reviewed_by = auth.uid(),
        reviewed_at = now()
    where order_id = p_order_id;

    update public.orders
    set final_price = p_price,
        status = 'approved'
    where id = p_order_id
      and status = 'pending_admin_review'
      and payment_status = 'unpaid'
    returning * into order_row;

    if order_row.id is null then
      raise exception 'Delivery quote cannot be approved in its current state';
    end if;

    insert into public.order_events(order_id,actor_id,event,note)
    values (
      p_order_id,
      auth.uid(),
      case when p_price = quote_row.suggested_price then 'quote_approved' else 'quote_price_adjusted' end,
      'Suggested price ₦' || quote_row.suggested_price::text || '; approved price ₦' || p_price::text
    );
    return order_row;
  end if;

  update public.orders
  set final_price = p_price,
      status = case when payment_status = 'paid' then status else 'awaiting_payment' end
  where id = p_order_id
    and payment_status in ('unpaid','failed')
    and status in ('price_review','awaiting_payment')
  returning * into order_row;

  if order_row.id is null then
    raise exception 'Delivery price cannot be changed after payment or dispatch';
  end if;

  insert into public.order_events(order_id,actor_id,event,note)
  values(order_row.id,auth.uid(),'price_changed','Operations updated final price');
  return order_row;
end
$$;

create or replace function public.reject_delivery_quote(p_order_id uuid, p_admin_note text default null)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  order_row public.orders;
begin
  if public.current_user_role() not in ('admin','supervisor') then
    raise exception 'Operations access required';
  end if;

  update public.delivery_quote_reviews
  set status = 'rejected',
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      admin_note = nullif(left(trim(coalesce(p_admin_note,'')),1000),'')
  where order_id = p_order_id
    and status = 'pending_admin_review'
    and expires_at > now();

  if not found then
    raise exception 'Delivery quote is unavailable or no longer awaiting review';
  end if;

  update public.orders set status = 'rejected'
  where id = p_order_id and status = 'pending_admin_review'
  returning * into order_row;

  if order_row.id is null then
    raise exception 'Delivery quote cannot be rejected in its current state';
  end if;

  insert into public.order_events(order_id,actor_id,event,note)
  values(order_row.id,auth.uid(),'quote_rejected','Operations rejected the delivery quote');
  return order_row;
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
  if public.current_user_role() not in ('admin','supervisor') then
    raise exception 'Operations access required';
  end if;

  order_row := public.set_order_price(p_order_id,p_price);
  update public.delivery_quote_reviews
  set admin_note = nullif(left(trim(coalesce(p_admin_note,'')),1000),'')
  where order_id = p_order_id;

  return order_row;
end
$$;

revoke execute on function public.get_admin_delivery_quote(uuid) from public, anon;
revoke execute on function public.set_order_price(uuid,numeric) from public, anon;
revoke execute on function public.reject_delivery_quote(uuid,text) from public, anon;
revoke execute on function public.approve_delivery_quote(uuid,numeric,text) from public, anon;
grant execute on function public.get_admin_delivery_quote(uuid) to authenticated;
grant execute on function public.set_order_price(uuid,numeric) to authenticated;
grant execute on function public.reject_delivery_quote(uuid,text) to authenticated;
grant execute on function public.approve_delivery_quote(uuid,numeric,text) to authenticated;

create or replace function public.apply_paystack_payment(
  p_reference text,
  p_status text,
  p_amount_minor bigint,
  p_currency text,
  p_fee_minor bigint,
  p_payment_method text,
  p_raw_response jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  payment_row public.payments;
  order_row public.orders;
  quote_row public.delivery_quote_reviews;
begin
  if p_reference is null or length(trim(p_reference)) = 0 then
    return false;
  end if;

  select * into payment_row
  from public.payments
  where reference = p_reference
  for update;

  if payment_row.id is null then
    return false;
  end if;
  if payment_row.status = 'paid' then
    return true;
  end if;

  if lower(coalesce(p_status,'')) <> 'success'
     or coalesce(p_amount_minor,-1) <> round(payment_row.amount * 100)::bigint
     or upper(coalesce(p_currency,'')) <> upper(payment_row.currency) then
    update public.payments
    set status='failed',paystack_status=p_status,
        fee=coalesce(p_fee_minor,0)::numeric/100,
        payment_method=p_payment_method,raw_response=p_raw_response
    where id=payment_row.id;
    return false;
  end if;

  select * into order_row
  from public.orders
  where id=payment_row.order_id
  for update;

  if order_row.id is null then
    return false;
  end if;

  select * into quote_row
  from public.delivery_quote_reviews
  where order_id=payment_row.order_id
  for update;

  if quote_row.order_id is not null then
    if quote_row.status <> 'approved'
       or quote_row.approved_price is null
       or quote_row.approved_price <> payment_row.amount
       or order_row.final_price <> quote_row.approved_price
       or order_row.status <> 'approved'
       or order_row.payment_status <> 'unpaid' then
      update public.payments
      set status='failed',paystack_status='approved_quote_mismatch',raw_response=p_raw_response
      where id=payment_row.id;
      return false;
    end if;
  elsif order_row.status <> 'awaiting_payment'
     or order_row.payment_status <> 'unpaid' then
    update public.payments
    set status='failed',paystack_status='order_not_payable',raw_response=p_raw_response
    where id=payment_row.id;
    return false;
  end if;

  update public.orders
  set payment_status='paid',status='paid'
  where id=payment_row.order_id
    and status in ('approved','awaiting_payment')
    and payment_status='unpaid';

  if not found then
    return false;
  end if;

  update public.payments
  set status='paid',paystack_status=p_status,
      fee=coalesce(p_fee_minor,0)::numeric/100,
      payment_method=p_payment_method,paid_at=now(),raw_response=p_raw_response
  where id=payment_row.id;

  insert into public.order_events(order_id,actor_id,event,note)
  values(payment_row.order_id,payment_row.customer_id,'payment_confirmed','Paystack payment confirmed');
  return true;
end
$$;

revoke all on function public.apply_paystack_payment(text,text,bigint,text,bigint,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.apply_paystack_payment(text,text,bigint,text,bigint,text,jsonb)
  to service_role;
