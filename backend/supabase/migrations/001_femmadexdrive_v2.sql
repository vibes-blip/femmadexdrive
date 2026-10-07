-- FEMADEXDRIVE v2 production schema
create extension if not exists pgcrypto;

do $$ begin create type public.user_role as enum ('customer','rider','supervisor','admin'); exception when duplicate_object then null; end $$;
do $$ begin create type public.rider_approval as enum ('pending','approved','rejected','suspended'); exception when duplicate_object then null; end $$;

do $$
declare
 missing_labels text[];
begin
 select array_agg(required.label)
 into missing_labels
 from unnest(array['customer','rider','supervisor','admin']::text[]) as required(label)
 where not exists (
  select 1
  from pg_enum e
  join pg_type t on t.oid = e.enumtypid
  join pg_namespace n on n.oid = t.typnamespace
  where n.nspname = 'public'
    and t.typname = 'user_role'
    and e.enumlabel::text = required.label
 );

 if missing_labels is not null then
  raise exception 'public.user_role is missing required labels: %', array_to_string(missing_labels, ', ');
 end if;
end
$$;

create table if not exists public.profiles(
 id uuid primary key references auth.users(id) on delete cascade,
 full_name text not null default '', email text, phone text,
 role public.user_role not null default 'customer',
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

-- CREATE TABLE IF NOT EXISTS does not reconcile an existing profiles table.
-- Preserve the table and its rows while aligning the columns required below.
alter table public.profiles
 add column if not exists full_name text,
 add column if not exists email text,
 add column if not exists phone text,
 add column if not exists role text,
 add column if not exists created_at timestamptz,
 add column if not exists updated_at timestamptz;

update public.profiles
set full_name = coalesce(full_name, ''),
    created_at = coalesce(created_at, now()),
    updated_at = coalesce(updated_at, now());

alter table public.profiles
 alter column full_name set default '',
 alter column full_name set not null,
 alter column created_at set default now(),
 alter column created_at set not null,
 alter column updated_at set default now(),
 alter column updated_at set not null;

-- Keep recognized roles, normalize case/whitespace, and map NULL/unknown values
-- to customer before converting the existing text column to the enum.
do $$
declare
 role_data_type text;
 role_type_schema text;
 role_type_name text;
 role_attnum smallint;
 role_check record;
begin
 select data_type, udt_schema, udt_name
 into role_data_type, role_type_schema, role_type_name
 from information_schema.columns
 where table_schema = 'public'
   and table_name = 'profiles'
   and column_name = 'role';

 if role_data_type = 'text' then
  select attnum into role_attnum
  from pg_attribute
  where attrelid = 'public.profiles'::regclass
    and attname = 'role'
    and not attisdropped;

  -- Text-based CHECK constraints can retain text operators while PostgreSQL
  -- rewrites the column to the enum (for example role = ANY (text[])).
  -- The enum itself enforces the complete allowed role set after conversion.
  for role_check in
   select c.conname, c.conkey
   from pg_constraint c
   where c.conrelid = 'public.profiles'::regclass
     and c.contype = 'c'
     and role_attnum = any(c.conkey)
  loop
   if cardinality(role_check.conkey) = 1 then
    execute format(
     'alter table public.profiles drop constraint %I',
     role_check.conname
    );
   else
    raise exception 'Cannot safely convert public.profiles.role because CHECK constraint % also depends on other columns. Review it before retrying.',
     role_check.conname;
   end if;
  end loop;

  alter table public.profiles alter column role drop default;
  alter table public.profiles
   alter column role type public.user_role
   using (
    case lower(btrim(role::text))
     when 'customer' then 'customer'::public.user_role
     when 'rider' then 'rider'::public.user_role
     when 'supervisor' then 'supervisor'::public.user_role
     when 'admin' then 'admin'::public.user_role
     else 'customer'::public.user_role
    end
   );
 elsif role_type_schema = 'public' and role_type_name = 'user_role' then
  update public.profiles
  set role = 'customer'::public.user_role
  where role is null;
 else
  raise exception 'Cannot safely convert public.profiles.role: expected text or public.user_role, found %.%.',
   coalesce(role_type_schema, 'unknown'),
   coalesce(role_type_name, role_data_type, 'unknown');
 end if;
end
$$;

alter table public.profiles
 alter column role set default 'customer'::public.user_role,
 alter column role set not null;

-- Foreign keys in the rest of this migration require a unique profiles.id.
-- The index is only added when no primary/unique constraint already provides it.
do $$
begin
 if not exists (
  select 1
  from pg_index i
   join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
  where i.indrelid = 'public.profiles'::regclass
    and i.indisunique
     and i.indisvalid
     and i.indpred is null
     and i.indexprs is null
     and i.indnkeyatts = 1
     and a.attname = 'id'
 ) then
  create unique index profiles_id_compat_uidx on public.profiles(id);
 end if;
end
$$;

-- Add the Auth-user relationship only when existing profile IDs all resolve.
-- Orphaned legacy rows are preserved and reported instead of being removed.
do $$
begin
 if not exists (
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
 ) then
  if not exists (
   select 1
   from public.profiles p
   left join auth.users u on u.id = p.id
   where u.id is null
  ) then
   alter table public.profiles
    add constraint profiles_id_auth_users_fkey
    foreign key (id) references auth.users(id) on delete cascade;
  else
   raise notice 'Skipping profiles -> auth.users foreign key: existing profile IDs include rows with no matching Auth user. No profile rows were changed or deleted.';
  end if;
 end if;
end
$$;

create table if not exists public.riders(
 id uuid primary key references public.profiles(id) on delete cascade,
 display_name text not null, phone text, vehicle_type text, vehicle_registration text,
 bike_image_path text, identity_document_path text,
 approval_status public.rider_approval not null default 'pending',
 is_online boolean not null default false, lat double precision, lng double precision,
 last_seen_at timestamptz, rating numeric(3,2) not null default 0,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.orders(
 id uuid primary key default gen_random_uuid(),
 tracking_number text unique not null default ('FDD-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,8))),
 customer_id uuid not null references public.profiles(id),
 rider_id uuid references public.riders(id),
 pickup_address text not null, dropoff_address text not null,
 goods_description text not null,
 weight_kg numeric(10,2), length_cm numeric(10,2), width_cm numeric(10,2), height_cm numeric(10,2),
 package_size text not null default 'medium',
 vehicle_type text not null,
 distance_km numeric(10,2) not null, duration_minutes integer not null,
 system_price numeric(12,2) not null check(system_price>=0),
 final_price numeric(12,2) not null check(final_price>=0),
 payment_status text not null default 'unpaid' check(payment_status in ('unpaid','pending','paid','failed','refunded')),
 status text not null default 'awaiting_payment' check(status in ('price_review','awaiting_payment','paid','searching','accepted','picked_up','on_the_way','at_door','delivered','completed','cancelled')),
 requested_at timestamptz not null default now(), accepted_at timestamptz, pickup_at timestamptz,
 at_door_at timestamptz, delivered_at timestamptz, completed_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.payments(
 id uuid primary key default gen_random_uuid(), order_id uuid not null references public.orders(id) on delete cascade,
 customer_id uuid not null references public.profiles(id), reference text unique, amount numeric(12,2) not null,
 currency text not null default 'NGN', status text not null default 'pending',
 kora_status text, fee numeric(12,2), payment_method text, raw_response jsonb,
 paid_at timestamptz, created_at timestamptz not null default now()
);

create table if not exists public.order_events(
 id uuid primary key default gen_random_uuid(), order_id uuid not null references public.orders(id) on delete cascade,
 actor_id uuid references public.profiles(id), event text not null, note text, created_at timestamptz not null default now()
);

create table if not exists public.chat_messages(
 id uuid primary key default gen_random_uuid(), order_id uuid not null references public.orders(id) on delete cascade,
 sender_id uuid not null references public.profiles(id), body text not null check(char_length(body) between 1 and 2000),
 created_at timestamptz not null default now()
);

create table if not exists public.rider_reviews(
 id uuid primary key default gen_random_uuid(), order_id uuid unique not null references public.orders(id) on delete cascade,
 customer_id uuid not null references public.profiles(id), rider_id uuid not null references public.riders(id),
 rating integer not null check(rating between 1 and 5), review_text text, created_at timestamptz not null default now()
);

create index if not exists orders_customer_idx on public.orders(customer_id,created_at desc);
create index if not exists orders_rider_idx on public.orders(rider_id,created_at desc);
create index if not exists orders_status_idx on public.orders(status,created_at desc);
create index if not exists payments_order_idx on public.payments(order_id);
create index if not exists events_order_idx on public.order_events(order_id,created_at desc);
create index if not exists chat_order_idx on public.chat_messages(order_id,created_at);

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$ begin new.updated_at=now(); return new; end $$;
drop trigger if exists profiles_touch on public.profiles; create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();
drop trigger if exists riders_touch on public.riders; create trigger riders_touch before update on public.riders for each row execute function public.touch_updated_at();
drop trigger if exists orders_touch on public.orders; create trigger orders_touch before update on public.orders for each row execute function public.touch_updated_at();

create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path=public as $$
declare requested text;
begin
 requested:=coalesce(new.raw_user_meta_data->>'requested_role','customer');
 if requested not in ('customer','rider') then requested:='customer'; end if;
 insert into public.profiles(id,full_name,email,phone,role) values(new.id,coalesce(new.raw_user_meta_data->>'full_name',''),new.email,new.raw_user_meta_data->>'phone',requested::public.user_role)
 on conflict(id) do nothing;
 if requested='rider' then
  insert into public.riders(id,display_name,phone,vehicle_type,vehicle_registration) values(new.id,coalesce(nullif(new.raw_user_meta_data->>'full_name',''),'Rider'),new.raw_user_meta_data->>'phone',new.raw_user_meta_data->>'vehicle_type',new.raw_user_meta_data->>'vehicle_registration')
  on conflict(id) do nothing;
 end if;
 return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

create or replace function public.current_user_role() returns public.user_role language sql stable security definer set search_path=public as $$
 select coalesce(
  (select p.role::public.user_role from public.profiles p where p.id=auth.uid()),
  'customer'::public.user_role
 )
$$;

create or replace function public.accept_order(p_order_id uuid) returns public.orders language plpgsql security definer set search_path=public as $$
declare r public.orders;
begin
 if not exists(select 1 from public.riders where id=auth.uid() and approval_status='approved' and is_online=true) then raise exception 'Approved rider must be online'; end if;
 update public.orders set rider_id=auth.uid(),status='accepted',accepted_at=now() where id=p_order_id and status='paid' and rider_id is null returning * into r;
 if r.id is null then raise exception 'Delivery is no longer available'; end if;
 insert into public.order_events(order_id,actor_id,event,note) values(r.id,auth.uid(),'rider_accepted','Rider accepted delivery');
 return r;
end $$;

create or replace function public.advance_order(p_order_id uuid,p_status text) returns public.orders language plpgsql security definer set search_path=public as $$
declare r public.orders; old text;
begin
 select status into old from public.orders where id=p_order_id and rider_id=auth.uid() for update;
 if old is null then raise exception 'Assigned delivery not found'; end if;
 if not ((old='accepted' and p_status='picked_up') or (old='picked_up' and p_status='on_the_way') or (old='on_the_way' and p_status='at_door') or (old='at_door' and p_status='delivered')) then raise exception 'Invalid delivery stage'; end if;
 update public.orders set status=p_status,pickup_at=case when p_status='picked_up' then now() else pickup_at end,at_door_at=case when p_status='at_door' then now() else at_door_at end,delivered_at=case when p_status='delivered' then now() else delivered_at end where id=p_order_id returning * into r;
 insert into public.order_events(order_id,actor_id,event) values(r.id,auth.uid(),'status_changed');
 return r;
end $$;

create or replace function public.confirm_delivery(p_order_id uuid) returns public.orders language plpgsql security definer set search_path=public as $$
declare r public.orders;
begin
 update public.orders set status='completed',completed_at=now() where id=p_order_id and customer_id=auth.uid() and status='delivered' returning * into r;
 if r.id is null then raise exception 'Delivery is not awaiting confirmation'; end if;
 insert into public.order_events(order_id,actor_id,event,note) values(r.id,auth.uid(),'customer_confirmed','Customer confirmed delivery');
 return r;
end $$;

create or replace function public.set_order_price(p_order_id uuid,p_price numeric) returns public.orders language plpgsql security definer set search_path=public as $$
declare r public.orders;
begin
 if public.current_user_role() not in ('admin','supervisor') then raise exception 'Operations access required'; end if;
 if p_price<=0 then raise exception 'Price must be positive'; end if;
 update public.orders set final_price=p_price,status=case when payment_status='paid' then status else 'awaiting_payment' end where id=p_order_id returning * into r;
 insert into public.order_events(order_id,actor_id,event,note) values(r.id,auth.uid(),'price_changed','Operations updated final price');
 return r;
end $$;

create or replace function public.approve_rider(p_rider_id uuid,p_approved boolean) returns public.riders language plpgsql security definer set search_path=public as $$
declare r public.riders;
begin
 if public.current_user_role() not in ('admin','supervisor') then raise exception 'Operations access required'; end if;
 update public.riders set approval_status=case when p_approved then 'approved'::public.rider_approval else 'rejected'::public.rider_approval end where id=p_rider_id returning * into r;
 if r.id is null then raise exception 'Rider application not found'; end if;
 return r;
end $$;

create or replace function public.update_rider_presence(p_is_online boolean,p_lat double precision default null,p_lng double precision default null) returns public.riders language plpgsql security definer set search_path=public as $$
declare r public.riders;
begin
 update public.riders set is_online=p_is_online,lat=p_lat,lng=p_lng,last_seen_at=now() where id=auth.uid() returning * into r;
 if r.id is null then raise exception 'Rider not found'; end if;
 return r;
end $$;

alter table public.profiles enable row level security;
alter table public.riders enable row level security;
alter table public.orders enable row level security;
alter table public.payments enable row level security;
alter table public.order_events enable row level security;
alter table public.chat_messages enable row level security;
alter table public.rider_reviews enable row level security;

drop policy if exists profiles_self on public.profiles; create policy profiles_self on public.profiles for select using(id=auth.uid() or public.current_user_role() in ('admin','supervisor'));
drop policy if exists profiles_update on public.profiles; create policy profiles_update on public.profiles for update using(id=auth.uid());

drop policy if exists riders_select on public.riders; create policy riders_select on public.riders for select using(id=auth.uid() or public.current_user_role() in ('admin','supervisor'));
drop policy if exists riders_update on public.riders; create policy riders_update on public.riders for update using(id=auth.uid() or public.current_user_role() in ('admin','supervisor'));

drop policy if exists orders_select on public.orders; create policy orders_select on public.orders for select using(customer_id=auth.uid() or rider_id=auth.uid() or public.current_user_role() in ('admin','supervisor') or (public.current_user_role()='rider' and status='paid'));
drop policy if exists orders_insert on public.orders; create policy orders_insert on public.orders for insert with check(false);
drop policy if exists orders_update on public.orders; create policy orders_update on public.orders for update using(public.current_user_role() in ('admin','supervisor')) with check(public.current_user_role() in ('admin','supervisor'));

drop policy if exists payments_select on public.payments; create policy payments_select on public.payments for select using(customer_id=auth.uid() or public.current_user_role() in ('admin','supervisor'));
drop policy if exists events_select on public.order_events; create policy events_select on public.order_events for select using(exists(select 1 from public.orders o where o.id=order_id and (o.customer_id=auth.uid() or o.rider_id=auth.uid() or public.current_user_role() in ('admin','supervisor'))));
drop policy if exists chat_select on public.chat_messages; create policy chat_select on public.chat_messages for select using(exists(select 1 from public.orders o where o.id=order_id and (o.customer_id=auth.uid() or o.rider_id=auth.uid() or public.current_user_role() in ('admin','supervisor'))));
drop policy if exists chat_insert on public.chat_messages; create policy chat_insert on public.chat_messages for insert with check(sender_id=auth.uid() and exists(select 1 from public.orders o where o.id=order_id and (o.customer_id=auth.uid() or o.rider_id=auth.uid())));

drop policy if exists reviews_insert on public.rider_reviews; create policy reviews_insert on public.rider_reviews for insert with check(customer_id=auth.uid() and exists(select 1 from public.orders o where o.id=order_id and o.customer_id=auth.uid() and o.rider_id=rider_id and o.status='completed'));

-- Storage bucket for rider verification files. Keep it private.
insert into storage.buckets(id,name,public)
values('rider-documents','rider-documents',false)
on conflict(id) do update set public=false;
drop policy if exists rider_docs_insert on storage.objects;
create policy rider_docs_insert on storage.objects for insert to authenticated with check(bucket_id='rider-documents' and (storage.foldername(name))[1]=auth.uid()::text);
drop policy if exists rider_docs_select on storage.objects;
create policy rider_docs_select on storage.objects for select to authenticated using(bucket_id='rider-documents' and ((storage.foldername(name))[1]=auth.uid()::text or public.current_user_role() in ('admin','supervisor')));

do $$begin
 if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='orders') then
  alter publication supabase_realtime add table public.orders;
 end if;
end $$;
do $$begin
 if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='chat_messages') then
  alter publication supabase_realtime add table public.chat_messages;
 end if;
end $$;
do $$begin
 if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='riders') then
  alter publication supabase_realtime add table public.riders;
 end if;
end $$;

-- After creating your own admin account, promote it once:
-- update public.profiles set role='admin' where id='YOUR_AUTH_USER_UUID';
