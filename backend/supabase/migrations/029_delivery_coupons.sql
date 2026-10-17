create table if not exists public.delivery_coupons (
 id uuid primary key default gen_random_uuid(),
 code text not null,
 program text not null check(program in ('church','unilag','first30','month','year')),
 discount_percent numeric(5,2) not null check(discount_percent>0 and discount_percent<=100),
 customer_id uuid references public.profiles(id) on delete restrict,
 period_start date,
 requires_admin_approval boolean not null default false,
 new_customer_only boolean not null default true,
 max_redemptions integer check(max_redemptions is null or max_redemptions>0),
 valid_from timestamptz not null default now(),
 expires_at timestamptz not null,
 active boolean not null default true,
 created_by uuid references public.profiles(id),
 created_at timestamptz not null default now(),
 constraint delivery_coupons_code_not_blank check(length(btrim(code)) between 3 and 48),
 constraint delivery_coupons_period_valid check(
  (program in ('month','year') and customer_id is not null and period_start is not null)
  or (program not in ('month','year') and period_start is null)
 )
);

create unique index if not exists delivery_coupons_code_ci_uidx
 on public.delivery_coupons(lower(code));
create unique index if not exists delivery_coupons_award_uidx
 on public.delivery_coupons(program,period_start,customer_id)
 where program in ('month','year');

create table if not exists public.delivery_coupon_claims (
 id uuid primary key default gen_random_uuid(),
 coupon_id uuid not null references public.delivery_coupons(id) on delete restrict,
 customer_id uuid not null references public.profiles(id) on delete restrict,
 order_id uuid unique references public.orders(id) on delete restrict,
 code_snapshot text not null,
 discount_percent numeric(5,2) not null check(discount_percent>0 and discount_percent<=100),
 status text not null check(status in ('reserved','pending_admin_approval','approved','rejected','redeemed','expired')),
 original_price numeric(12,2) check(original_price is null or original_price>=0),
 discount_amount numeric(12,2) not null default 0 check(discount_amount>=0),
 payable_amount numeric(12,2) check(payable_amount is null or payable_amount>=0),
 reviewed_by uuid references public.profiles(id),
 reviewed_at timestamptz,
 redeemed_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);

alter table public.delivery_quote_reviews
 add column if not exists pre_discount_price numeric(12,2) check(pre_discount_price is null or pre_discount_price>=0);

create index if not exists delivery_coupon_claims_admin_idx
 on public.delivery_coupon_claims(status,created_at desc);
create index if not exists delivery_coupon_claims_customer_idx
 on public.delivery_coupon_claims(customer_id,created_at desc);

alter table public.delivery_coupons enable row level security;
alter table public.delivery_coupon_claims enable row level security;
revoke all on public.delivery_coupons,public.delivery_coupon_claims from public,anon,authenticated;
grant select on public.delivery_coupons,public.delivery_coupon_claims to authenticated;
grant select,insert,update,delete on public.delivery_coupons,public.delivery_coupon_claims to service_role;

drop policy if exists delivery_coupons_owner_or_admin_read on public.delivery_coupons;
create policy delivery_coupons_owner_or_admin_read on public.delivery_coupons
 for select to authenticated
 using(customer_id=(select auth.uid()) or public.current_user_role() in ('admin','supervisor'));

drop policy if exists delivery_coupon_claims_owner_or_admin_read on public.delivery_coupon_claims;
create policy delivery_coupon_claims_owner_or_admin_read on public.delivery_coupon_claims
 for select to authenticated
 using(customer_id=(select auth.uid()) or public.current_user_role() in ('admin','supervisor'));

insert into public.delivery_coupons(code,program,discount_percent,requires_admin_approval,new_customer_only,max_redemptions,expires_at)
select seed.code,seed.program,seed.discount_percent,seed.requires_admin_approval,true,seed.max_redemptions,'9999-12-31 23:59:59+00'::timestamptz
from (values
 ('church_FDD','church',20::numeric,true,null::integer),
 ('Unilag_FDD','unilag',20::numeric,true,null::integer),
 ('1_FDD','first30',20::numeric,false,30)
) as seed(code,program,discount_percent,requires_admin_approval,max_redemptions)
where not exists(select 1 from public.delivery_coupons c where lower(c.code)=lower(seed.code));

create or replace function public.reserve_delivery_coupon(p_customer_id uuid,p_code text)
returns uuid
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
 coupon_row public.delivery_coupons;
 claim_id uuid;
 active_count integer;
begin
 if p_customer_id is null or p_code is null or length(btrim(p_code))<3 or length(btrim(p_code))>48 then
  raise exception 'Enter a valid coupon code.';
 end if;

 select * into coupon_row from public.delivery_coupons
 where lower(code)=lower(btrim(p_code)) and active
 for update;
 if coupon_row.id is null then raise exception 'This coupon code is not valid.'; end if;
 if coupon_row.valid_from>now() or coupon_row.expires_at<=now() then
  raise exception 'This coupon has expired or is not active yet.';
 end if;
 if coupon_row.customer_id is not null and coupon_row.customer_id<>p_customer_id then
  raise exception 'This coupon was issued to another customer.';
 end if;
 if coupon_row.new_customer_only and exists(
  select 1 from public.orders where customer_id=p_customer_id and payment_status='paid'
 ) then
  raise exception 'This coupon is only available to new customers.';
 end if;
 if exists(
  select 1 from public.delivery_coupon_claims c
  where c.coupon_id=coupon_row.id and c.customer_id=p_customer_id
   and (
    c.status='redeemed'
    or c.status='reserved' and c.created_at>now()-interval '15 minutes'
    or c.status in ('pending_admin_approval','approved')
     and exists(select 1 from public.orders o join public.delivery_quote_reviews q on q.order_id=o.id
      where o.id=c.order_id and o.payment_status='unpaid' and q.expires_at>now())
   )
 ) then
  raise exception 'This customer has already used or requested this coupon.';
 end if;

 update public.delivery_coupon_claims c
 set status='expired',updated_at=now()
 where c.coupon_id=coupon_row.id and c.status='reserved'
  and c.created_at<=now()-interval '15 minutes';
 update public.delivery_coupon_claims c
 set status='expired',updated_at=now()
 from public.orders o,public.delivery_quote_reviews q
 where c.order_id=o.id and q.order_id=o.id and c.coupon_id=coupon_row.id
  and c.status in ('pending_admin_approval','approved')
  and (q.expires_at<=now() or o.payment_status='paid' and c.status<>'redeemed');

 if coupon_row.max_redemptions is not null then
  select count(*) into active_count
  from public.delivery_coupon_claims c
  left join public.orders o on o.id=c.order_id
  left join public.delivery_quote_reviews q on q.order_id=o.id
  where c.coupon_id=coupon_row.id
   and (
    c.status='redeemed'
    or c.status='reserved' and c.created_at>now()-interval '15 minutes'
    or c.status in ('pending_admin_approval','approved') and q.expires_at>now() and o.payment_status='unpaid'
   );
  if active_count>=coupon_row.max_redemptions then
   raise exception 'All uses of this coupon have already been reserved.';
  end if;
 end if;

 insert into public.delivery_coupon_claims(coupon_id,customer_id,code_snapshot,discount_percent,status)
 values(coupon_row.id,p_customer_id,coupon_row.code,coupon_row.discount_percent,'reserved')
 returning id into claim_id;
 return claim_id;
end;
$$;

create or replace function public.attach_delivery_coupon(p_claim_id uuid,p_order_id uuid,p_customer_id uuid)
returns public.delivery_coupon_claims
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare result public.delivery_coupon_claims;
begin
 update public.delivery_coupon_claims c
 set order_id=p_order_id,
     status=case when coupon.requires_admin_approval then 'pending_admin_approval' else 'approved' end,
     updated_at=now()
 from public.delivery_coupons coupon,public.orders o
 where c.id=p_claim_id and c.coupon_id=coupon.id and c.customer_id=p_customer_id
  and c.status='reserved' and c.order_id is null
  and o.id=p_order_id and o.customer_id=p_customer_id and o.payment_status='unpaid'
 returning c.* into result;
 if result.id is null then raise exception 'The coupon could not be attached to this delivery quote.'; end if;
 return result;
end;
$$;

create or replace function public.release_delivery_coupon_reservation(p_claim_id uuid)
returns boolean
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare removed integer;
begin
 delete from public.delivery_coupon_claims
 where id=p_claim_id and status='reserved' and order_id is null;
 get diagnostics removed=row_count;
 return removed=1;
end;
$$;

create or replace function public.review_delivery_coupon_claim(p_claim_id uuid,p_approve boolean)
returns public.delivery_coupon_claims
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
 claim_row public.delivery_coupon_claims;
 quote_row public.delivery_quote_reviews;
 order_row public.orders;
 discounted numeric(12,2);
begin
 if public.current_user_role() not in ('admin','supervisor') then
  raise exception 'Operations access required';
 end if;
 select * into claim_row from public.delivery_coupon_claims where id=p_claim_id for update;
 if claim_row.id is null or claim_row.status<>'pending_admin_approval' or claim_row.order_id is null then
  raise exception 'This coupon request is no longer awaiting approval.';
 end if;
 select * into order_row from public.orders where id=claim_row.order_id for update;
 select * into quote_row from public.delivery_quote_reviews where order_id=claim_row.order_id for update;
 if order_row.id is null or quote_row.order_id is null or quote_row.expires_at<=now()
    or order_row.payment_status<>'unpaid' then
  update public.delivery_coupon_claims set status='expired',updated_at=now() where id=p_claim_id returning * into claim_row;
  return claim_row;
 end if;

 if p_approve then
  update public.delivery_coupon_claims
   set status='approved',original_price=quote_row.pre_discount_price,
       reviewed_by=auth.uid(),reviewed_at=now(),updated_at=now()
   where id=p_claim_id returning * into claim_row;
  if quote_row.status='approved' and quote_row.pre_discount_price is not null then
   discounted=greatest(1,quote_row.pre_discount_price-round(quote_row.pre_discount_price*claim_row.discount_percent/100,0));
   update public.delivery_coupon_claims
    set original_price=quote_row.pre_discount_price,
        discount_amount=round(quote_row.pre_discount_price*discount_percent/100,0),
        payable_amount=discounted,updated_at=now()
    where id=p_claim_id returning * into claim_row;
   update public.delivery_quote_reviews set approved_price=discounted where order_id=claim_row.order_id;
   update public.orders set final_price=discounted where id=claim_row.order_id and payment_status='unpaid';
  end if;
  insert into public.order_events(order_id,actor_id,event,note)
   values(claim_row.order_id,auth.uid(),'coupon_approved',
    'Coupon '||claim_row.code_snapshot||' approved; discount '||claim_row.discount_percent::text||'%');
 else
  discounted=coalesce(quote_row.pre_discount_price,quote_row.approved_price,order_row.final_price);
  update public.delivery_coupon_claims
   set status='rejected',discount_amount=0,payable_amount=discounted,
       reviewed_by=auth.uid(),reviewed_at=now(),updated_at=now()
   where id=p_claim_id returning * into claim_row;
  if quote_row.status='approved' then
   update public.delivery_quote_reviews set approved_price=discounted where order_id=claim_row.order_id;
   update public.orders set final_price=discounted where id=claim_row.order_id and payment_status='unpaid';
  end if;
  insert into public.order_events(order_id,actor_id,event,note)
   values(claim_row.order_id,auth.uid(),'coupon_rejected','Coupon '||claim_row.code_snapshot||' was not approved');
 end if;
 return claim_row;
end;
$$;

create or replace function public.get_admin_delivery_coupon_records()
returns table(
 claim_id uuid,code text,discount_percent numeric,status text,customer_id uuid,
 customer_name text,customer_email text,order_id uuid,tracking_number text,
 original_price numeric,discount_amount numeric,payable_amount numeric,created_at timestamptz,
 reviewed_at timestamptz,expires_at timestamptz
)
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
begin
 if public.current_user_role() not in ('admin','supervisor') then raise exception 'Operations access required'; end if;
 return query
 select c.id,c.code_snapshot,c.discount_percent,c.status,c.customer_id,p.full_name,p.email,
  c.order_id,o.tracking_number,c.original_price,c.discount_amount,c.payable_amount,c.created_at,
  c.reviewed_at,coalesce(q.expires_at,cp.expires_at)
 from public.delivery_coupon_claims c
 join public.profiles p on p.id=c.customer_id
 join public.delivery_coupons cp on cp.id=c.coupon_id
 left join public.orders o on o.id=c.order_id
 left join public.delivery_quote_reviews q on q.order_id=c.order_id
 order by c.created_at desc
 limit 500;
end;
$$;

create or replace function public.get_delivery_coupon_award_candidates(p_program text,p_period_start date)
returns table(
 customer_id uuid,customer_name text,customer_email text,total_spend numeric,
 completed_deliveries bigint,total_distance_meters numeric
)
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
declare period_end date;
begin
 if public.current_user_role() not in ('admin','supervisor') then raise exception 'Operations access required'; end if;
 if p_program='month' then
  if p_period_start<>date_trunc('month',p_period_start)::date or p_period_start>=date_trunc('month',now())::date then
   raise exception 'Select a completed calendar month.';
  end if;
  period_end=(p_period_start+interval '1 month')::date;
 elsif p_program='year' then
  if p_period_start<>date_trunc('year',p_period_start)::date or p_period_start>=date_trunc('year',now())::date then
   raise exception 'Select a completed calendar year.';
  end if;
  period_end=(p_period_start+interval '1 year')::date;
 else
  raise exception 'Select a monthly or yearly coupon program.';
 end if;
 return query
 select o.customer_id,max(p.full_name),max(p.email),sum(o.final_price),
  count(*) filter(where o.status='completed'),sum(coalesce(o.distance_meters,o.distance_km*1000,0))
 from public.orders o join public.profiles p on p.id=o.customer_id
 where o.created_at>=p_period_start and o.created_at<period_end
  and o.payment_status='paid' and o.status='completed'
 group by o.customer_id
 order by sum(o.final_price) desc,count(*) desc,sum(coalesce(o.distance_meters,o.distance_km*1000,0)) desc
 limit 3;
end;
$$;

create or replace function public.award_delivery_coupons(p_program text,p_period_start date)
returns table(customer_id uuid,customer_name text,customer_email text,code text,discount_percent numeric,expires_at timestamptz)
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
 candidate record;
 prefix text;
 percent numeric(5,2);
 code_value text;
 expiry timestamptz:=now()+interval '30 days';
begin
 if public.current_user_role() not in ('admin','supervisor') then raise exception 'Operations access required'; end if;
 if p_program='month' then prefix='MONTH30';percent=30;
 elsif p_program='year' then prefix='YEAR25';percent=25;
 else raise exception 'Select a monthly or yearly award program.';
 end if;
 for candidate in select * from public.get_delivery_coupon_award_candidates(p_program,p_period_start)
 loop
  code_value=prefix||'-'||to_char(p_period_start,'YYYYMM')||'-'||upper(substr(replace(candidate.customer_id::text,'-',''),1,8));
  insert into public.delivery_coupons(code,program,discount_percent,customer_id,period_start,
   requires_admin_approval,new_customer_only,max_redemptions,expires_at,created_by)
  values(code_value,p_program,percent,candidate.customer_id,p_period_start,false,false,1,expiry,auth.uid())
  on conflict(program,period_start,customer_id) where program in ('month','year') do nothing;
 end loop;
 return query
 select c.customer_id,p.full_name,p.email,c.code,c.discount_percent,c.expires_at
 from public.delivery_coupons c join public.profiles p on p.id=c.customer_id
 where c.program=p_program and c.period_start=p_period_start
 order by c.created_at;
end;
$$;

create or replace function public.approve_delivery_quote(p_order_id uuid,p_price numeric,p_admin_note text default null)
returns public.orders
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
 order_row public.orders;
 quote_row public.delivery_quote_reviews;
 claim_row public.delivery_coupon_claims;
 chargeable_price numeric(12,2);
 coupon_discount_amount numeric(12,2):=0;
begin
 if public.current_user_role() not in ('admin','supervisor') then raise exception 'Operations access required'; end if;
 select * into quote_row from public.delivery_quote_reviews where order_id=p_order_id for update;
 if quote_row.order_id is null or quote_row.status<>'pending_admin_review' or quote_row.expires_at<=now() then
  raise exception 'This delivery quote is no longer awaiting review';
 end if;
 select * into claim_row from public.delivery_coupon_claims where order_id=p_order_id for update;
 if claim_row.id is not null and claim_row.status='approved' then
  coupon_discount_amount=round(p_price*claim_row.discount_percent/100,0);
  chargeable_price=greatest(1,p_price-coupon_discount_amount);
 else
  chargeable_price=p_price;
 end if;
 order_row:=public.set_order_price(p_order_id,chargeable_price);
 update public.delivery_quote_reviews
 set pre_discount_price=p_price,approved_price=chargeable_price,
  admin_note=nullif(left(trim(coalesce(p_admin_note,'')),1000),'')
 where order_id=p_order_id;
 if claim_row.id is not null then
  update public.delivery_coupon_claims
  set original_price=p_price,discount_amount=case when status='approved' then coupon_discount_amount else 0 end,
   payable_amount=chargeable_price,updated_at=now()
  where id=claim_row.id;
 end if;
 return order_row;
end;
$$;

create or replace function public.prepare_approved_delivery_quote_payment(p_order_id uuid,p_customer_id uuid)
returns boolean
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
 order_row public.orders;
 quote_row public.delivery_quote_reviews;
 claim_row public.delivery_coupon_claims;
begin
 if p_order_id is null or p_customer_id is null then return false; end if;
 select * into order_row from public.orders where id=p_order_id for update;
 if order_row.id is null or order_row.customer_id<>p_customer_id
  or order_row.payment_status<>'unpaid' or order_row.status not in ('approved','awaiting_payment') then return false; end if;
 select * into quote_row from public.delivery_quote_reviews
  where order_id=p_order_id and customer_id=p_customer_id for update;
 if quote_row.order_id is null or quote_row.status<>'approved' or quote_row.approved_price is null
  or quote_row.approved_price<=0 or quote_row.approved_price<>order_row.final_price
  or quote_row.expires_at is null or quote_row.expires_at<=now() then return false; end if;
 select * into claim_row from public.delivery_coupon_claims where order_id=p_order_id for update;
 if claim_row.id is not null and claim_row.status not in ('approved','redeemed','rejected') then return false; end if;
 if order_row.status='awaiting_payment' then
  update public.orders set status='approved'
  where id=p_order_id and customer_id=p_customer_id and status='awaiting_payment' and payment_status='unpaid';
  if not found then return false; end if;
 end if;
 return true;
end;
$$;

create or replace function public.mark_delivery_coupon_redeemed()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
begin
 if new.payment_status='paid' and old.payment_status is distinct from new.payment_status then
  update public.delivery_coupon_claims
   set status='redeemed',redeemed_at=now(),updated_at=now()
   where order_id=new.id and status='approved';
 end if;
 return new;
end;
$$;

drop trigger if exists orders_mark_delivery_coupon_redeemed on public.orders;
create trigger orders_mark_delivery_coupon_redeemed
 after update of payment_status on public.orders
 for each row when(new.payment_status='paid')
 execute function public.mark_delivery_coupon_redeemed();

revoke all on function public.reserve_delivery_coupon(uuid,text) from public,anon,authenticated;
revoke all on function public.attach_delivery_coupon(uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.release_delivery_coupon_reservation(uuid) from public,anon,authenticated;
grant execute on function public.reserve_delivery_coupon(uuid,text) to service_role;
grant execute on function public.attach_delivery_coupon(uuid,uuid,uuid) to service_role;
grant execute on function public.release_delivery_coupon_reservation(uuid) to service_role;

revoke all on function public.review_delivery_coupon_claim(uuid,boolean) from public,anon;
revoke all on function public.get_admin_delivery_coupon_records() from public,anon;
revoke all on function public.get_delivery_coupon_award_candidates(text,date) from public,anon;
revoke all on function public.award_delivery_coupons(text,date) from public,anon;
revoke all on function public.approve_delivery_quote(uuid,numeric,text) from public,anon;
revoke all on function public.prepare_approved_delivery_quote_payment(uuid,uuid) from public,anon,authenticated;
grant execute on function public.review_delivery_coupon_claim(uuid,boolean) to authenticated;
grant execute on function public.get_admin_delivery_coupon_records() to authenticated;
grant execute on function public.get_delivery_coupon_award_candidates(text,date) to authenticated;
grant execute on function public.award_delivery_coupons(text,date) to authenticated;
grant execute on function public.approve_delivery_quote(uuid,numeric,text) to authenticated;
grant execute on function public.prepare_approved_delivery_quote_payment(uuid,uuid) to service_role;

notify pgrst,'reload schema';
