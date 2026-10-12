-- Record explicit customer acceptance of the dispatch terms for each quote.
-- Apply before deploying the frontend/backend changes that require this table.

create table if not exists public.delivery_terms_acceptances (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.profiles(id) on delete cascade,
  order_id uuid references public.orders(id) on delete set null,
  terms_version text not null,
  accepted_at timestamptz not null default now(),
  constraint delivery_terms_acceptances_version_nonempty check (length(trim(terms_version)) > 0)
);

create index if not exists delivery_terms_acceptances_customer_time_idx
  on public.delivery_terms_acceptances(customer_id, accepted_at desc);
create index if not exists delivery_terms_acceptances_order_idx
  on public.delivery_terms_acceptances(order_id)
  where order_id is not null;

alter table public.delivery_terms_acceptances enable row level security;
revoke all on public.delivery_terms_acceptances from public, anon, authenticated;
grant all on public.delivery_terms_acceptances to service_role;
