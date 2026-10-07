-- Safe to rerun. Run only after the three accounts exist in Supabase Auth.
-- This does not create Auth users or set/reset passwords. It matches by email,
-- not pasted UUIDs, and does nothing for Auth accounts that do not exist yet.

do $$
declare
  test_user record;
  role_is_enum boolean;
  role_expression text;
  changed_rows integer;
begin
  select exists (
    select 1
    from information_schema.columns c
    join pg_type t on t.typname = c.udt_name
    join pg_namespace n on n.oid = t.typnamespace
    where c.table_schema = 'public'
      and c.table_name = 'profiles'
      and c.column_name = 'role'
      and c.udt_schema = 'public'
      and c.udt_name = 'user_role'
      and t.typtype = 'e'
      and n.nspname = 'public'
  ) into role_is_enum;

  if not role_is_enum then
    raise exception 'public.profiles.role must use public.user_role. Apply migrations 001 through 010 first.';
  end if;

  for test_user in
    select * from (values
      ('adefowokanfemi1232@gmail.com', 'FemmaDex Customer', 'customer'),
      ('vibestechwold@gmail.com', 'FemmaDex Rider', 'rider'),
      ('femmadexmanagement@gmail.com', 'FemmaDex Management', 'admin')
    ) as users(email, full_name, role_name)
  loop
    role_expression := quote_literal(test_user.role_name) || '::public.user_role';

    execute format(
      'insert into public.profiles (id, email, full_name, role) '
      || 'select id, email, %L, %s from auth.users where lower(email) = lower(%L) '
      || 'on conflict (id) do update set email = excluded.email, role = excluded.role',
      test_user.full_name, role_expression, test_user.email
    );

    get diagnostics changed_rows = row_count;
    if changed_rows = 0 then
      raise notice 'No existing Auth user found for %; create/confirm that account first.', test_user.email;
    end if;
  end loop;
end
$$;

-- Ensure the existing rider Auth user has a pending rider row if the signup
-- trigger did not create one. Never overwrite existing application details.
insert into public.riders (id, display_name, approval_status)
select p.id, coalesce(nullif(p.full_name, ''), p.email, 'FemmaDex Rider'), 'pending'
from public.profiles p
where lower(p.email) = lower('vibestechwold@gmail.com')
  and p.role::text = 'rider'
on conflict (id) do nothing;

-- The test rider remains pending until explicitly approved by an admin.
select p.id, p.email, p.role::text as role, r.approval_status
from public.profiles p
left join public.riders r on r.id = p.id
where lower(p.email) in (
  lower('adefowokanfemi1232@gmail.com'),
  lower('vibestechwold@gmail.com'),
  lower('femmadexmanagement@gmail.com')
)
order by lower(p.email);
