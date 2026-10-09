-- Read rider contact fields from the riders table, not the profiles table.
create or replace function public.get_delivery_contacts(p_order_id uuid)
returns table(
  customer_name text,
  customer_phone text,
  rider_name text,
  rider_phone text
)
language plpgsql
security definer
set search_path=public
as $$
begin
  return query
  select cp.full_name,cp.phone,r.display_name,r.phone
  from public.orders o
  left join public.profiles cp on cp.id=o.customer_id
  left join public.riders r on r.id=o.rider_id
  where o.id=p_order_id
    and (
      o.customer_id=auth.uid()
      or o.rider_id=auth.uid()
      or public.current_user_role() in ('admin','supervisor')
    )
    and o.rider_id is not null;
end
$$;

revoke execute on function public.get_delivery_contacts(uuid) from public, anon;
grant execute on function public.get_delivery_contacts(uuid) to authenticated;

notify pgrst, 'reload schema';
