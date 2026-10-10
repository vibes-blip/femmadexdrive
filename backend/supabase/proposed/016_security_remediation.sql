-- PROPOSAL ONLY: do not apply until reviewed and approved.
-- Depends on migrations 001 through 015. Existing messages remain intact;
-- legacy messages without a provable assignment remain customer-readable.

do $$
begin
  if exists (select 1 from public.call_logs where status in ('ringing', 'answered')) then
    raise exception 'Wait for active voice calls to finish before applying assignment-scoped call rooms';
  end if;
end
$$;

create table if not exists public.public_tracking_rate_limits (
  key_hash text primary key check (key_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  expires_at timestamptz not null
);
create index if not exists public_tracking_rate_limits_expiry_idx
  on public.public_tracking_rate_limits(expires_at);
alter table public.public_tracking_rate_limits enable row level security;
revoke all on public.public_tracking_rate_limits from public, anon, authenticated;

create or replace function public.consume_public_tracking_rate_limit(
  p_key text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_count integer;
  current_window timestamptz := clock_timestamp();
begin
  if p_key is null or p_key !~ '^[0-9a-f]{64}$'
     or p_limit < 1 or p_limit > 1000
     or p_window_seconds < 1 or p_window_seconds > 3600 then
    raise exception 'Invalid rate-limit request';
  end if;

  insert into public.public_tracking_rate_limits(key_hash, window_started_at, request_count, expires_at)
  values (p_key, current_window, 1, current_window + make_interval(secs => p_window_seconds))
  on conflict (key_hash) do update
  set request_count = case
        when public.public_tracking_rate_limits.window_started_at
          <= current_window - make_interval(secs => p_window_seconds) then 1
        else public.public_tracking_rate_limits.request_count + 1
      end,
      window_started_at = case
        when public.public_tracking_rate_limits.window_started_at
          <= current_window - make_interval(secs => p_window_seconds) then current_window
        else public.public_tracking_rate_limits.window_started_at
      end,
      expires_at = current_window + make_interval(secs => p_window_seconds)
  returning request_count into current_count;

  return current_count <= p_limit;
end
$$;
revoke all on function public.consume_public_tracking_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_public_tracking_rate_limit(text, integer, integer) to service_role;

create or replace function public.prune_public_tracking_rate_limits()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  deleted_count integer;
begin
  delete from public.public_tracking_rate_limits
  where expires_at <= clock_timestamp() - interval '1 day';
  get diagnostics deleted_count = row_count;
  return deleted_count;
end
$$;
revoke all on function public.prune_public_tracking_rate_limits() from public, anon, authenticated;
grant execute on function public.prune_public_tracking_rate_limits() to service_role;

create table if not exists public.delivery_chat_assignments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  customer_id uuid not null references public.profiles(id),
  rider_id uuid not null references public.riders(id),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  check (ended_at is null or ended_at >= started_at)
);
create unique index if not exists delivery_chat_assignments_one_active_idx
  on public.delivery_chat_assignments(order_id) where ended_at is null;
create index if not exists delivery_chat_assignments_rider_idx
  on public.delivery_chat_assignments(rider_id, order_id, started_at desc);
alter table public.delivery_chat_assignments enable row level security;
revoke all on public.delivery_chat_assignments from public, anon, authenticated;
grant select on public.delivery_chat_assignments to authenticated;
drop policy if exists delivery_chat_assignments_select_participants on public.delivery_chat_assignments;
create policy delivery_chat_assignments_select_participants on public.delivery_chat_assignments
for select to authenticated
using (
  rider_id = (select auth.uid())
  or (customer_id = (select auth.uid()) and ended_at is null)
);

with assignment_timeline as (
  select h.order_id, h.new_rider_id, h.action, h.created_at, h.id,
         lead(h.created_at) over (partition by h.order_id order by h.created_at, h.id) as next_event_at
  from public.order_assignment_history h
  where h.action in ('assigned', 'reassigned', 'returned_to_pool', 'cancelled')
)
insert into public.delivery_chat_assignments(order_id, customer_id, rider_id, started_at, ended_at)
select history.order_id, o.customer_id, history.new_rider_id, history.created_at,
       coalesce(history.next_event_at,
         case when o.rider_id is distinct from history.new_rider_id then now() end)
from assignment_timeline history
join public.orders o on o.id = history.order_id
where history.action in ('assigned', 'reassigned')
  and history.new_rider_id is not null
  and not exists (
  select 1 from public.delivery_chat_assignments existing
  where existing.order_id = history.order_id
    and existing.rider_id = history.new_rider_id
    and existing.started_at = history.created_at
);

-- Start a fresh rider membership when existing assignment history cannot
-- establish a safe historical boundary. Legacy messages remain customer-readable.
insert into public.delivery_chat_assignments(order_id, customer_id, rider_id, started_at)
select o.id, o.customer_id, o.rider_id, now()
from public.orders o
where o.rider_id is not null
  and not exists (
    select 1 from public.delivery_chat_assignments a
    where a.order_id = o.id and a.ended_at is null
  );

alter table public.chat_messages
  add column if not exists assignment_id uuid references public.delivery_chat_assignments(id);
alter table public.chat_rooms
  add column if not exists assignment_id uuid references public.delivery_chat_assignments(id);
alter table public.chat_rooms drop constraint if exists chat_rooms_order_id_key;
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.chat_rooms'::regclass
      and conname = 'chat_rooms_order_assignment_key'
  ) then
    alter table public.chat_rooms
      add constraint chat_rooms_order_assignment_key unique (order_id, assignment_id);
  end if;
end
$$;

update public.chat_messages m
set assignment_id = (
  select membership.id
  from public.delivery_chat_assignments membership
  where membership.order_id = m.order_id
    and m.created_at >= membership.started_at
    and (membership.ended_at is null or m.created_at < membership.ended_at)
  order by membership.started_at desc
  limit 1
)
where m.assignment_id is null
  and exists (
    select 1 from public.delivery_chat_assignments membership
    where membership.order_id = m.order_id
      and m.created_at >= membership.started_at
      and (membership.ended_at is null or m.created_at < membership.ended_at)
  );

create or replace function public.sync_delivery_chat_assignment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.rider_id is not distinct from new.rider_id then return new; end if;

  update public.call_logs c
  set status = 'failed',
      ended_at = clock_timestamp(),
      duration_seconds = case
        when c.status = 'answered'
          then greatest(0, floor(extract(epoch from (clock_timestamp() - coalesce(c.answered_at, c.started_at))))::integer)
        else 0
      end
  where c.order_id = new.id
    and c.status in ('ringing', 'answered')
    and c.assignment_id in (
      select a.id from public.delivery_chat_assignments a
      where a.order_id = new.id and a.ended_at is null
    );

  update public.delivery_chat_assignments
  set ended_at = greatest(clock_timestamp(), started_at)
  where order_id = new.id and ended_at is null;

  if new.rider_id is not null then
    insert into public.delivery_chat_assignments(order_id, customer_id, rider_id, started_at)
    values (new.id, new.customer_id, new.rider_id, clock_timestamp());
  end if;
  return new;
end
$$;

drop trigger if exists orders_sync_delivery_chat_assignment on public.orders;
create trigger orders_sync_delivery_chat_assignment
after update of rider_id on public.orders
for each row execute function public.sync_delivery_chat_assignment();

create or replace function public.bind_chat_message_to_current_assignment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_assignment public.delivery_chat_assignments;
  order_customer uuid;
  order_status text;
begin
  select o.customer_id, o.status into order_customer, order_status
  from public.orders o where o.id = new.order_id;
  if not found then raise exception 'Delivery not found'; end if;

  select a.* into current_assignment
  from public.delivery_chat_assignments a
  where a.order_id = new.order_id and a.ended_at is null
  for share;

  if current_assignment.id is null then
    raise exception 'Chat is unavailable until a rider is assigned';
  end if;
  if new.assignment_id is not null and new.assignment_id <> current_assignment.id then
    raise exception 'Message must belong to the current delivery assignment';
  end if;
  if new.sender_id <> auth.uid()
     or (auth.uid() <> order_customer and auth.uid() <> current_assignment.rider_id) then
    raise exception 'Delivery participant access required';
  end if;
  if order_status in ('completed', 'cancelled') then
    raise exception 'Chat is closed for this delivery';
  end if;

  new.assignment_id := current_assignment.id;
  return new;
end
$$;

drop trigger if exists chat_messages_bind_assignment on public.chat_messages;
create trigger chat_messages_bind_assignment
before insert on public.chat_messages
for each row execute function public.bind_chat_message_to_current_assignment();

drop policy if exists chat_select on public.chat_messages;
drop policy if exists chat_insert on public.chat_messages;
drop policy if exists chat_messages_select_assignment on public.chat_messages;
drop policy if exists chat_messages_insert_current_assignment on public.chat_messages;
create policy chat_messages_select_assignment on public.chat_messages
for select to authenticated
using (
  exists (
    select 1 from public.orders o
    where o.id = chat_messages.order_id and o.customer_id = (select auth.uid())
  )
  or exists (
    select 1 from public.delivery_chat_assignments membership
    where membership.id = chat_messages.assignment_id
      and membership.order_id = chat_messages.order_id
      and membership.rider_id = (select auth.uid())
  )
);
create policy chat_messages_insert_current_assignment on public.chat_messages
for insert to authenticated
with check (
  sender_id = (select auth.uid())
  and assignment_id is not null
  and exists (
    select 1 from public.delivery_chat_assignments membership
    where membership.id = chat_messages.assignment_id
      and membership.order_id = chat_messages.order_id
      and membership.ended_at is null
      and (membership.customer_id = (select auth.uid()) or membership.rider_id = (select auth.uid()))
  )
);

drop policy if exists "chat_rooms_select_participants" on public.chat_rooms;
drop policy if exists chat_rooms_select_assignment_participants on public.chat_rooms;
drop policy if exists "chat_rooms_insert_participants" on public.chat_rooms;
revoke insert, update, delete on public.chat_rooms from public, anon, authenticated;
create policy chat_rooms_select_assignment_participants on public.chat_rooms
for select to authenticated
using (
  customer_id = (select auth.uid())
  or exists (
    select 1 from public.delivery_chat_assignments membership
    where membership.id = chat_rooms.assignment_id
      and membership.order_id = chat_rooms.order_id
      and membership.rider_id = (select auth.uid())
  )
);

create or replace function public.ensure_order_chat_room(p_order_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  room_id uuid;
  delivery public.orders;
  membership public.delivery_chat_assignments;
begin
  select o.* into delivery
  from public.orders o where o.id = p_order_id;
  if delivery.id is null then raise exception 'Delivery not found'; end if;
  if auth.uid() is null
     or (auth.uid() <> delivery.customer_id and auth.uid() <> delivery.rider_id) then
    raise exception 'Delivery participant access required';
  end if;
  select a.* into membership
  from public.delivery_chat_assignments a
  where a.order_id = p_order_id and a.rider_id = delivery.rider_id
    and a.ended_at is null;
  if membership.id is null then raise exception 'Current delivery chat is unavailable'; end if;

  insert into public.chat_rooms(order_id, assignment_id, customer_id, rider_id, status, closed_at)
  values (p_order_id, membership.id, delivery.customer_id, delivery.rider_id, 'active', null)
  on conflict (order_id, assignment_id) do update
    set status = 'active', closed_at = null
  returning id into room_id;
  return room_id;
end
$$;
revoke all on function public.ensure_order_chat_room(uuid) from public, anon;
grant execute on function public.ensure_order_chat_room(uuid) to authenticated;

create table if not exists public.delivery_staff_access (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  staff_id uuid not null references public.profiles(id),
  granted_by uuid not null references public.profiles(id),
  reason text not null check (length(trim(reason)) between 5 and 1000),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists delivery_staff_access_active_idx
  on public.delivery_staff_access(order_id, staff_id, expires_at)
  where revoked_at is null;

create table if not exists public.delivery_staff_access_audit (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  staff_id uuid not null references public.profiles(id),
  actor_id uuid not null references public.profiles(id),
  action text not null check (action in ('chat_access_granted', 'chat_access_revoked', 'chat_read')),
  reason text not null check (length(trim(reason)) between 5 and 1000),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.delivery_staff_access enable row level security;
alter table public.delivery_staff_access_audit enable row level security;
revoke all on public.delivery_staff_access from public, anon, authenticated;
revoke all on public.delivery_staff_access_audit from public, anon, authenticated;
grant select on public.delivery_staff_access_audit to authenticated;
drop policy if exists delivery_staff_access_audit_admin_select on public.delivery_staff_access_audit;
create policy delivery_staff_access_audit_admin_select on public.delivery_staff_access_audit
for select to authenticated
using (public.current_user_role() = 'admin');

create or replace function public.grant_delivery_chat_access(
  p_order_id uuid,
  p_staff_id uuid,
  p_reason text,
  p_expires_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  access_id uuid;
begin
  if public.current_user_role() is distinct from 'admin'
     or p_reason is null or length(trim(p_reason)) < 5
     or p_expires_at <= now() or p_expires_at > now() + interval '24 hours'
     or not exists (
       select 1 from public.profiles p
       where p.id = p_staff_id and p.role::text in ('admin', 'supervisor')
     ) then
    raise exception 'Authorized, time-limited delivery support access required';
  end if;

  insert into public.delivery_staff_access(order_id, staff_id, granted_by, reason, expires_at)
  values (p_order_id, p_staff_id, (select auth.uid()), trim(p_reason), p_expires_at)
  returning id into access_id;
  insert into public.delivery_staff_access_audit(order_id, staff_id, actor_id, action, reason, details)
  values (p_order_id, p_staff_id, (select auth.uid()), 'chat_access_granted', trim(p_reason),
          jsonb_build_object('access_id', access_id, 'expires_at', p_expires_at));
  return access_id;
end
$$;

create or replace function public.revoke_delivery_chat_access(p_access_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  access_row public.delivery_staff_access;
begin
  if public.current_user_role() is distinct from 'admin'
     or p_reason is null or length(trim(p_reason)) < 5 then
    raise exception 'Administrator access and a reason are required';
  end if;

  update public.delivery_staff_access
  set revoked_at = now()
  where id = p_access_id and revoked_at is null
  returning * into access_row;
  if access_row.id is null then raise exception 'Active support access not found'; end if;
  insert into public.delivery_staff_access_audit(order_id, staff_id, actor_id, action, reason, details)
  values (access_row.order_id, access_row.staff_id, (select auth.uid()),
          'chat_access_revoked', trim(p_reason), jsonb_build_object('access_id', p_access_id));
end
$$;

create or replace function public.get_delivery_chat_for_staff(p_order_id uuid, p_limit integer default 100)
returns setof public.chat_messages
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  access_reason text;
begin
  if p_limit is null or p_limit < 1 or p_limit > 200
     or public.current_user_role() is null
     or public.current_user_role() not in ('admin', 'supervisor') then
    raise exception 'Delivery support access required';
  end if;
  select a.reason into access_reason
  from public.delivery_staff_access a
  where a.order_id = p_order_id and a.staff_id = (select auth.uid())
    and a.revoked_at is null and a.expires_at > now()
  order by a.created_at desc limit 1;
  if access_reason is null then raise exception 'Delivery support access required'; end if;

  insert into public.delivery_staff_access_audit(order_id, staff_id, actor_id, action, reason)
  values (p_order_id, (select auth.uid()), (select auth.uid()), 'chat_read', access_reason);
  return query
  select m.* from public.chat_messages m
  where m.order_id = p_order_id
  order by m.created_at desc
  limit p_limit;
end
$$;
revoke all on function public.grant_delivery_chat_access(uuid, uuid, text, timestamptz) from public, anon;
revoke all on function public.revoke_delivery_chat_access(uuid, text) from public, anon;
revoke all on function public.get_delivery_chat_for_staff(uuid, integer) from public, anon;
grant execute on function public.grant_delivery_chat_access(uuid, uuid, text, timestamptz) to authenticated;
grant execute on function public.revoke_delivery_chat_access(uuid, text) to authenticated;
grant execute on function public.get_delivery_chat_for_staff(uuid, integer) to authenticated;

alter table public.call_logs
  add column if not exists assignment_id uuid references public.delivery_chat_assignments(id);

create or replace function public.validate_call_log_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  delivery public.orders;
  membership public.delivery_chat_assignments;
begin
  select o.* into delivery
  from public.orders o where o.id = new.order_id for update;
  select a.* into membership
  from public.delivery_chat_assignments a
  where a.id = new.assignment_id and a.order_id = new.order_id and a.ended_at is null;

  if delivery.id is null or membership.id is null
     or delivery.rider_id is distinct from membership.rider_id
     or new.status <> 'ringing'
     or new.call_type <> 'voip'
     or not (
       (new.caller_id = delivery.customer_id and new.receiver_id = delivery.rider_id)
       or (new.caller_id = delivery.rider_id and new.receiver_id = delivery.customer_id)
     ) then
    raise exception 'Call must be for a current delivery participant';
  end if;
  return new;
end
$$;
drop trigger if exists call_logs_validate_assignment on public.call_logs;
create trigger call_logs_validate_assignment
before insert on public.call_logs
for each row execute function public.validate_call_log_insert();

create or replace function public.prevent_call_log_tampering()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.id is distinct from old.id
     or new.order_id is distinct from old.order_id
     or new.assignment_id is distinct from old.assignment_id
     or new.caller_id is distinct from old.caller_id
     or new.receiver_id is distinct from old.receiver_id
     or new.call_type is distinct from old.call_type
     or new.started_at is distinct from old.started_at
     or new.created_at is distinct from old.created_at then
    raise exception 'Call identity fields are immutable';
  end if;
  if old.status <> 'ringing' or new.status <> 'answered' then
    if new.answered_at is distinct from old.answered_at then
      raise exception 'Call answer time is immutable after answer';
    end if;
  end if;

  if not (
    (old.status = 'ringing' and new.status in ('answered', 'declined', 'missed', 'failed', 'ended'))
    or (old.status = 'answered' and new.status in ('ended', 'failed'))
  ) then
    raise exception 'Invalid call status transition';
  end if;

  if new.status = 'answered'
     and (new.answered_at is null or new.ended_at is not null or new.duration_seconds is not null) then
    raise exception 'Invalid answered call fields';
  end if;
  if new.status in ('declined', 'missed', 'failed', 'ended')
     and (new.ended_at is null or coalesce(new.duration_seconds, -1) < 0) then
    raise exception 'Invalid ended call fields';
  end if;
  if old.status = 'ringing' and new.status in ('declined', 'missed', 'failed', 'ended')
     and new.duration_seconds <> 0 then
    raise exception 'Unanswered calls must have zero duration';
  end if;
  return new;
end
$$;
drop trigger if exists call_logs_prevent_tampering on public.call_logs;
create trigger call_logs_prevent_tampering
before update on public.call_logs
for each row execute function public.prevent_call_log_tampering();

drop policy if exists "call_logs_insert_caller" on public.call_logs;
drop policy if exists "call_logs_update_participants" on public.call_logs;
revoke insert, update, delete on public.call_logs from public, anon, authenticated;
revoke update (status, answered_at, ended_at, duration_seconds)
  on public.call_logs from public, anon, authenticated;
drop policy if exists "call_logs_select_participants" on public.call_logs;
create policy "call_logs_select_participants" on public.call_logs
for select to authenticated
using (
  exists (
    select 1 from public.orders o
    where o.id = call_logs.order_id and o.customer_id = (select auth.uid())
  )
  or exists (
    select 1 from public.delivery_chat_assignments membership
    where membership.id = call_logs.assignment_id
      and membership.order_id = call_logs.order_id
      and membership.rider_id = (select auth.uid())
      and membership.ended_at is null
  )
  or public.current_user_role() in ('admin', 'supervisor')
);

-- The current schema has no support role. This proposal does not add one;
-- support-agent provisioning and role-specific permissions require approval.
