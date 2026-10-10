-- Read-only check of the core FEMADEXDRIVE schema.
-- Run after applying migrations 001 through 015 in order.
with expected_objects (kind, object_name) as (
  values
    ('type', 'user_role'),
    ('type', 'rider_approval'),
    ('column', 'profiles.role'),
    ('column', 'orders.package_category'),
    ('table', 'profiles'),
    ('table', 'riders'),
    ('table', 'orders'),
    ('table', 'payments'),
    ('table', 'order_events'),
    ('table', 'chat_messages'),
    ('table', 'rider_reviews'),
    ('table', 'chat_rooms'),
    ('table', 'call_logs'),
    ('table', 'rider_offers'),
    ('table', 'order_assignment_history'),
    ('table', 'dispatch_alerts'),
    ('table', 'dispatch_settings'),
    ('table', 'rider_admin_events'),
    ('function', 'touch_updated_at'),
    ('function', 'handle_new_user'),
    ('function', 'current_user_role'),
    ('function_return', 'current_user_role'),
    ('function', 'vehicle_rank'),
    ('function', 'get_rider_available_orders'),
    ('function', 'accept_order'),
    ('function', 'advance_order'),
    ('function', 'confirm_delivery'),
    ('function', 'set_order_price'),
    ('function', 'approve_rider'),
    ('function', 'update_rider_presence'),
    ('function', 'auto_complete_deliveries'),
    ('function', 'get_delivery_contacts'),
    ('function', 'ensure_order_chat_room'),
    ('function', 'decline_order'),
    ('function', 'apply_paystack_payment'),
    ('function', 'vehicle_compatible'),
    ('function', 'dispatch_pending_orders'),
    ('function', 'set_rider_approval_status'),
    ('function', 'report_delivery_problem'),
    ('function', 'admin_assign_order'),
    ('function', 'return_order_to_rider_pool'),
    ('function', 'admin_cancel_order'),
    ('function', 'acknowledge_dispatch_alert'),
    ('function', 'refresh_admin_dispatch_queue'),
    ('function', 'save_rider_document_path'),
    ('function', 'create_delivery_quote_with_category'),
    ('function', 'set_delivery_quote_vehicle'),
    ('realtime', 'rider_offers'),
    ('realtime', 'dispatch_alerts'),
    ('realtime', 'order_assignment_history'),
    ('realtime', 'rider_admin_events'),
    ('realtime', 'order_events'),
    ('rls', 'rider_offers'),
    ('rls', 'order_assignment_history'),
    ('rls', 'dispatch_alerts'),
    ('rls', 'dispatch_settings'),
    ('rls', 'rider_admin_events'),
    ('index', 'orders_one_active_delivery_per_rider_idx'),
    ('realtime', 'orders'),
    ('realtime', 'chat_messages'),
    ('realtime', 'riders'),
    ('realtime', 'chat_rooms'),
    ('realtime', 'call_logs'),
    ('bucket', 'rider-documents'),
    ('rls', 'profiles'),
    ('rls', 'riders'),
    ('rls', 'orders'),
    ('rls', 'payments'),
    ('rls', 'order_events'),
    ('rls', 'chat_messages'),
    ('rls', 'rider_reviews'),
    ('rls', 'chat_rooms'),
    ('rls', 'call_logs'),
    ('foreign_key', 'profiles.id->auth.users.id')
)
select
  e.kind,
  e.object_name,
  case e.kind
    when 'type' then exists (
      select 1
      from pg_type t
      join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'public' and t.typname = e.object_name
        and (
          (e.object_name = 'user_role' and t.typtype = 'e'
            and (select array_agg(enumlabel::text order by enumsortorder)
                 from pg_enum where enumtypid = t.oid)
                @> array['customer', 'rider', 'supervisor', 'admin']::text[])
          or (e.object_name = 'rider_approval' and t.typtype = 'e'
            and (select array_agg(enumlabel::text order by enumsortorder)
                 from pg_enum where enumtypid = t.oid)
                @> array['pending', 'approved', 'rejected', 'suspended']::text[])
        )
    )
    when 'column' then exists (
      select 1
      from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = split_part(e.object_name, '.', 1)
        and c.column_name = split_part(e.object_name, '.', 2)
        and (
          (e.object_name = 'profiles.role'
            and c.udt_schema = 'public'
            and c.udt_name = 'user_role'
            and c.is_nullable = 'NO')
          or (e.object_name = 'orders.package_category'
            and c.data_type = 'text'
            and c.is_nullable = 'YES')
        )
    )
    when 'table' then exists (
      select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = e.object_name
        and c.relkind in ('r', 'p')
    )
    when 'function' then exists (
      select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = e.object_name
    )
    when 'function_return' then exists (
      select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = e.object_name
        and p.prorettype = to_regtype('public.user_role')
    )
    when 'realtime' then exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = e.object_name
    )
    when 'bucket' then exists (
      select 1 from storage.buckets where id = e.object_name and public = false
    )
    when 'rls' then exists (
      select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = e.object_name
        and c.relrowsecurity
    )
    when 'foreign_key' then exists (
      select 1
      from pg_constraint c
      where c.conrelid = 'public.profiles'::regclass
        and c.confrelid = 'auth.users'::regclass
        and c.contype = 'f'
        and c.conkey = array[
          (select attnum from pg_attribute
           where attrelid = 'public.profiles'::regclass
             and attname = 'id' and not attisdropped)
        ]::smallint[]
        and c.confkey = array[
          (select attnum from pg_attribute
           where attrelid = 'auth.users'::regclass
             and attname = 'id' and not attisdropped)
        ]::smallint[]
        and c.confdeltype = 'c'
        and c.convalidated
    )
    when 'index' then to_regclass('public.' || e.object_name) is not null
  end as installed
from expected_objects e
order by
  case e.kind
    when 'type' then 1
    when 'table' then 2
    when 'column' then 3
    when 'function' then 4
    when 'function_return' then 5
    when 'realtime' then 6
    when 'bucket' then 7
    when 'rls' then 8
    when 'index' then 9
    else 9
  end,
  e.object_name;
