-- Read-only contract checks for migration 015. No Auth users, orders, or
-- payment records are created or modified.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders'
      and column_name = 'package_category' and is_nullable = 'YES'
  ) then
    raise exception 'The backward-compatible package_category column is missing or not nullable';
  end if;

  if to_regprocedure(
       'public.create_delivery_quote_with_category(uuid,text,double precision,double precision,text,double precision,double precision,text,text,text,numeric,numeric,numeric,numeric,text,text,text,numeric,numeric,numeric,boolean)'
     ) is null
     or to_regprocedure('public.set_delivery_quote_vehicle(uuid,text,text)') is null then
    raise exception 'A package category quote or vehicle review RPC is missing';
  end if;

  if position('package_category' in pg_get_function_result(
       'public.get_rider_available_orders()'::regprocedure
     )) = 0 then
    raise exception 'Rider offer RPC does not return the package category';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'delivery_quote_reviews'
      and column_name in ('vehicle_reviewed_at', 'vehicle_reviewed_by', 'vehicle_review_note')
    group by table_schema, table_name
    having count(*) = 3
  ) then
    raise exception 'Quote review does not retain vehicle verification and reason';
  end if;

  if position('pending_admin_review' in pg_get_functiondef(
       'public.create_delivery_quote(uuid,text,double precision,double precision,text,double precision,double precision,text,text,text,numeric,numeric,numeric,numeric,text,text,numeric,numeric,numeric,boolean)'::regprocedure
     )) = 0
     or position('unpaid' in pg_get_functiondef(
       'public.create_delivery_quote(uuid,text,double precision,double precision,text,double precision,double precision,text,text,text,numeric,numeric,numeric,numeric,text,text,numeric,numeric,numeric,boolean)'::regprocedure
     )) = 0 then
    raise exception 'New package quotes do not preserve the existing unpaid review gate';
  end if;

  if position('vehicle_reviewed_at is not null' in lower(pg_get_functiondef(
       'public.approve_delivery_quote(uuid,numeric,text)'::regprocedure
     ))) = 0 then
    raise exception 'A customer price can be approved without a recorded vehicle review';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders'
      and column_name in ('weight_kg', 'length_cm', 'width_cm', 'height_cm')
    group by table_schema, table_name
    having count(*) = 4
  ) then
    raise exception 'Legacy package measurement columns were unexpectedly removed';
  end if;

  if has_function_privilege(
       'authenticated',
       'public.create_delivery_quote_with_category(uuid,text,double precision,double precision,text,double precision,double precision,text,text,text,numeric,numeric,numeric,numeric,text,text,text,numeric,numeric,numeric,boolean)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.create_delivery_quote_with_category(uuid,text,double precision,double precision,text,double precision,double precision,text,text,text,numeric,numeric,numeric,numeric,text,text,text,numeric,numeric,numeric,boolean)',
       'EXECUTE'
     ) then
    raise exception 'Package quote RPC service-role permissions are incorrect';
  end if;

  if has_function_privilege('anon', 'public.set_delivery_quote_vehicle(uuid,text,text)', 'EXECUTE') then
    raise exception 'Anonymous users can change a quote vehicle';
  end if;
end
$$;
