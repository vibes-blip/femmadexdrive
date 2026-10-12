-- Persistent, manually accepted customer-care requests and one-minute attention escalation.

alter table public.support_conversations
  add column if not exists support_status text not null default 'waiting',
  add column if not exists handled_by uuid references public.profiles(id) on delete set null,
  add column if not exists human_requested_at timestamptz,
  add column if not exists human_response_at timestamptz,
  add column if not exists escalation_claimed_at timestamptz,
  add column if not exists attention_notified_at timestamptz,
  add column if not exists needs_attention boolean not null default false,
  add column if not exists resolved_at timestamptz;

alter table public.support_conversations
  drop constraint if exists support_conversations_support_status_check;
alter table public.support_conversations
  add constraint support_conversations_support_status_check
    check (support_status in ('waiting', 'assigned', 'responded', 'resolved'));

update public.support_conversations
set support_status = case
      when status = 'closed' then 'resolved'
      when assigned_agent_id is not null then 'assigned'
      else 'waiting'
    end,
    handled_by = coalesce(handled_by, assigned_agent_id)
where support_status = 'waiting'
  and handled_by is null
  and human_requested_at is null;

create index if not exists support_conversations_attention_idx
  on public.support_conversations(human_requested_at)
  where human_requested_at is not null
    and human_response_at is null
    and attention_notified_at is null;

drop policy if exists support_conversations_select on public.support_conversations;
create policy support_conversations_select on public.support_conversations
for select to authenticated
using (
  customer_id = (select auth.uid())
  or handled_by = (select auth.uid())
  or assigned_agent_id = (select auth.uid())
  or (
    support_status = 'waiting'
    and human_requested_at is not null
    and public.current_user_role() = 'customer_care'
    and exists (
      select 1 from public.customer_care_agents a
      where a.id = (select auth.uid()) and a.status = 'approved' and a.is_available
    )
  )
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
        or c.handled_by = (select auth.uid())
        or c.assigned_agent_id = (select auth.uid())
        or (
          c.support_status = 'waiting'
          and c.human_requested_at is not null
          and public.current_user_role() = 'customer_care'
          and exists (
            select 1 from public.customer_care_agents a
            where a.id = (select auth.uid()) and a.status = 'approved' and a.is_available
          )
        )
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
    where c.id = conversation_id
      and c.support_status in ('assigned', 'responded')
      and (
        (sender_type = 'customer' and c.customer_id = (select auth.uid()))
        or (
          sender_type = 'agent'
          and c.handled_by = (select auth.uid())
          and (
            public.current_user_role() in ('admin', 'supervisor')
            or exists (
              select 1 from public.customer_care_agents a
              where a.id = (select auth.uid()) and a.status = 'approved'
            )
          )
        )
      )
  )
);

create or replace function public.create_support_conversation()
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare conversation_id uuid;
begin
  if auth.uid() is null or public.current_user_role() <> 'customer' then
    raise exception 'A signed-in customer account is required';
  end if;

  insert into public.support_conversations(customer_id, assigned_agent_id, status, support_status)
  values (auth.uid(), null, 'ai', 'waiting')
  returning id into conversation_id;
  return conversation_id;
end
$$;

create or replace function public.request_support_human(p_conversation_id uuid)
returns public.support_conversations
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare conversation public.support_conversations;
begin
  if auth.uid() is null or public.current_user_role() <> 'customer' then
    raise exception 'A signed-in customer account is required';
  end if;

  select * into conversation
  from public.support_conversations
  where id = p_conversation_id and customer_id = auth.uid()
  for update;
  if conversation.id is null or conversation.support_status = 'resolved' then
    raise exception 'An open support conversation was not found';
  end if;
  if conversation.human_requested_at is null then
    update public.support_conversations
    set support_status = 'waiting',
        human_requested_at = now(),
        human_response_at = null,
        escalation_claimed_at = null,
        attention_notified_at = null,
        needs_attention = false,
        resolved_at = null,
        handled_by = null,
        assigned_agent_id = null,
        status = 'ai',
        updated_at = now()
    where id = p_conversation_id
    returning * into conversation;
  end if;
  return conversation;
end
$$;

create or replace function public.accept_support_conversation(p_conversation_id uuid)
returns public.support_conversations
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  conversation public.support_conversations;
  role_name text;
begin
  role_name := public.current_user_role()::text;
  if role_name not in ('admin', 'supervisor', 'customer_care') then
    raise exception 'Customer-care access required';
  end if;
  if role_name = 'customer_care' and not exists (
    select 1 from public.customer_care_agents a
    where a.id = auth.uid() and a.status = 'approved' and a.is_available
  ) then
    raise exception 'An approved, available customer-care account is required';
  end if;

  update public.support_conversations
  set handled_by = auth.uid(),
      assigned_agent_id = case when role_name = 'customer_care' then auth.uid() else null end,
      support_status = 'assigned',
      status = 'active',
      needs_attention = false,
      updated_at = now()
  where id = p_conversation_id
    and support_status = 'waiting'
    and human_requested_at is not null
  returning * into conversation;
  if conversation.id is null then
    raise exception 'This request is already assigned or no longer waiting';
  end if;
  return conversation;
end
$$;

create or replace function public.resolve_support_conversation(p_conversation_id uuid)
returns public.support_conversations
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare conversation public.support_conversations;
begin
  if public.current_user_role() not in ('admin', 'supervisor', 'customer_care') then
    raise exception 'Customer-care access required';
  end if;
  update public.support_conversations
  set support_status = 'resolved',
      status = 'closed',
      resolved_at = now(),
      needs_attention = false,
      updated_at = now()
  where id = p_conversation_id
    and (handled_by = auth.uid() or public.current_user_role() in ('admin', 'supervisor'));
  if not found then
    raise exception 'Only the assigned handler or Operations can resolve this request';
  end if;
  select * into conversation from public.support_conversations where id = p_conversation_id;
  return conversation;
end
$$;

create or replace function public.mark_support_human_response()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.sender_type = 'agent' then
    update public.support_conversations
    set support_status = 'responded',
        human_response_at = coalesce(human_response_at, new.created_at),
        needs_attention = false,
        updated_at = new.created_at
    where id = new.conversation_id
      and support_status in ('assigned', 'responded');
  end if;
  return new;
end
$$;

drop trigger if exists support_messages_mark_human_response on public.support_messages;
create trigger support_messages_mark_human_response
after insert on public.support_messages
for each row execute function public.mark_support_human_response();

revoke all on function public.create_support_conversation() from public, anon;
revoke all on function public.request_support_human(uuid) from public, anon;
revoke all on function public.accept_support_conversation(uuid) from public, anon;
revoke all on function public.resolve_support_conversation(uuid) from public, anon;
grant execute on function public.create_support_conversation() to authenticated;
grant execute on function public.request_support_human(uuid) to authenticated;
grant execute on function public.accept_support_conversation(uuid) to authenticated;
grant execute on function public.resolve_support_conversation(uuid) to authenticated;
