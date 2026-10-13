create table if not exists public.rider_wallet_ledger(
 id uuid primary key default gen_random_uuid(),
 rider_id uuid not null references public.profiles(id) on delete restrict,
 entry_type text not null check(entry_type in ('delivery_earning','cashback')),
 amount numeric(12,2) not null check(amount>0),
 source_order_id uuid references public.orders(id) on delete restrict,
 milestone_number integer,
 available_at timestamptz not null default now(),
 created_at timestamptz not null default now(),
 constraint rider_wallet_entry_source_check check(
  (entry_type='delivery_earning' and source_order_id is not null and milestone_number is null)
  or (entry_type='cashback' and source_order_id is null and milestone_number is not null and milestone_number>0)
 )
);

create unique index if not exists rider_wallet_earning_order_uidx
 on public.rider_wallet_ledger(source_order_id)
 where entry_type='delivery_earning';
create unique index if not exists rider_wallet_cashback_milestone_uidx
 on public.rider_wallet_ledger(rider_id,milestone_number)
 where entry_type='cashback';
create index if not exists rider_wallet_ledger_rider_available_idx
 on public.rider_wallet_ledger(rider_id,available_at,created_at desc);

create table if not exists public.rider_payout_accounts(
 rider_id uuid primary key references public.profiles(id) on delete restrict,
 bank_code text not null,
 bank_name text not null,
 account_name text not null,
 account_number text not null check(account_number ~ '^[0-9]{10}$'),
 recipient_code text not null unique,
 updated_at timestamptz not null default now()
);

create table if not exists public.rider_wallet_withdrawals(
 id uuid primary key default gen_random_uuid(),
 rider_id uuid not null references public.profiles(id) on delete restrict,
 amount numeric(12,2) not null check(amount>0),
 currency text not null default 'NGN' check(currency='NGN'),
 status text not null default 'pending'
  check(status in ('pending','processing','otp_required','success','failed','reversed')),
 reference text not null unique,
 transfer_code text,
 status_message text,
 requested_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);

create index if not exists rider_wallet_withdrawals_rider_date_idx
 on public.rider_wallet_withdrawals(rider_id,requested_at desc);

alter table public.rider_wallet_ledger enable row level security;
alter table public.rider_payout_accounts enable row level security;
alter table public.rider_wallet_withdrawals enable row level security;

create or replace function public.record_rider_wallet_completion()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
declare
 earning_id uuid;
 completed_count integer;
 batch_earnings numeric(12,2);
begin
 if new.status<>'completed' or new.payment_status<>'paid' or new.rider_id is null or new.final_price<=0 then
  return new;
 end if;

 perform 1 from public.profiles where id=new.rider_id for update;
 if not found then
  raise exception 'The rider profile required for wallet credit is missing.';
 end if;

 insert into public.rider_wallet_ledger(rider_id,entry_type,amount,source_order_id)
 values(new.rider_id,'delivery_earning',round(new.final_price*0.30,2),new.id)
 on conflict do nothing
 returning id into earning_id;

 if earning_id is null then return new; end if;

 select count(*) into completed_count
 from public.rider_wallet_ledger
 where rider_id=new.rider_id and entry_type='delivery_earning';

 if completed_count>0 and completed_count%5=0 then
  select round(coalesce(sum(batch.amount),0),2) into batch_earnings
  from (
   select amount
   from public.rider_wallet_ledger
   where rider_id=new.rider_id and entry_type='delivery_earning'
   order by created_at desc,id desc
   limit 5
  ) as batch;

  insert into public.rider_wallet_ledger(
   rider_id,entry_type,amount,milestone_number,available_at
  )
  values(
   new.rider_id,
   'cashback',
   round(batch_earnings*0.10,2),
   completed_count/5,
   date_trunc('month',now())+interval '1 month'
  )
  on conflict do nothing;
 end if;

 return new;
end;
$$;

drop trigger if exists orders_record_rider_wallet_completion on public.orders;
create trigger orders_record_rider_wallet_completion
after update of status,payment_status,rider_id,final_price on public.orders
for each row
when(new.status='completed' and new.payment_status='paid' and new.rider_id is not null)
execute function public.record_rider_wallet_completion();

create or replace function public.reserve_rider_wallet_withdrawal(
 p_rider_id uuid,
 p_amount numeric,
 p_reference text
)
returns public.rider_wallet_withdrawals
language plpgsql
security definer
set search_path=public
as $$
declare
 result public.rider_wallet_withdrawals;
 wallet_available numeric(12,2);
 reserved_amount numeric(12,2);
begin
 if p_amount is null or p_amount<=0 or p_amount<>round(p_amount,2) then
  raise exception 'Enter a positive withdrawal amount with no more than two decimal places.';
 end if;
 if p_reference is null or length(btrim(p_reference))<8 then
  raise exception 'A valid Paystack withdrawal reference is required.';
 end if;
 if not exists(select 1 from public.profiles where id=p_rider_id and role='rider') then
  raise exception 'Only rider accounts can withdraw rider-wallet funds.';
 end if;
 perform 1 from public.rider_payout_accounts where rider_id=p_rider_id for update;
 if not found then raise exception 'Add and verify a payout bank account before withdrawing.'; end if;

 select coalesce(sum(amount),0) into wallet_available
 from public.rider_wallet_ledger
 where rider_id=p_rider_id and available_at<=now();
 select coalesce(sum(amount),0) into reserved_amount
 from public.rider_wallet_withdrawals
 where rider_id=p_rider_id and status in ('pending','processing','otp_required','success');
 if p_amount>wallet_available-reserved_amount then
  raise exception 'Withdrawal amount exceeds your available rider-wallet balance.';
 end if;

 insert into public.rider_wallet_withdrawals(rider_id,amount,reference)
 values(p_rider_id,round(p_amount,2),btrim(p_reference))
 returning * into result;
 return result;
end;
$$;

create or replace function public.set_rider_wallet_withdrawal_status(
 p_reference text,
 p_status text,
 p_transfer_code text default null,
 p_status_message text default null
)
returns boolean
language plpgsql
security definer
set search_path=public
as $$
declare
 current_status text;
 next_status text;
begin
 if p_status is null or p_status not in ('pending','processing','otp_required','success','failed','reversed') then
  raise exception 'Invalid Paystack transfer status.';
 end if;

 select status into current_status
 from public.rider_wallet_withdrawals
 where reference=p_reference
 for update;
 if not found then return false; end if;

 next_status:=p_status;
 if current_status in ('success','failed','reversed') then
  if current_status='success' and p_status='reversed' then
   next_status:='reversed';
  else
   next_status:=current_status;
  end if;
 elsif current_status='processing' and p_status in ('pending','otp_required') then
  next_status:='processing';
 elsif current_status='otp_required' and p_status='pending' then
  next_status:='otp_required';
 end if;

 update public.rider_wallet_withdrawals
 set status=next_status,
     transfer_code=coalesce(p_transfer_code,transfer_code),
     status_message=case when next_status=p_status
      then coalesce(left(nullif(btrim(p_status_message),''),500),status_message)
      else status_message
     end,
     updated_at=now()
 where reference=p_reference;
 return found;
end;
$$;

create or replace function public.get_rider_wallet_snapshot(p_rider_id uuid)
returns jsonb
language sql
stable
security definer
set search_path=public
as $$
 with credits as (
  select
   coalesce(sum(amount) filter(where available_at<=now()),0) as released,
   coalesce(sum(amount) filter(where entry_type='cashback' and available_at>now()),0) as pending_cashback,
   coalesce(sum(amount) filter(
    where entry_type='delivery_earning'
      and created_at>=date_trunc('month',now())
   ),0) as month_earnings,
   coalesce(sum(amount) filter(where entry_type='delivery_earning'),0) as lifetime_earnings,
   count(*) filter(where entry_type='delivery_earning') as completed_deliveries
  from public.rider_wallet_ledger
  where rider_id=p_rider_id
 ),
 paid_or_reserved as (
  select coalesce(sum(amount),0) as total
  from public.rider_wallet_withdrawals
  where rider_id=p_rider_id and status in ('pending','processing','otp_required','success')
 ),
 recent_entries as (
  select jsonb_agg(to_jsonb(entry) order by entry.created_at desc) as rows
  from (
   select l.entry_type,l.amount,l.available_at,l.created_at,l.milestone_number,o.tracking_number
   from public.rider_wallet_ledger l
   left join public.orders o on o.id=l.source_order_id
   where l.rider_id=p_rider_id
   order by l.created_at desc
   limit 20
  ) entry
 ),
 recent_withdrawals as (
  select jsonb_agg(to_jsonb(withdrawal) order by withdrawal.requested_at desc) as rows
  from (
   select id,amount,status,reference,status_message,requested_at,updated_at
   from public.rider_wallet_withdrawals
   where rider_id=p_rider_id
   order by requested_at desc
   limit 20
  ) withdrawal
 )
 select jsonb_build_object(
  'availableBalance',greatest(0,credits.released-paid_or_reserved.total),
  'pendingCashback',credits.pending_cashback,
  'monthEarnings',credits.month_earnings,
  'lifetimeEarnings',credits.lifetime_earnings,
  'completedDeliveries',credits.completed_deliveries,
  'deliveriesToCashback',case when credits.completed_deliveries%5=0 then 5 else 5-(credits.completed_deliveries%5) end,
  'ledger',coalesce(recent_entries.rows,'[]'::jsonb),
  'withdrawals',coalesce(recent_withdrawals.rows,'[]'::jsonb)
 )
 from credits cross join paid_or_reserved cross join recent_entries cross join recent_withdrawals;
$$;

revoke all on function public.record_rider_wallet_completion() from public,anon,authenticated;
revoke all on function public.reserve_rider_wallet_withdrawal(uuid,numeric,text) from public,anon,authenticated;
revoke all on function public.set_rider_wallet_withdrawal_status(text,text,text,text) from public,anon,authenticated;
revoke all on function public.get_rider_wallet_snapshot(uuid) from public,anon,authenticated;
grant execute on function public.reserve_rider_wallet_withdrawal(uuid,numeric,text) to service_role;
grant execute on function public.set_rider_wallet_withdrawal_status(text,text,text,text) to service_role;
grant execute on function public.get_rider_wallet_snapshot(uuid) to service_role;

grant select,insert,update on public.rider_wallet_ledger to service_role;
grant select,insert,update,delete on public.rider_payout_accounts to service_role;
grant select,insert,update on public.rider_wallet_withdrawals to service_role;
