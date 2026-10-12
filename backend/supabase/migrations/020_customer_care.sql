-- Approved customer-care accounts and private AI/human support conversations.

alter type public.user_role add value if not exists 'customer_care';

create table if not exists public.customer_care_agents (
  id uuid primary key references public.profiles(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'suspended')),
  is_available boolean not null default false,
  last_assigned_at timestamptz,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  approved_by uuid references public.profiles(id)
);

create table if not exists public.support_conversations (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.profiles(id) on delete cascade,
  assigned_agent_id uuid references public.customer_care_agents(id) on delete set null,
  status text not null default 'ai' check (status in ('ai', 'active', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.support_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.support_conversations(id) on delete cascade,
  sender_id uuid references public.profiles(id) on delete set null,
  sender_type text not null check (sender_type in ('customer', 'agent', 'ai')),
  body text not null check (char_length(trim(body)) between 1 and 2000),
  created_at timestamptz not null default now()
);

create or replace function public.touch_support_conversation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.support_conversations
  set updated_at = now()
  where id = new.conversation_id;
  return new;
end
$$;

drop trigger if exists support_messages_touch_conversation on public.support_messages;
create trigger support_messages_touch_conversation
after insert on public.support_messages
for each row execute function public.touch_support_conversation();

create index if not exists customer_care_agents_available_idx
  on public.customer_care_agents(status, is_available, last_assigned_at);
create index if not exists support_conversations_customer_idx
  on public.support_conversations(customer_id, updated_at desc);
create index if not exists support_conversations_agent_idx
  on public.support_conversations(assigned_agent_id, updated_at desc)
  where assigned_agent_id is not null;
create index if not exists support_messages_conversation_idx
  on public.support_messages(conversation_id, created_at);

alter table public.customer_care_agents enable row level security;
alter table public.support_conversations enable row level security;
alter table public.support_messages enable row level security;

revoke all on public.customer_care_agents from public, anon, authenticated;
grant select on public.customer_care_agents to authenticated;
revoke all on public.support_conversations from public, anon, authenticated;
grant select on public.support_conversations to authenticated;
revoke all on public.support_messages from public, anon, authenticated;
grant select, insert on public.support_messages to authenticated;
grant all on public.customer_care_agents, public.support_conversations, public.support_messages to service_role;

drop policy if exists customer_care_agents_select on public.customer_care_agents;
create policy customer_care_agents_select on public.customer_care_agents
for select to authenticated
using (
  id = (select auth.uid())
  or public.current_user_role() in ('admin', 'supervisor')
);

drop policy if exists support_conversations_select on public.support_conversations;
create policy support_conversations_select on public.support_conversations
for select to authenticated
using (
  customer_id = (select auth.uid())
  or assigned_agent_id = (select auth.uid())
  or public.current_user_role() in ('admin', 'supervisor')
);

drop policy if exists support_messages_select on public.support_messages;
create policy support_messages_select on public.support_messages
for select to authenticated
using (
  exists (
    select 1 from public.support_conversations c
    where c.id = conversation_id
      and (
        c.customer_id = (select auth.uid())
        or c.assigned_agent_id = (select auth.uid())
        or public.current_user_role() in ('admin', 'supervisor')
      )
  )
);

drop policy if exists support_messages_insert on public.support_messages;
create policy support_messages_insert on public.support_messages
for insert to authenticated
with check (
  sender_id = (select auth.uid())
  and char_length(trim(body)) between 1 and 2000
  and exists (
    select 1 from public.support_conversations c
    where c.id = conversation_id and c.status = 'active'
      and (
        (sender_type = 'customer' and c.customer_id = (select auth.uid()))
        or (
          sender_type = 'agent'
          and c.assigned_agent_id = (select auth.uid())
          and exists (
            select 1 from public.customer_care_agents a
            where a.id = (select auth.uid()) and a.status = 'approved'
          )
        )
      )
  )
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare requested text;
begin
  requested := coalesce(new.raw_user_meta_data->>'requested_role', 'customer');
  if requested not in ('customer', 'rider', 'customer_care') then
    requested := 'customer';
  end if;

  insert into public.profiles(id, full_name, email, phone, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    new.email,
    new.raw_user_meta_data->>'phone',
    requested::public.user_role
  )
  on conflict (id) do nothing;

  if requested = 'rider' then
    insert into public.riders(id, display_name, phone, vehicle_type, vehicle_registration)
    values (
      new.id,
      coalesce(nullif(new.raw_user_meta_data->>'full_name', ''), 'Rider'),
      new.raw_user_meta_data->>'phone',
      new.raw_user_meta_data->>'vehicle_type',
      new.raw_user_meta_data->>'vehicle_registration'
    )
    on conflict (id) do nothing;
  elsif requested = 'customer_care' then
    insert into public.customer_care_agents(id)
    values (new.id)
    on conflict (id) do nothing;
  end if;
  return new;
end
$$;

create or replace function public.create_support_conversation()
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  agent_id uuid;
  conversation_id uuid;
begin
  if auth.uid() is null or public.current_user_role() <> 'customer' then
    raise exception 'A signed-in customer account is required';
  end if;

  select a.id into agent_id
  from public.customer_care_agents a
  where a.status = 'approved' and a.is_available
  order by a.last_assigned_at nulls first, a.created_at, a.id
  limit 1
  for update skip locked;

  insert into public.support_conversations(customer_id, assigned_agent_id, status)
  values (
    auth.uid(),
    agent_id,
    case when agent_id is null then 'ai' else 'active' end
  )
  returning id into conversation_id;

  if agent_id is not null then
    update public.customer_care_agents
    set last_assigned_at = now()
    where id = agent_id;
  end if;
  return conversation_id;
end
$$;

create or replace function public.set_customer_care_availability(p_is_available boolean)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare updated boolean;
begin
  update public.customer_care_agents
  set is_available = coalesce(p_is_available, false)
  where id = auth.uid() and status = 'approved'
  returning is_available into updated;
  if updated is null then
    raise exception 'An approved customer-care account is required';
  end if;
  return updated;
end
$$;

create or replace function public.approve_customer_care_agent(
  p_agent_id uuid,
  p_approved boolean
)
returns public.customer_care_agents
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare agent public.customer_care_agents;
begin
  if public.current_user_role() not in ('admin', 'supervisor') then
    raise exception 'Operations access required';
  end if;
  update public.customer_care_agents
  set status = case when p_approved then 'approved' else 'rejected' end,
      is_available = false,
      approved_at = case when p_approved then now() else null end,
      approved_by = auth.uid()
  where id = p_agent_id and status = 'pending'
  returning * into agent;
  if agent.id is null then
    raise exception 'Pending customer-care application not found';
  end if;
  return agent;
end
$$;

revoke all on function public.create_support_conversation() from public, anon;
revoke all on function public.set_customer_care_availability(boolean) from public, anon;
revoke all on function public.approve_customer_care_agent(uuid, boolean) from public, anon;
grant execute on function public.create_support_conversation() to authenticated;
grant execute on function public.set_customer_care_availability(boolean) to authenticated;
grant execute on function public.approve_customer_care_agent(uuid, boolean) to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'support_conversations'
  ) then
    alter publication supabase_realtime add table public.support_conversations;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'support_messages'
  ) then
    alter publication supabase_realtime add table public.support_messages;
  end if;
end
$$;
