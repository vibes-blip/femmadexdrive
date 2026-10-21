create or replace function public.apply_paystack_payment(
  p_reference text,
  p_status text,
  p_amount_minor bigint,
  p_currency text,
  p_fee_minor bigint,
  p_payment_method text,
  p_raw_response jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  payment_row public.payments;
  order_row public.orders;
begin
  if p_reference is null or length(trim(p_reference)) = 0 then
    return false;
  end if;

  select * into payment_row
  from public.payments
  where reference = p_reference
  for update;

  if payment_row.id is null then
    return false;
  end if;

  if payment_row.status = 'paid' then
    return true;
  end if;

  if lower(coalesce(p_status, '')) <> 'success'
     or coalesce(p_amount_minor, -1) <> round(payment_row.amount * 100)::bigint
     or upper(coalesce(p_currency, '')) <> upper(payment_row.currency) then
    update public.payments
    set status = 'failed', paystack_status = p_status,
        fee = coalesce(p_fee_minor, 0)::numeric / 100,
        payment_method = p_payment_method,
        raw_response = p_raw_response
    where id = payment_row.id;
    return false;
  end if;

  select * into order_row
  from public.orders
  where id = payment_row.order_id
  for update;

  if order_row.id is null
     or order_row.status not in ('awaiting_payment', 'approved')
     or order_row.payment_status <> 'unpaid' then
    update public.payments
    set status = 'failed', paystack_status = 'order_not_payable',
        raw_response = p_raw_response
    where id = payment_row.id;
    return false;
  end if;

  update public.orders
  set payment_status = 'paid', status = 'paid'
  where id = payment_row.order_id
    and status in ('awaiting_payment', 'approved')
    and payment_status = 'unpaid';

  if not found then
    return false;
  end if;

  update public.payments
  set status = 'paid', paystack_status = p_status,
      fee = coalesce(p_fee_minor, 0)::numeric / 100,
      payment_method = p_payment_method,
      paid_at = now(), raw_response = p_raw_response
  where id = payment_row.id;

  insert into public.order_events(order_id, actor_id, event, note)
  values (payment_row.order_id, payment_row.customer_id, 'payment_confirmed', 'Paystack payment confirmed');

  return true;
end
$$;

revoke all on function public.apply_paystack_payment(text, text, bigint, text, bigint, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.apply_paystack_payment(text, text, bigint, text, bigint, text, jsonb)
  to service_role;
