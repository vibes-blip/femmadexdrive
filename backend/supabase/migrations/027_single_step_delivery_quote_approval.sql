create or replace function public.approve_delivery_quote(
  p_order_id uuid,
  p_price numeric,
  p_admin_note text default null
)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  order_row public.orders;
begin
  if public.current_user_role() not in ('admin', 'supervisor') then
    raise exception 'Operations access required';
  end if;
  if not exists (
    select 1
    from public.delivery_quote_reviews q
    where q.order_id = p_order_id
      and q.status = 'pending_admin_review'
      and q.expires_at > now()
  ) then
    raise exception 'This delivery quote is no longer awaiting review';
  end if;

  order_row := public.set_order_price(p_order_id, p_price);
  update public.delivery_quote_reviews
  set admin_note = nullif(left(trim(coalesce(p_admin_note, '')), 1000), '')
  where order_id = p_order_id
    and status = 'approved';

  return order_row;
end
$$;

revoke execute on function public.approve_delivery_quote(uuid, numeric, text) from public, anon;
grant execute on function public.approve_delivery_quote(uuid, numeric, text) to authenticated;

notify pgrst, 'reload schema';
