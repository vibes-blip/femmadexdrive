-- Let Operations take ownership of any open customer-care conversation.
-- Customer-care agents still only accept requests explicitly sent to a human.
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
      human_requested_at = coalesce(human_requested_at, now()),
      status = 'active',
      needs_attention = false,
      updated_at = now()
  where id = p_conversation_id
    and support_status = 'waiting'
    and status <> 'closed'
    and (role_name in ('admin', 'supervisor') or human_requested_at is not null)
  returning * into conversation;
  if conversation.id is null then
    raise exception 'This conversation is already assigned, closed, or not waiting';
  end if;
  return conversation;
end
$$;

notify pgrst, 'reload schema';
