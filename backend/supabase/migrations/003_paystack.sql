-- Paystack payment metadata. Payment secrets are never stored in Supabase.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='payments' and column_name='kora_status'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='payments' and column_name='paystack_status'
  ) then
    alter table public.payments rename column kora_status to paystack_status;
  end if;
end $$;

alter table public.payments add column if not exists paystack_status text;
create index if not exists payments_reference_idx on public.payments(reference);
