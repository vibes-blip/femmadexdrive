-- FEMADEXDRIVE ADMIN SETUP
-- Run this in the Supabase SQL Editor after the Auth user exists.
-- It creates a missing profile or promotes the matching existing profile.
do $$
declare
  affected_rows integer;
begin
  insert into public.profiles (id, full_name, email, phone, role)
  select
    u.id,
    coalesce(nullif(u.raw_user_meta_data->>'full_name', ''), 'FemmaDex Management'),
    u.email,
    u.raw_user_meta_data->>'phone',
    'admin'
  from auth.users u
  where u.id = 'da9eb3b7-6b07-4346-87d8-373bcf09cb8d'::uuid
    and lower(u.email) = lower('femmadexmanagement@gmail.com')
  on conflict (id) do update
    set email = excluded.email,
        role = excluded.role,
        updated_at = now();

  get diagnostics affected_rows = row_count;
  if affected_rows = 0 then
    raise exception 'No Auth user found with the configured UID and email. Check Supabase Authentication > Users.';
  end if;
end
$$;

-- Verify:
select id, email, role
from public.profiles
where id = 'da9eb3b7-6b07-4346-87d8-373bcf09cb8d'::uuid;

-- IMPORTANT: Do not put an admin password into frontend code, SQL files, GitHub, or VITE_* variables.
