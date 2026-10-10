-- Read-only contract checks for migration 014. Run after migrations 001-014.
-- This deliberately creates no Auth users, orders, payments, or rider records.
do $$
begin
  if not public.vehicle_compatible('motorcycle', 'motorcycle')
     or not public.vehicle_compatible('bike', 'motorcycle')
     or public.vehicle_compatible('car', 'motorcycle')
     or public.vehicle_compatible('truck', 'motorcycle') then
    raise exception 'Motorcycle compatibility matrix is incorrect';
  end if;

  if not public.vehicle_compatible('car', 'car')
     or public.vehicle_compatible('truck', 'car')
     or public.vehicle_compatible('motorcycle', 'car') then
    raise exception 'Car compatibility matrix is incorrect';
  end if;

  if not public.vehicle_compatible('truck', 'truck')
     or not public.vehicle_compatible('lorry', 'truck')
     or public.vehicle_compatible('car', 'truck')
     or public.vehicle_compatible('motorcycle', 'truck') then
    raise exception 'Truck compatibility matrix is incorrect';
  end if;

  if not public.vehicle_compatible('van', 'van')
     or public.vehicle_compatible('truck', 'van') then
    raise exception 'Legacy van compatibility was not preserved explicitly';
  end if;

  if to_regprocedure('public.get_rider_available_orders()') is null
     or to_regprocedure('public.accept_order(uuid)') is null
     or to_regprocedure('public.decline_order(uuid,text)') is null
     or to_regprocedure('public.admin_assign_order(uuid,uuid,text)') is null
     or to_regprocedure('public.return_order_to_rider_pool(uuid,text,boolean,text)') is null then
    raise exception 'A required dispatch RPC is missing';
  end if;

  if to_regclass('public.orders_one_active_delivery_per_rider_idx') is null then
    raise exception 'The one-active-delivery database safeguard is missing';
  end if;

  if not (select relrowsecurity from pg_class where oid='public.rider_offers'::regclass)
     or not (select relrowsecurity from pg_class where oid='public.dispatch_alerts'::regclass)
     or not (select relrowsecurity from pg_class where oid='public.order_assignment_history'::regclass)
     or not (select relrowsecurity from pg_class where oid='public.rider_admin_events'::regclass) then
    raise exception 'Dispatch RLS is not enabled';
  end if;

  if has_function_privilege('anon', 'public.accept_order(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.admin_assign_order(uuid,uuid,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.return_order_to_rider_pool(uuid,text,boolean,text)', 'EXECUTE') then
    raise exception 'An anonymous role can execute a protected dispatch RPC';
  end if;

  if not has_function_privilege('authenticated', 'public.accept_order(uuid)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.get_rider_available_orders()', 'EXECUTE') then
    raise exception 'Authenticated rider dispatch RPCs are not granted';
  end if;
end
$$;
