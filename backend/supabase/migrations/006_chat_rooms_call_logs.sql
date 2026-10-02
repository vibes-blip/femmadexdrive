-- Safe to apply after the core schema whether these objects exist already or not.
-- Chat remains participant-only; call records are limited to assigned delivery participants.

create extension if not exists pgcrypto;

create table if not exists public.chat_rooms (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders(id) on delete cascade,
  customer_id uuid not null references public.profiles(id) on delete cascade,
  rider_id uuid references public.profiles(id) on delete set null,
  status text not null default 'active' check (status in ('active', 'closed')),
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

create table if not exists public.call_logs (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  caller_id uuid not null references public.profiles(id) on delete cascade,
  receiver_id uuid not null references public.profiles(id) on delete cascade,
  call_type text not null default 'phone' check (call_type in ('phone', 'voip')),
  status text not null default 'initiated' check (status in ('initiated', 'ringing', 'answered', 'missed', 'declined', 'failed', 'ended')),
  started_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),
  created_at timestamptz not null default now()
);

create index if not exists chat_rooms_order_idx on public.chat_rooms(order_id);
create index if not exists chat_rooms_customer_idx on public.chat_rooms(customer_id);
create index if not exists chat_rooms_rider_idx on public.chat_rooms(rider_id);
create index if not exists call_logs_order_idx on public.call_logs(order_id);
create index if not exists call_logs_caller_idx on public.call_logs(caller_id);
create index if not exists call_logs_receiver_idx on public.call_logs(receiver_id);
create index if not exists call_logs_created_idx on public.call_logs(created_at desc);

alter table public.chat_rooms enable row level security;
alter table public.call_logs enable row level security;

 drop policy if exists "chat_rooms_select_participants" on public.chat_rooms;
create policy "chat_rooms_select_participants" on public.chat_rooms
for select to authenticated
using (
  customer_id = auth.uid()
  or rider_id = auth.uid()
  or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role::text in ('admin', 'supervisor'))
);

drop policy if exists "chat_rooms_insert_participants" on public.chat_rooms;
create policy "chat_rooms_insert_participants" on public.chat_rooms
for insert to authenticated
with check (
  exists (
    select 1 from public.orders o
    where o.id = order_id
      and o.customer_id = customer_id
      and o.rider_id is not distinct from chat_rooms.rider_id
      and (o.customer_id = auth.uid() or exists (
        select 1 from public.profiles p where p.id = auth.uid() and p.role::text in ('admin', 'supervisor')
      ))
  )
);

-- Room membership and order linkage are managed only by the checked RPC below.
drop policy if exists "chat_rooms_update_participants" on public.chat_rooms;
revoke update on public.chat_rooms from anon, authenticated;

drop policy if exists "call_logs_select_participants" on public.call_logs;
create policy "call_logs_select_participants" on public.call_logs
for select to authenticated
using (
  caller_id = auth.uid()
  or receiver_id = auth.uid()
  or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role::text in ('admin', 'supervisor'))
);

drop policy if exists "call_logs_insert_caller" on public.call_logs;
create policy "call_logs_insert_caller" on public.call_logs
for insert to authenticated
with check (
  caller_id = auth.uid()
  and exists (
    select 1 from public.orders o
    where o.id = order_id
      and ((o.customer_id = auth.uid() and o.rider_id = receiver_id)
        or (o.rider_id = auth.uid() and o.customer_id = receiver_id))
  )
);

drop policy if exists "call_logs_update_participants" on public.call_logs;
revoke update on public.call_logs from anon, authenticated;
grant update (status, answered_at, ended_at, duration_seconds) on public.call_logs to authenticated;
create policy "call_logs_update_participants" on public.call_logs
for update to authenticated
using (
  caller_id = auth.uid()
  or receiver_id = auth.uid()
  or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role::text in ('admin', 'supervisor'))
)
with check (
  caller_id = auth.uid()
  or receiver_id = auth.uid()
  or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role::text in ('admin', 'supervisor'))
);

create or replace function public.ensure_order_chat_room(p_order_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_room_id uuid;
  v_customer_id uuid;
  v_rider_id uuid;
begin
  select o.customer_id, o.rider_id
    into v_customer_id, v_rider_id
  from public.orders o
  where o.id = p_order_id;

  if not found then raise exception 'Order not found'; end if;
  if auth.uid() is null or not (
    auth.uid() = v_customer_id
    or auth.uid() = v_rider_id
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role::text in ('admin', 'supervisor'))
  ) then
    raise exception 'Delivery participant access required';
  end if;

  insert into public.chat_rooms(order_id, customer_id, rider_id)
  values (p_order_id, v_customer_id, v_rider_id)
  on conflict (order_id) do update
    set customer_id = excluded.customer_id,
        rider_id = excluded.rider_id
  returning id into v_room_id;

  return v_room_id;
end;
$$;

revoke all on function public.ensure_order_chat_room(uuid) from public, anon, authenticated;
grant execute on function public.ensure_order_chat_room(uuid) to authenticated;

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'chat_rooms') then
    alter publication supabase_realtime add table public.chat_rooms;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'call_logs') then
    alter publication supabase_realtime add table public.call_logs;
  end if;
end
$$;
