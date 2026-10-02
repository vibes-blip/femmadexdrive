-- FEMADEXDRIVE ADMIN SETUP
-- 1) Create the admin account in Supabase Dashboard > Authentication > Users.
--    Use your chosen admin email and a strong password. The password is stored by Supabase Auth,
--    never in this repository.
-- 2) After the account exists, run:
update public.profiles
set role='admin', updated_at=now()
where lower(email)=lower('femmadexmanagement@gmail.com');

-- Verify:
select id, email, role from public.profiles where lower(email)=lower('femmadexmanagement@gmail.com');

-- IMPORTANT: Do not put an admin password into frontend code, SQL files, GitHub, or VITE_* variables.
