create or replace function public.prepare_approved_delivery_quote_payment(
  p_order_id uuid,
  p_customer_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  order_row public.orders;
  quote_row public.delivery_quote_reviews;
begin
  if p_order_id is null or p_customer_id is null then
    return false;
  end if;

  select * into order_row
  from public.orders
  where id = p_order_id
  for update;

  if order_row.id is null
     or order_row.customer_id <> p_customer_id
     or order_row.payment_status <> 'unpaid'
     or order_row.status not in ('approved', 'awaiting_payment') then
    return false;
  end if;

  select * into quote_row
  from public.delivery_quote_reviews
  where order_id = p_order_id
    and customer_id = p_customer_id
  for update;

  if quote_row.order_id is null
     or quote_row.status <> 'approved'
     or quote_row.approved_price is null
     or quote_row.approved_price <= 0
     or quote_row.approved_price <> order_row.final_price
     or quote_row.expires_at is null
     or quote_row.expires_at <= now() then
    return false;
  end if;

  if order_row.status = 'awaiting_payment' then
    update public.orders
    set status = 'approved'
    where id = p_order_id
      and customer_id = p_customer_id
      and status = 'awaiting_payment'
      and payment_status = 'unpaid';

    if not found then
      return false;
    end if;
  end if;

  return true;
end
$$;

revoke all on function public.prepare_approved_delivery_quote_payment(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.prepare_approved_delivery_quote_payment(uuid, uuid)
  to service_role;

notify pgrst, 'reload schema';
