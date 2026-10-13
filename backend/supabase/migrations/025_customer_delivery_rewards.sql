alter table public.payments
 add column if not exists wallet_credit numeric(12,2) not null default 0
 check(wallet_credit>=0);

create table if not exists public.customer_wallet_ledger(
 id uuid primary key default gen_random_uuid(),
 customer_id uuid not null references public.profiles(id) on delete restrict,
 entry_type text not null check(entry_type in ('cashback','redemption')),
 amount numeric(12,2) not null check(amount>0),
 source_order_id uuid not null references public.orders(id) on delete restrict,
 created_at timestamptz not null default now()
);

create unique index if not exists customer_wallet_cashback_once_uidx
 on public.customer_wallet_ledger(customer_id)
 where entry_type='cashback';
create unique index if not exists customer_wallet_source_entry_uidx
 on public.customer_wallet_ledger(source_order_id,entry_type);
create index if not exists customer_wallet_customer_date_idx
 on public.customer_wallet_ledger(customer_id,created_at desc);

alter table public.customer_wallet_ledger enable row level security;
drop policy if exists customer_wallet_ledger_select_own on public.customer_wallet_ledger;
create policy customer_wallet_ledger_select_own on public.customer_wallet_ledger
 for select to authenticated using(customer_id=(select auth.uid()));
revoke all on public.customer_wallet_ledger from public,anon,authenticated;
grant select on public.customer_wallet_ledger to authenticated;
grant select,insert,update,delete on public.customer_wallet_ledger to service_role;

create or replace function public.record_customer_delivery_cashback()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
 completed_count integer;
 reward_amount numeric(12,2);
begin
 if new.status<>'completed' or new.payment_status<>'paid'
    or new.customer_id is null or new.final_price<=0 then
  return new;
 end if;

 perform 1 from public.profiles where id=new.customer_id for update;
 if not found then
  raise exception 'The customer profile required for delivery cashback is missing.';
 end if;

 select count(*) into completed_count
 from public.orders
 where customer_id=new.customer_id
   and status='completed'
   and payment_status='paid';

 if completed_count=7 then
  reward_amount=round(new.final_price*0.02,2);
  if reward_amount>0 then
   insert into public.customer_wallet_ledger(customer_id,entry_type,amount,source_order_id)
   values(new.customer_id,'cashback',reward_amount,new.id)
   on conflict do nothing;
  end if;
 end if;
 return new;
end;
$$;

drop trigger if exists orders_record_customer_delivery_cashback on public.orders;
create trigger orders_record_customer_delivery_cashback
 after update of status,payment_status on public.orders
 for each row
 when(new.status='completed' and new.payment_status='paid')
 execute function public.record_customer_delivery_cashback();

create or replace function public.get_customer_wallet_balance()
returns numeric
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
declare
 customer uuid;
 wallet_balance numeric(12,2);
begin
 customer=auth.uid();
 if customer is null or public.current_user_role()<>'customer' then
  raise exception 'A signed-in customer account is required.';
 end if;

 select greatest(
  0,
  coalesce(sum(case when entry_type='cashback' then amount else -amount end),0)
  -coalesce((
    select sum(p.wallet_credit)
    from public.payments p
    where p.customer_id=customer and p.status='pending' and p.wallet_credit>0
   ),0)
 ) into wallet_balance
 from public.customer_wallet_ledger
 where customer_id=customer;
 return round(wallet_balance,2);
end;
$$;

revoke all on function public.get_customer_wallet_balance() from public,anon;
grant execute on function public.get_customer_wallet_balance() to authenticated;

create or replace function public.reserve_customer_delivery_payment(
 p_order_id uuid,
 p_reference text
)
returns public.payments
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
 order_row public.orders;
 quote_row public.delivery_quote_reviews;
 result public.payments;
 approved_price numeric(12,2);
 available_credit numeric(12,2);
 applied_credit numeric(12,2);
begin
 if p_order_id is null or p_reference is null or length(btrim(p_reference))<8 then
  raise exception 'A valid delivery and payment reference are required.';
 end if;

 select * into order_row from public.orders where id=p_order_id for update;
 if order_row.id is null then raise exception 'Delivery not found.'; end if;
 perform 1 from public.profiles where id=order_row.customer_id and role='customer' for update;
 if not found then raise exception 'A customer account is required for payment.'; end if;

 if exists(select 1 from public.payments where order_id=order_row.id and status='pending') then
  raise exception 'A payment is already in progress for this delivery.';
 end if;

 select * into quote_row from public.delivery_quote_reviews
 where order_id=order_row.id and customer_id=order_row.customer_id;
 if quote_row.order_id is not null then
  if quote_row.status<>'approved' or order_row.status<>'approved'
     or order_row.payment_status<>'unpaid' or quote_row.approved_price is null
     or quote_row.approved_price<=0 or quote_row.approved_price<>order_row.final_price
     or quote_row.expires_at is null or quote_row.expires_at<=now() then
   raise exception 'Operations has not approved a valid delivery quote for payment.';
  end if;
  approved_price=quote_row.approved_price;
 elsif order_row.status='awaiting_payment' and order_row.payment_status='unpaid' then
  approved_price=order_row.final_price;
 else
  raise exception 'Operations has not released this delivery for payment yet.';
 end if;

 select greatest(
  0,
  coalesce(sum(case when entry_type='cashback' then amount else -amount end),0)
  -coalesce((
    select sum(p.wallet_credit)
    from public.payments p
    where p.customer_id=order_row.customer_id and p.status='pending' and p.wallet_credit>0
   ),0)
 ) into available_credit
 from public.customer_wallet_ledger
 where customer_id=order_row.customer_id;
 applied_credit=least(coalesce(available_credit,0),approved_price);

 insert into public.payments(order_id,customer_id,amount,wallet_credit,currency,status,reference)
 values(order_row.id,order_row.customer_id,round(approved_price-applied_credit,2),round(applied_credit,2),'NGN','pending',btrim(p_reference))
 returning * into result;
 return result;
end;
$$;

create or replace function public.settle_customer_wallet_payment(p_payment_id uuid)
returns boolean
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
 payment_row public.payments;
 order_row public.orders;
 quote_row public.delivery_quote_reviews;
 available_credit numeric(12,2);
begin
 select * into payment_row from public.payments where id=p_payment_id for update;
 if payment_row.id is null then return false; end if;
 if payment_row.status='paid' then return true; end if;
 if payment_row.status<>'pending' or payment_row.amount<>0 or payment_row.wallet_credit<=0 then
  raise exception 'This delivery does not have a valid full wallet-credit payment.';
 end if;

 select * into order_row from public.orders where id=payment_row.order_id for update;
 if order_row.id is null then return false; end if;
 perform 1 from public.profiles where id=payment_row.customer_id and role='customer' for update;
 if not found then raise exception 'A customer account is required for payment.'; end if;

 select * into quote_row from public.delivery_quote_reviews
 where order_id=order_row.id and customer_id=payment_row.customer_id;
 if quote_row.order_id is not null then
  if quote_row.status<>'approved' or order_row.status<>'approved'
     or order_row.payment_status<>'unpaid' or quote_row.approved_price is null
     or quote_row.approved_price<>(payment_row.amount+payment_row.wallet_credit)
     or order_row.final_price<>quote_row.approved_price
     or quote_row.expires_at is null or quote_row.expires_at<=now() then
   raise exception 'The approved delivery price changed. Wallet credit was not spent.';
  end if;
 elsif order_row.status<>'awaiting_payment' or order_row.payment_status<>'unpaid'
       or order_row.final_price<>(payment_row.amount+payment_row.wallet_credit) then
  raise exception 'The delivery is not eligible for wallet-credit payment.';
 end if;

 select greatest(
  0,
  coalesce(sum(case when entry_type='cashback' then amount else -amount end),0)
  -coalesce((
    select sum(p.wallet_credit)
    from public.payments p
    where p.customer_id=payment_row.customer_id and p.status='pending' and p.id<>payment_row.id and p.wallet_credit>0
   ),0)
 ) into available_credit
 from public.customer_wallet_ledger
 where customer_id=payment_row.customer_id;
 if coalesce(available_credit,0)<payment_row.wallet_credit then
  raise exception 'Available delivery credit changed. Please retry payment.';
 end if;

 insert into public.customer_wallet_ledger(customer_id,entry_type,amount,source_order_id)
 values(payment_row.customer_id,'redemption',payment_row.wallet_credit,payment_row.order_id);

 update public.orders set payment_status='paid',status='paid'
 where id=order_row.id and status in ('approved','awaiting_payment') and payment_status='unpaid';
 if not found then raise exception 'Delivery payment state changed before wallet settlement.'; end if;

 update public.payments set status='paid',paystack_status='wallet_credit',paid_at=now()
 where id=payment_row.id and status='pending';
 insert into public.order_events(order_id,actor_id,event,note)
 values(payment_row.order_id,payment_row.customer_id,'payment_confirmed','Delivery paid using customer wallet credit');
 return true;
end;
$$;

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
set search_path=public,pg_temp
as $$
declare
 payment_row public.payments;
 order_row public.orders;
 quote_row public.delivery_quote_reviews;
 available_credit numeric(12,2);
begin
 if p_reference is null or length(trim(p_reference))=0 then return false; end if;
 select * into payment_row from public.payments where reference=p_reference for update;
 if payment_row.id is null then return false; end if;
 if payment_row.status='paid' then return true; end if;

 if lower(coalesce(p_status,''))<>'success'
    or coalesce(p_amount_minor,-1)<>round(payment_row.amount*100)::bigint
    or upper(coalesce(p_currency,''))<>upper(payment_row.currency) then
  update public.payments
  set status='failed',paystack_status=p_status,fee=coalesce(p_fee_minor,0)::numeric/100,
      payment_method=p_payment_method,raw_response=p_raw_response
  where id=payment_row.id;
  return false;
 end if;

 select * into order_row from public.orders where id=payment_row.order_id for update;
 if order_row.id is null then return false; end if;
 perform 1 from public.profiles where id=payment_row.customer_id and role='customer' for update;
 if not found then return false; end if;

 select * into quote_row from public.delivery_quote_reviews
 where order_id=payment_row.order_id for update;
 if quote_row.order_id is not null then
  if quote_row.status<>'approved' or quote_row.approved_price is null
      or quote_row.approved_price<>(payment_row.amount+payment_row.wallet_credit)
      or order_row.final_price<>quote_row.approved_price
      or order_row.status<>'approved' or order_row.payment_status<>'unpaid' then
   update public.payments set status='failed',paystack_status='approved_quote_mismatch',raw_response=p_raw_response
   where id=payment_row.id;
   return false;
  end if;
 elsif order_row.status<>'awaiting_payment' or order_row.payment_status<>'unpaid'
       or order_row.final_price<>(payment_row.amount+payment_row.wallet_credit) then
  update public.payments set status='failed',paystack_status='order_not_payable',raw_response=p_raw_response
  where id=payment_row.id;
  return false;
 end if;

 if payment_row.wallet_credit>0 then
  select greatest(
   0,
   coalesce(sum(case when entry_type='cashback' then amount else -amount end),0)
   -coalesce((
     select sum(p.wallet_credit)
     from public.payments p
     where p.customer_id=payment_row.customer_id and p.status='pending' and p.id<>payment_row.id and p.wallet_credit>0
    ),0)
  ) into available_credit
  from public.customer_wallet_ledger
  where customer_id=payment_row.customer_id;
  if coalesce(available_credit,0)<payment_row.wallet_credit then
   update public.payments set status='failed',paystack_status='wallet_credit_changed',raw_response=p_raw_response
   where id=payment_row.id;
   return false;
  end if;
  insert into public.customer_wallet_ledger(customer_id,entry_type,amount,source_order_id)
  values(payment_row.customer_id,'redemption',payment_row.wallet_credit,payment_row.order_id);
 end if;

 update public.orders set payment_status='paid',status='paid'
 where id=payment_row.order_id and status in ('approved','awaiting_payment') and payment_status='unpaid';
 if not found then return false; end if;
 update public.payments
 set status='paid',paystack_status=p_status,fee=coalesce(p_fee_minor,0)::numeric/100,
     payment_method=p_payment_method,paid_at=now(),raw_response=p_raw_response
 where id=payment_row.id;
 insert into public.order_events(order_id,actor_id,event,note)
 values(payment_row.order_id,payment_row.customer_id,'payment_confirmed','Paystack payment confirmed');
 return true;
end
$$;

revoke all on function public.reserve_customer_delivery_payment(uuid,text) from public,anon,authenticated;
revoke all on function public.settle_customer_wallet_payment(uuid) from public,anon,authenticated;
revoke all on function public.apply_paystack_payment(text,text,bigint,text,bigint,text,jsonb)
 from public,anon,authenticated;
grant execute on function public.reserve_customer_delivery_payment(uuid,text) to service_role;
grant execute on function public.settle_customer_wallet_payment(uuid) to service_role;
grant execute on function public.apply_paystack_payment(text,text,bigint,text,bigint,text,jsonb)
 to service_role;

drop policy if exists reviews_select_own on public.rider_reviews;
create policy reviews_select_own on public.rider_reviews
 for select to authenticated using(
  customer_id=(select auth.uid())
  or public.current_user_role() in ('admin','supervisor')
  or (public.current_user_role()='rider' and rider_id=(select auth.uid()))
 );
grant select,insert on public.rider_reviews to authenticated;

create or replace function public.refresh_rider_review_rating()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
 rider uuid;
begin
 rider=coalesce(new.rider_id,old.rider_id);
 update public.riders
 set rating=coalesce((select round(avg(rating),2) from public.rider_reviews where rider_id=rider),0)
 where id=rider;
 if tg_op='DELETE' then return old; end if;
 return new;
end;
$$;

drop trigger if exists rider_reviews_refresh_rating on public.rider_reviews;
create trigger rider_reviews_refresh_rating
 after insert or update or delete on public.rider_reviews
 for each row execute function public.refresh_rider_review_rating();

notify pgrst,'reload schema';
