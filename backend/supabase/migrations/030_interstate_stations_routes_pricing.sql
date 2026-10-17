create table if not exists public.delivery_stations (
 id uuid primary key default gen_random_uuid(),
 name text not null check(length(btrim(name)) between 2 and 160),
 address text not null check(length(btrim(address)) between 5 and 1000),
 state text not null check(length(btrim(state)) between 2 and 80),
 city text not null check(length(btrim(city)) between 2 and 100),
 latitude double precision not null check(latitude between -90 and 90),
 longitude double precision not null check(longitude between -180 and 180),
 contact_phone text,
 opening_hours jsonb not null default '{}'::jsonb,
 operational_status text not null default 'operational'
  check(operational_status in ('operational','temporarily_closed','suspended')),
 active boolean not null default false,
 accepts_outgoing boolean not null default false,
 accepts_incoming boolean not null default false,
 accepted_categories text[] not null default array['small','medium']::text[],
 maximum_weight_kg numeric(10,2),
 maximum_length_cm numeric(10,2),
 maximum_width_cm numeric(10,2),
 maximum_height_cm numeric(10,2),
 cutoff_time time,
 collection_instructions text,
 created_by uuid references public.profiles(id),
 updated_by uuid references public.profiles(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 check(cardinality(accepted_categories)>0),
 check(accepted_categories <@ array['small','medium','bulky']::text[]),
 check(maximum_weight_kg is null or maximum_weight_kg>0),
 check(maximum_length_cm is null or maximum_length_cm>0),
 check(maximum_width_cm is null or maximum_width_cm>0),
 check(maximum_height_cm is null or maximum_height_cm>0),
 check(jsonb_typeof(opening_hours)='object')
);

create index if not exists delivery_stations_route_lookup_idx
 on public.delivery_stations(lower(state),lower(city),operational_status)
 where active and operational_status='operational';

create table if not exists public.delivery_routes (
 id uuid primary key default gen_random_uuid(),
 origin_station_id uuid not null references public.delivery_stations(id) on delete restrict,
 destination_station_id uuid not null references public.delivery_stations(id) on delete restrict,
 transport_partner text not null check(length(btrim(transport_partner)) between 2 and 160),
 active boolean not null default false,
 standard_min_days integer not null default 1 check(standard_min_days between 1 and 30),
 standard_max_days integer not null default 7 check(standard_max_days between standard_min_days and 30),
 express_available boolean not null default false,
 express_min_days integer,
 express_max_days integer,
 supported_categories text[] not null default array['small','medium']::text[],
 supported_vehicle_classes text[] not null default array['motorcycle','car','van','truck']::text[],
 maximum_weight_kg numeric(10,2),
 maximum_distance_km numeric(10,2),
 operating_days smallint[] not null default array[1,2,3,4,5,6]::smallint[],
 departure_cutoff time,
 last_verified_at timestamptz,
 created_by uuid references public.profiles(id),
 updated_by uuid references public.profiles(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(origin_station_id,destination_station_id),
 check(origin_station_id<>destination_station_id),
 check(cardinality(supported_categories)>0),
 check(supported_categories <@ array['small','medium','bulky']::text[]),
 check(cardinality(supported_vehicle_classes)>0),
 check(supported_vehicle_classes <@ array['motorcycle','car','van','truck']::text[]),
 check(maximum_weight_kg is null or maximum_weight_kg>0),
 check(maximum_distance_km is null or maximum_distance_km>0),
 check(cardinality(operating_days)>0),
 check(operating_days <@ array[1,2,3,4,5,6,7]::smallint[]),
 check(
  (express_available and express_min_days is not null and express_max_days is not null
   and express_min_days between 1 and 4 and express_max_days between express_min_days and 4)
  or (not express_available and express_min_days is null and express_max_days is null)
 )
);

create index if not exists delivery_routes_active_idx
 on public.delivery_routes(origin_station_id,destination_station_id)
 where active;

create table if not exists public.delivery_pricing_versions (
 id uuid primary key default gen_random_uuid(),
 version integer generated always as identity unique,
 journey_type text not null check(journey_type in ('local','same_state','interstate')),
 package_category text not null check(package_category in ('small','medium','bulky')),
 vehicle_class text not null check(vehicle_class in ('motorcycle','car','van','truck')),
 base_fare numeric(12,2) not null check(base_fare>=0),
 minimum_fare numeric(12,2) not null check(minimum_fare>=0),
 distance_bands jsonb not null,
 maximum_distance_km numeric(10,2),
 operating_cost_floor numeric(12,2) not null default 0 check(operating_cost_floor>=0),
 express_premium_percent numeric(5,2) not null default 25 check(express_premium_percent between 0 and 300),
 status text not null default 'draft' check(status in ('draft','published','archived')),
 notes text,
 created_by uuid references public.profiles(id),
 published_by uuid references public.profiles(id),
 published_at timestamptz,
 created_at timestamptz not null default now(),
 check(jsonb_typeof(distance_bands)='array'),
 check(maximum_distance_km is null or maximum_distance_km>0),
 check(status<>'published' or (published_at is not null and published_by is not null))
);

create unique index if not exists delivery_pricing_one_published_idx
 on public.delivery_pricing_versions(journey_type,package_category,vehicle_class)
 where status='published';
create index if not exists delivery_pricing_history_idx
 on public.delivery_pricing_versions(journey_type,package_category,vehicle_class,version desc);

insert into public.delivery_pricing_versions
 (journey_type,package_category,vehicle_class,base_fare,minimum_fare,distance_bands,maximum_distance_km,notes)
values
 ('interstate','small','motorcycle',500,0,'[{"up_to_km":100,"rate_per_km":300},{"up_to_km":300,"rate_per_km":220},{"up_to_km":700,"rate_per_km":180}]',700,'Initial draft only; no quote is available until an admin publishes a cost-validated rule.'),
 ('interstate','small','car',1500,0,'[{"up_to_km":100,"rate_per_km":600},{"up_to_km":300,"rate_per_km":450},{"up_to_km":700,"rate_per_km":350}]',700,'Initial draft only; validate against the operating cost for a car.'),
 ('interstate','small','van',3000,0,'[{"up_to_km":100,"rate_per_km":1200},{"up_to_km":300,"rate_per_km":900},{"up_to_km":700,"rate_per_km":700}]',700,'Initial draft only; validate against the operating cost for a van.'),
 ('interstate','medium','motorcycle',750,0,'[{"up_to_km":100,"rate_per_km":350},{"up_to_km":300,"rate_per_km":260},{"up_to_km":700,"rate_per_km":220}]',700,'Initial draft only; validate against the operating cost for a motorcycle.'),
 ('interstate','medium','car',2000,0,'[{"up_to_km":100,"rate_per_km":750},{"up_to_km":300,"rate_per_km":550},{"up_to_km":700,"rate_per_km":450}]',700,'Initial draft only; validate against the operating cost for a car.'),
 ('interstate','medium','van',4000,0,'[{"up_to_km":100,"rate_per_km":1400},{"up_to_km":300,"rate_per_km":1100},{"up_to_km":700,"rate_per_km":850}]',700,'Initial draft only; validate against the operating cost for a van.'),
 ('interstate','medium','truck',7000,0,'[{"up_to_km":100,"rate_per_km":2300},{"up_to_km":300,"rate_per_km":1800},{"up_to_km":700,"rate_per_km":1500},{"up_to_km":null,"rate_per_km":1200}]',null,'Initial draft only; validate against the operating cost for a truck.'),
 ('interstate','bulky','van',5000,0,'[{"up_to_km":100,"rate_per_km":2200},{"up_to_km":300,"rate_per_km":1800},{"up_to_km":700,"rate_per_km":1500},{"up_to_km":null,"rate_per_km":1200}]',null,'Initial draft only; validate the van operating cost independently.'),
 ('interstate','bulky','truck',5000,0,'[{"up_to_km":100,"rate_per_km":1800},{"up_to_km":300,"rate_per_km":1500},{"up_to_km":700,"rate_per_km":1250},{"up_to_km":null,"rate_per_km":1000}]',null,'Truck reference draft only; never apply this rate to a van.')
on conflict do nothing;

alter table public.orders
 add column if not exists journey_type text not null default 'local',
 add column if not exists pickup_state text,
 add column if not exists pickup_state_status text not null default 'unverified',
 add column if not exists pickup_state_verified_by uuid references public.profiles(id),
 add column if not exists pickup_state_verified_at timestamptz,
 add column if not exists destination_state text,
 add column if not exists destination_city text,
 add column if not exists destination_station_id uuid references public.delivery_stations(id) on delete restrict,
 add column if not exists origin_station_id uuid references public.delivery_stations(id) on delete restrict,
 add column if not exists origin_station_snapshot jsonb,
 add column if not exists destination_station_snapshot jsonb,
 add column if not exists interstate_route_snapshot jsonb,
 add column if not exists interstate_route_id uuid references public.delivery_routes(id) on delete restrict,
 add column if not exists service_tier text not null default 'standard',
 add column if not exists estimated_delivery_min_days integer,
 add column if not exists estimated_delivery_max_days integer;

do $$
begin
 if not exists(select 1 from pg_constraint where conrelid='public.orders'::regclass and conname='orders_journey_type_valid') then
  alter table public.orders add constraint orders_journey_type_valid check(journey_type in ('local','same_state','interstate'));
 end if;
 if not exists(select 1 from pg_constraint where conrelid='public.orders'::regclass and conname='orders_pickup_state_status_valid') then
  alter table public.orders add constraint orders_pickup_state_status_valid check(pickup_state_status in ('unverified','verified','rejected'));
 end if;
 if not exists(select 1 from pg_constraint where conrelid='public.orders'::regclass and conname='orders_service_tier_valid') then
  alter table public.orders add constraint orders_service_tier_valid check(service_tier in ('standard','express'));
 end if;
 if not exists(select 1 from pg_constraint where conrelid='public.orders'::regclass and conname='orders_interstate_station_pair_valid') then
  alter table public.orders add constraint orders_interstate_station_pair_valid check(
   (journey_type='interstate'
    and pickup_state is not null and destination_state is not null
    and origin_station_id is not null and destination_station_id is not null
    and interstate_route_id is not null
    and origin_station_snapshot is not null and destination_station_snapshot is not null
    and interstate_route_snapshot is not null)
   or journey_type<>'interstate'
  );
 end if;
end
$$;

create index if not exists orders_interstate_route_idx
 on public.orders(interstate_route_id,status,created_at desc)
 where journey_type='interstate';
create index if not exists orders_pickup_state_review_idx
 on public.orders(pickup_state_status,created_at desc)
 where journey_type='interstate' and pickup_state_status='unverified';

alter table public.delivery_quote_reviews
 add column if not exists pricing_version_id uuid references public.delivery_pricing_versions(id),
 add column if not exists pricing_breakdown jsonb,
 add column if not exists operating_cost_floor numeric(12,2),
 add column if not exists estimated_delivery_min_days integer,
 add column if not exists estimated_delivery_max_days integer;

alter table public.delivery_stations enable row level security;
alter table public.delivery_routes enable row level security;
alter table public.delivery_pricing_versions enable row level security;
revoke all on public.delivery_stations,public.delivery_routes,public.delivery_pricing_versions from public,anon;
grant select,insert,update,delete on public.delivery_stations,public.delivery_routes,public.delivery_pricing_versions to authenticated;
grant all on public.delivery_stations,public.delivery_routes,public.delivery_pricing_versions to service_role;

drop policy if exists delivery_stations_read on public.delivery_stations;
create policy delivery_stations_read on public.delivery_stations for select to authenticated
 using((active and operational_status='operational') or public.current_user_role() in ('admin','supervisor'));
drop policy if exists delivery_stations_admin_write on public.delivery_stations;
create policy delivery_stations_admin_write on public.delivery_stations for all to authenticated
 using(public.current_user_role() in ('admin','supervisor'))
 with check(public.current_user_role() in ('admin','supervisor'));

drop policy if exists delivery_routes_read on public.delivery_routes;
create policy delivery_routes_read on public.delivery_routes for select to authenticated
 using((active and public.current_user_role()='customer') or public.current_user_role() in ('admin','supervisor'));
drop policy if exists delivery_routes_admin_write on public.delivery_routes;
create policy delivery_routes_admin_write on public.delivery_routes for all to authenticated
 using(public.current_user_role() in ('admin','supervisor'))
 with check(public.current_user_role() in ('admin','supervisor'));

drop policy if exists delivery_pricing_read on public.delivery_pricing_versions;
create policy delivery_pricing_read on public.delivery_pricing_versions for select to authenticated
 using(status='published' or public.current_user_role() in ('admin','supervisor'));
drop policy if exists delivery_pricing_admin_write on public.delivery_pricing_versions;
create policy delivery_pricing_admin_write on public.delivery_pricing_versions for all to authenticated
 using(public.current_user_role() in ('admin','supervisor'))
 with check(public.current_user_role() in ('admin','supervisor'));

create or replace function public.validate_delivery_route_activation()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare origin_station public.delivery_stations; destination_station public.delivery_stations;
begin
 if new.active then
  select * into origin_station from public.delivery_stations where id=new.origin_station_id;
  select * into destination_station from public.delivery_stations where id=new.destination_station_id;
  if origin_station.id is null or destination_station.id is null
   or not origin_station.active or not destination_station.active
   or origin_station.operational_status<>'operational' or destination_station.operational_status<>'operational'
   or not origin_station.accepts_outgoing or not destination_station.accepts_incoming
   or new.last_verified_at is null then
   raise exception 'Activate both verified operational stations and confirm outgoing/incoming capability before publishing this route';
  end if;
  if lower(origin_station.state)=lower(destination_station.state) then
   raise exception 'Interstate routes must connect stations in different states';
  end if;
  if not new.supported_categories <@ origin_station.accepted_categories
   or not new.supported_categories <@ destination_station.accepted_categories then
   raise exception 'Route shipment categories must be accepted by both stations';
  end if;
 end if;
 new.updated_at=now();
 return new;
end
$$;

drop trigger if exists delivery_routes_validate_activation on public.delivery_routes;
create trigger delivery_routes_validate_activation before insert or update on public.delivery_routes
 for each row execute function public.validate_delivery_route_activation();

create or replace function public.invalidate_station_routes()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
begin
 new.updated_at=now();
 if (new.name,new.address,new.state,new.city,new.latitude,new.longitude,new.operational_status,
     new.active,new.accepts_outgoing,new.accepts_incoming,new.accepted_categories,
     new.maximum_weight_kg,new.maximum_length_cm,new.maximum_width_cm,new.maximum_height_cm)
    is distinct from
    (old.name,old.address,old.state,old.city,old.latitude,old.longitude,old.operational_status,
     old.active,old.accepts_outgoing,old.accepts_incoming,old.accepted_categories,
     old.maximum_weight_kg,old.maximum_length_cm,old.maximum_width_cm,old.maximum_height_cm) then
  update public.delivery_routes set active=false,last_verified_at=null
  where origin_station_id=new.id or destination_station_id=new.id;
 end if;
 return new;
end
$$;

drop trigger if exists delivery_stations_invalidate_routes on public.delivery_stations;
create trigger delivery_stations_invalidate_routes before update on public.delivery_stations
 for each row execute function public.invalidate_station_routes();

create or replace function public.guard_published_delivery_pricing()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
begin
 if tg_op='UPDATE' and old.status='published' and
  (new.journey_type,new.package_category,new.vehicle_class,new.base_fare,new.minimum_fare,
   new.distance_bands,new.maximum_distance_km,new.operating_cost_floor,new.express_premium_percent)
  is distinct from
  (old.journey_type,old.package_category,old.vehicle_class,old.base_fare,old.minimum_fare,
   old.distance_bands,old.maximum_distance_km,old.operating_cost_floor,old.express_premium_percent) then
  raise exception 'Published prices are immutable; create and publish a new version';
 end if;
 if new.status='published' and coalesce(current_setting('fdd.delivery_pricing_publish',true),'false')<>'true' then
  raise exception 'Publish pricing through the Operations publication workflow';
 end if;
 if new.status='published' and (new.published_by is null or new.published_at is null or new.operating_cost_floor<=0) then
  raise exception 'A published price needs an Operations publisher and a positive cost floor';
 end if;
 return new;
end
$$;

drop trigger if exists delivery_pricing_publish_guard on public.delivery_pricing_versions;
create trigger delivery_pricing_publish_guard before insert or update on public.delivery_pricing_versions
 for each row execute function public.guard_published_delivery_pricing();

create or replace function public.publish_delivery_pricing_version(p_version_id uuid)
returns public.delivery_pricing_versions
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare selected public.delivery_pricing_versions; band jsonb; previous_upper numeric:=0; band_upper numeric; band_index bigint;
begin
 if public.current_user_role() not in ('admin','supervisor') then raise exception 'Operations access required'; end if;
 select * into selected from public.delivery_pricing_versions where id=p_version_id for update;
 if selected.id is null then raise exception 'Pricing version not found'; end if;
 if selected.operating_cost_floor<=0 then raise exception 'Set and validate the operating cost floor before publishing prices'; end if;
 if jsonb_typeof(selected.distance_bands)<>'array' or jsonb_array_length(selected.distance_bands)=0 then
  raise exception 'Add at least one marginal distance band before publishing';
 end if;
 for band,band_index in select value,ordinality from jsonb_array_elements(selected.distance_bands) with ordinality
 loop
  if jsonb_typeof(band)<>'object'
   or not (band ? 'rate_per_km')
   or (band->>'rate_per_km')::numeric<0
   or (band->>'up_to_km' is not null and (band->>'up_to_km')::numeric<=previous_upper)
   or (band->>'up_to_km' is null and band_index<>jsonb_array_length(selected.distance_bands))
   or (band->>'up_to_km' is not null and band_index=jsonb_array_length(selected.distance_bands)
    and selected.maximum_distance_km is null) then
   raise exception 'Each distance band needs a non-negative rate and a positive upper distance or null for the final band';
  end if;
  band_upper:=nullif(band->>'up_to_km','')::numeric;
  if band_upper is not null then previous_upper:=band_upper; end if;
 end loop;
 if selected.maximum_distance_km is not null and previous_upper<selected.maximum_distance_km
  and (selected.distance_bands->(jsonb_array_length(selected.distance_bands)-1)->>'up_to_km') is not null then
  raise exception 'The final distance band must cover the configured maximum distance';
 end if;
 perform set_config('fdd.delivery_pricing_publish','true',true);
 update public.delivery_pricing_versions
 set status='archived'
 where journey_type=selected.journey_type and package_category=selected.package_category
  and vehicle_class=selected.vehicle_class and status='published';
 update public.delivery_pricing_versions
 set status='published',published_by=auth.uid(),published_at=now()
 where id=p_version_id returning * into selected;
 return selected;
end
$$;

revoke all on function public.publish_delivery_pricing_version(uuid) from public,anon;
grant execute on function public.publish_delivery_pricing_version(uuid) to authenticated;

create or replace function public.list_interstate_delivery_routes(
 p_origin_state text,p_destination_state text,p_destination_city text,
 p_package_category text,p_service_tier text,
 p_weight_kg numeric default null,p_length_cm numeric default null,
 p_width_cm numeric default null,p_height_cm numeric default null
)
returns table(
 route_id uuid,origin_station jsonb,destination_station jsonb,
 transport_partner text,express_available boolean,supported_vehicle_classes text[],
 standard_min_days integer,standard_max_days integer,
 express_min_days integer,express_max_days integer,
 supported_categories text[],maximum_weight_kg numeric,maximum_distance_km numeric,
 departure_cutoff time,operating_days smallint[]
)
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
begin
 if public.current_user_role()<>'customer' then raise exception 'Customer access required'; end if;
 if p_origin_state is null
  or (p_destination_state is not null and lower(trim(p_origin_state))=lower(trim(p_destination_state)))
  or (p_destination_city is not null and length(trim(p_destination_city))<2)
  or p_package_category is null
  or p_package_category not in ('small','medium','bulky')
  or p_service_tier is null
  or p_service_tier not in ('standard','express') then
  raise exception 'Select different origin and destination states, a supported package category, and service tier';
 end if;
 return query
 select r.id,
  jsonb_build_object('id',origin.id,'name',origin.name,'address',origin.address,'state',origin.state,
   'city',origin.city,'latitude',origin.latitude,'longitude',origin.longitude,'opening_hours',origin.opening_hours,
   'cutoff_time',origin.cutoff_time,'collection_instructions',origin.collection_instructions),
  jsonb_build_object('id',destination.id,'name',destination.name,'address',destination.address,'state',destination.state,
   'city',destination.city,'latitude',destination.latitude,'longitude',destination.longitude,'opening_hours',destination.opening_hours,
   'cutoff_time',destination.cutoff_time,'collection_instructions',destination.collection_instructions),
  r.transport_partner,r.express_available,r.supported_vehicle_classes,
  r.standard_min_days,r.standard_max_days,r.express_min_days,r.express_max_days,
  r.supported_categories,r.maximum_weight_kg,r.maximum_distance_km,r.departure_cutoff,r.operating_days
 from public.delivery_routes r
 join public.delivery_stations origin on origin.id=r.origin_station_id
 join public.delivery_stations destination on destination.id=r.destination_station_id
 where r.active and r.last_verified_at>now()-interval '90 days' and r.last_verified_at<=now()
  and lower(origin.state)=lower(trim(p_origin_state))
  and (p_destination_state is null or lower(destination.state)=lower(trim(p_destination_state)))
  and (p_destination_city is null or lower(destination.city)=lower(trim(p_destination_city)))
  and origin.active and destination.active
  and origin.operational_status='operational' and destination.operational_status='operational'
  and origin.accepts_outgoing and destination.accepts_incoming
  and p_package_category=any(r.supported_categories)
  and p_package_category=any(origin.accepted_categories)
  and p_package_category=any(destination.accepted_categories)
  and (p_weight_kg is null or (r.maximum_weight_kg is null or p_weight_kg<=r.maximum_weight_kg))
  and (p_weight_kg is null or (origin.maximum_weight_kg is null or p_weight_kg<=origin.maximum_weight_kg))
  and (p_weight_kg is null or (destination.maximum_weight_kg is null or p_weight_kg<=destination.maximum_weight_kg))
  and (p_length_cm is null or origin.maximum_length_cm is null or p_length_cm<=origin.maximum_length_cm)
  and (p_length_cm is null or destination.maximum_length_cm is null or p_length_cm<=destination.maximum_length_cm)
  and (p_width_cm is null or origin.maximum_width_cm is null or p_width_cm<=origin.maximum_width_cm)
  and (p_width_cm is null or destination.maximum_width_cm is null or p_width_cm<=destination.maximum_width_cm)
  and (p_height_cm is null or origin.maximum_height_cm is null or p_height_cm<=origin.maximum_height_cm)
  and (p_height_cm is null or destination.maximum_height_cm is null or p_height_cm<=destination.maximum_height_cm)
  and (p_service_tier='standard' or r.express_available)
  and exists(select 1 from public.delivery_pricing_versions price
   where price.journey_type='interstate' and price.package_category=p_package_category
    and price.status='published' and price.operating_cost_floor>0
    and price.vehicle_class=any(r.supported_vehicle_classes))
 order by destination.name;
end
$$;

create or replace function public.create_interstate_delivery_quote(
 p_customer_id uuid,p_route_id uuid,p_destination_station_id uuid,
 p_pickup_state text,p_destination_state text,p_destination_city text,p_service_tier text,
 p_pricing_version_id uuid,p_pickup_address text,p_pickup_latitude double precision,
 p_pickup_longitude double precision,p_recipient_name text,p_recipient_phone text,
 p_goods_description text,p_weight_kg numeric,p_length_cm numeric,p_width_cm numeric,
 p_height_cm numeric,p_package_size text,p_package_category text,p_vehicle_type text,
 p_distance_meters numeric,p_duration_seconds numeric,p_suggested_price numeric,
 p_min_delivery_days integer,p_max_delivery_days integer
)
returns public.orders
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
 route_row public.delivery_routes;
 origin public.delivery_stations;
 destination public.delivery_stations;
 price_row public.delivery_pricing_versions;
 order_row public.orders;
begin
 if p_customer_id is null or p_route_id is null or p_destination_station_id is null
  or p_pricing_version_id is null or p_pickup_state is null or p_destination_state is null or p_destination_city is null
  or p_service_tier is null or p_package_category is null
  or p_service_tier not in ('standard','express') or p_package_category not in ('small','medium','bulky')
  or p_pickup_address is null or length(trim(p_pickup_address)) not between 3 and 1000
  or p_weight_kg is null or p_weight_kg<=0
  or p_recipient_name is null or length(trim(p_recipient_name)) not between 1 and 120
  or p_goods_description is null or length(trim(p_goods_description)) not between 1 and 2000
  or p_distance_meters is null or p_distance_meters<=0
  or p_duration_seconds is null or p_duration_seconds<0
  or p_suggested_price is null or p_suggested_price<=0
  or p_min_delivery_days is null or p_max_delivery_days is null
  or p_min_delivery_days<1 or p_max_delivery_days<p_min_delivery_days then
  raise exception 'Interstate delivery quote details are invalid';
 end if;
 select * into route_row from public.delivery_routes
 where id=p_route_id and active and last_verified_at>now()-interval '90 days' and last_verified_at<=now()
 for share;
 if route_row.id is null or route_row.destination_station_id<>p_destination_station_id then
  raise exception 'The selected station route is no longer eligible';
 end if;
 select * into origin from public.delivery_stations where id=route_row.origin_station_id for share;
 select * into destination from public.delivery_stations where id=route_row.destination_station_id for share;
 if not origin.active or not destination.active
  or origin.operational_status<>'operational' or destination.operational_status<>'operational'
  or not origin.accepts_outgoing or not destination.accepts_incoming
  or lower(origin.state)<>lower(trim(p_pickup_state))
  or lower(destination.state)<>lower(trim(p_destination_state))
  or lower(destination.city)<>lower(trim(p_destination_city))
  or not (p_package_category=any(route_row.supported_categories))
  or not (p_package_category=any(origin.accepted_categories))
  or not (p_package_category=any(destination.accepted_categories))
  or (p_weight_kg is not null and route_row.maximum_weight_kg is not null and p_weight_kg>route_row.maximum_weight_kg)
  or (p_weight_kg is not null and origin.maximum_weight_kg is not null and p_weight_kg>origin.maximum_weight_kg)
  or (p_weight_kg is not null and destination.maximum_weight_kg is not null and p_weight_kg>destination.maximum_weight_kg)
  or (p_length_cm is not null and origin.maximum_length_cm is not null and p_length_cm>origin.maximum_length_cm)
  or (p_length_cm is not null and destination.maximum_length_cm is not null and p_length_cm>destination.maximum_length_cm)
  or (p_width_cm is not null and origin.maximum_width_cm is not null and p_width_cm>origin.maximum_width_cm)
  or (p_width_cm is not null and destination.maximum_width_cm is not null and p_width_cm>destination.maximum_width_cm)
  or (p_height_cm is not null and origin.maximum_height_cm is not null and p_height_cm>origin.maximum_height_cm)
  or (p_height_cm is not null and destination.maximum_height_cm is not null and p_height_cm>destination.maximum_height_cm)
  or not (case p_vehicle_type
    when 'bike' then 'motorcycle'
    when 'motorcycle' then 'motorcycle'
    when 'car' then 'car'
    when 'van' then 'van'
    when 'lorry' then 'truck'
    when 'truck' then 'truck'
    else '' end=any(route_row.supported_vehicle_classes))
  or (p_service_tier='express' and not route_row.express_available)
  or (p_service_tier='express' and route_row.express_max_days>4)
  or (route_row.maximum_distance_km is not null and p_distance_meters/1000>route_row.maximum_distance_km) then
  raise exception 'The station, route, package, service or calculated distance is not eligible';
 end if;
 select * into price_row from public.delivery_pricing_versions
 where id=p_pricing_version_id and journey_type='interstate'
  and package_category=p_package_category and vehicle_class=case p_vehicle_type
   when 'bike' then 'motorcycle' when 'motorcycle' then 'motorcycle'
   when 'car' then 'car' when 'van' then 'van'
   when 'lorry' then 'truck' when 'truck' then 'truck' else '' end
  and status='published' and operating_cost_floor>0
 for share;
 if price_row.id is null
  or p_suggested_price<price_row.minimum_fare
  or p_suggested_price<price_row.operating_cost_floor
  or (price_row.maximum_distance_km is not null and p_distance_meters/1000>price_row.maximum_distance_km) then
  raise exception 'A published, cost-validated rate is unavailable for this route and shipment';
 end if;
 if p_service_tier='standard'
  and (p_min_delivery_days<route_row.standard_min_days or p_max_delivery_days-p_min_delivery_days<>route_row.standard_max_days-route_row.standard_min_days
   or p_min_delivery_days-route_row.standard_min_days>7) then
  raise exception 'The standard delivery estimate changed; refresh the station options';
 end if;
 if p_service_tier='express'
  and (p_min_delivery_days<route_row.express_min_days or p_max_delivery_days-p_min_delivery_days<>route_row.express_max_days-route_row.express_min_days
   or p_min_delivery_days-route_row.express_min_days>7) then
  raise exception 'The express delivery estimate changed; refresh the station options';
 end if;
 order_row:=public.create_delivery_quote_with_category(
  p_customer_id,p_pickup_address,p_pickup_latitude,p_pickup_longitude,
  destination.address,destination.latitude,destination.longitude,
  p_recipient_name,p_recipient_phone,p_goods_description,p_weight_kg,p_length_cm,p_width_cm,p_height_cm,
  p_package_size,p_package_category,case p_vehicle_type
   when 'motorcycle' then 'bike' when 'truck' then 'lorry' else p_vehicle_type end,
  p_distance_meters,p_duration_seconds,
  p_suggested_price,true
 );
 update public.orders set journey_type='interstate',pickup_state=trim(p_pickup_state),
  pickup_state_status='unverified',destination_state=destination.state,destination_city=destination.city,
  destination_station_id=destination.id,origin_station_id=origin.id,
  interstate_route_id=route_row.id,service_tier=p_service_tier,
  origin_station_snapshot=jsonb_build_object('id',origin.id,'name',origin.name,'address',origin.address,
   'state',origin.state,'city',origin.city,'latitude',origin.latitude,'longitude',origin.longitude,
   'opening_hours',origin.opening_hours,'contact_phone',origin.contact_phone),
  destination_station_snapshot=jsonb_build_object('id',destination.id,'name',destination.name,'address',destination.address,
   'state',destination.state,'city',destination.city,'latitude',destination.latitude,'longitude',destination.longitude,
   'opening_hours',destination.opening_hours,'contact_phone',destination.contact_phone,
   'collection_instructions',destination.collection_instructions),
  interstate_route_snapshot=jsonb_build_object('id',route_row.id,'transport_partner',route_row.transport_partner,
   'standard_min_days',route_row.standard_min_days,'standard_max_days',route_row.standard_max_days,
   'express_min_days',route_row.express_min_days,'express_max_days',route_row.express_max_days,
   'operating_days',route_row.operating_days,'departure_cutoff',route_row.departure_cutoff,
   'last_verified_at',route_row.last_verified_at),
  estimated_delivery_min_days=p_min_delivery_days,estimated_delivery_max_days=p_max_delivery_days
 where id=order_row.id returning * into order_row;
 update public.delivery_quote_reviews set pricing_version_id=price_row.id,
  operating_cost_floor=price_row.operating_cost_floor,
  pricing_breakdown=jsonb_build_object('journey_type','interstate','package_category',p_package_category,
   'vehicle_class',p_vehicle_type,'service_tier',p_service_tier,'base_fare',price_row.base_fare,
   'distance_bands',price_row.distance_bands,'distance_meters',p_distance_meters,
   'minimum_fare',price_row.minimum_fare,'operating_cost_floor',price_row.operating_cost_floor,
   'suggested_price',p_suggested_price),
  estimated_delivery_min_days=p_min_delivery_days,estimated_delivery_max_days=p_max_delivery_days
 where order_id=order_row.id;
 insert into public.order_events(order_id,actor_id,event,note)
 values(order_row.id,p_customer_id,'interstate_quote_created',
  'Station-based interstate quote created; pickup state awaits Operations verification.');
 return order_row;
end
$$;

create or replace function public.set_delivery_pickup_state(
 p_order_id uuid,p_pickup_state text,p_verified boolean,p_note text default null
)
returns public.orders
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
 order_row public.orders;
 route_origin_state text;
 verified_value boolean:=coalesce(p_verified,false);
begin
 if public.current_user_role() not in ('admin','supervisor') then raise exception 'Operations access required'; end if;
 if p_verified is null or length(trim(coalesce(p_pickup_state,''))) not between 2 and 80
  or p_note is null or length(trim(p_note)) not between 3 and 1000 then
  raise exception 'Record the pickup state and an audit note';
 end if;
 select * into order_row from public.orders where id=p_order_id and journey_type='interstate' for update;
 if order_row.id is null then raise exception 'Interstate delivery was not found'; end if;
 if order_row.payment_status='paid' then raise exception 'Pickup-state verification is locked after payment'; end if;
 select station.state into route_origin_state
 from public.delivery_routes route join public.delivery_stations station on station.id=route.origin_station_id
 where route.id=order_row.interstate_route_id;
 if verified_value and lower(trim(p_pickup_state))<>lower(trim(coalesce(route_origin_state,''))) then
  verified_value:=false;
 end if;
 update public.orders set pickup_state=trim(p_pickup_state),
  pickup_state_status=case when verified_value then 'verified' else 'rejected' end,
  pickup_state_verified_by=auth.uid(),pickup_state_verified_at=now()
 where id=p_order_id returning * into order_row;
 insert into public.order_events(order_id,actor_id,event,note)
 values(p_order_id,auth.uid(),'pickup_state_classified',
  left(trim(p_note),1000)||'; state='||trim(p_pickup_state)||'; verified='||verified_value::text
   ||case when verified_value=p_verified then '' else '; pickup state does not match the approved route origin' end);
 return order_row;
end
$$;

create or replace function public.record_interstate_status_event()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
begin
 if new.journey_type='interstate' and old.status is distinct from new.status then
  if new.status='accepted' and not exists(
   select 1 from public.order_events where order_id=new.id and event='pickup_rider_assigned'
  ) then
   insert into public.order_events(order_id,actor_id,event,note)
   values(new.id,new.rider_id,'pickup_rider_assigned','Local pickup rider assigned to deliver the sender parcel to the verified origin terminal.');
  elsif new.status='picked_up' and not exists(
   select 1 from public.order_events where order_id=new.id and event='collected_from_sender'
  ) then
   insert into public.order_events(order_id,actor_id,event,note)
   values(new.id,new.rider_id,'collected_from_sender','Local pickup rider reported collection from the sender.');
  end if;
 end if;
 return new;
end
$$;

drop trigger if exists orders_interstate_status_event on public.orders;
create trigger orders_interstate_status_event after update of status on public.orders
 for each row execute function public.record_interstate_status_event();

create or replace function public.advance_interstate_shipment(
 p_order_id uuid,p_stage text,p_note text
)
returns public.orders
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
 order_row public.orders;
 prior_stage text;
 previous_rider uuid;
 stage_order text[]:=array[
  'pickup_rider_assigned','collected_from_sender','arrived_origin_terminal',
  'transport_partner_received','in_transit','arrived_destination_station',
  'ready_for_collection','recipient_collected'
 ];
 stage_index integer;
begin
 if public.current_user_role() not in ('admin','supervisor') then raise exception 'Operations access required'; end if;
 if p_stage is null or not p_stage=any(stage_order)
  or p_note is null or length(trim(p_note)) not between 5 and 1000 then
  raise exception 'Choose a valid milestone and enter an auditable note of 5 to 1000 characters';
 end if;
 select * into order_row from public.orders
 where id=p_order_id and journey_type='interstate' for update;
 if order_row.id is null then raise exception 'Interstate delivery was not found'; end if;
 if order_row.payment_status<>'paid' or order_row.pickup_state_status<>'verified' then
  raise exception 'Payment and pickup-state verification are required before shipment tracking';
 end if;
 if exists(select 1 from public.order_events where order_id=p_order_id and event=p_stage) then
  raise exception 'This shipment milestone has already been recorded';
 end if;
 stage_index:=array_position(stage_order,p_stage);
 if stage_index=1 or stage_index=2 then
  raise exception 'Rider assignment and sender collection are recorded by the dispatch workflow';
 end if;
 prior_stage:=stage_order[stage_index-1];
 if not exists(select 1 from public.order_events where order_id=p_order_id and event=prior_stage) then
  raise exception 'Record the preceding shipment milestone first';
 end if;
 if p_stage='arrived_origin_terminal' and order_row.status<>'delivered' then
  raise exception 'The pickup rider must report delivery to the origin terminal first';
 end if;
 if p_stage='recipient_collected' then
  if order_row.status<>'delivered' then raise exception 'The shipment has not reached the origin terminal'; end if;
  if not exists(select 1 from public.order_events where order_id=p_order_id and event='ready_for_collection') then
   raise exception 'The recipient collection station must be marked ready first';
  end if;
 end if;
 insert into public.order_events(order_id,actor_id,event,note)
 values(p_order_id,auth.uid(),p_stage,left(trim(p_note),1000));
 if p_stage='arrived_origin_terminal' and order_row.rider_id is not null then
  previous_rider:=order_row.rider_id;
  update public.orders set rider_id=null where id=p_order_id;
  insert into public.order_assignment_history(
   order_id,previous_rider_id,new_rider_id,actor_id,action,reason,handover_confirmed,handover_details
  ) values(
   p_order_id,previous_rider,null,auth.uid(),'returned_to_pool',
   'Origin terminal handoff completed; local pickup rider released.',true,left(trim(p_note),1000)
  );
 end if;
 if p_stage='recipient_collected' then
  update public.orders set status='completed',completed_at=now(),rider_id=null
  where id=p_order_id returning * into order_row;
  insert into public.order_events(order_id,actor_id,event,note)
  values(p_order_id,auth.uid(),'interstate_delivery_completed',
   'Recipient collection confirmed by Operations: '||left(trim(p_note),900));
 else
  select * into order_row from public.orders where id=p_order_id;
 end if;
 return order_row;
end
$$;

create or replace function public.guard_interstate_quote_payment()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare quote_floor numeric; route_active boolean; must_validate boolean:=false;
begin
 if new.journey_type='interstate' then
  if tg_op='INSERT' then
   must_validate:=new.status in ('approved','awaiting_payment','paid','searching','accepted')
    or new.payment_status='paid';
  else
   must_validate:=(new.status in ('approved','awaiting_payment','paid','searching','accepted')
     and (old.status is distinct from new.status or old.final_price is distinct from new.final_price))
    or (new.payment_status='paid' and old.payment_status is distinct from new.payment_status);
  end if;
 end if;
 if must_validate then
  if new.pickup_state_status<>'verified' then
   raise exception 'Operations must verify the sender pickup state before approval or payment';
  end if;
  select exists(
   select 1 from public.delivery_routes route
   join public.delivery_stations origin on origin.id=route.origin_station_id
   join public.delivery_stations destination on destination.id=route.destination_station_id
   where route.id=new.interstate_route_id and route.active
    and route.last_verified_at>now()-interval '90 days'
    and route.last_verified_at<=now()
    and origin.active and destination.active
    and origin.operational_status='operational' and destination.operational_status='operational'
  ) into route_active;
  if not route_active then raise exception 'The approved station route is no longer operational'; end if;
  select operating_cost_floor into quote_floor from public.delivery_quote_reviews where order_id=new.id;
  if quote_floor is null or quote_floor<=0 or new.final_price<quote_floor then
   raise exception 'Interstate price is below the published operating-cost floor';
  end if;
 end if;
 return new;
end
$$;

drop trigger if exists orders_guard_interstate_quote_payment on public.orders;
create trigger orders_guard_interstate_quote_payment before insert or update on public.orders
 for each row execute function public.guard_interstate_quote_payment();

revoke all on function public.list_interstate_delivery_routes(text,text,text,text,text,numeric,numeric,numeric,numeric) from public,anon;
grant execute on function public.list_interstate_delivery_routes(text,text,text,text,text,numeric,numeric,numeric,numeric) to authenticated;
revoke all on function public.create_interstate_delivery_quote(uuid,uuid,uuid,text,text,text,text,uuid,text,double precision,double precision,text,text,text,numeric,numeric,numeric,numeric,text,text,text,numeric,numeric,numeric,integer,integer) from public,anon,authenticated;
grant execute on function public.create_interstate_delivery_quote(uuid,uuid,uuid,text,text,text,text,uuid,text,double precision,double precision,text,text,text,numeric,numeric,numeric,numeric,text,text,text,numeric,numeric,numeric,integer,integer) to service_role;
revoke all on function public.set_delivery_pickup_state(uuid,text,boolean,text) from public,anon;
grant execute on function public.set_delivery_pickup_state(uuid,text,boolean,text) to authenticated;
revoke all on function public.advance_interstate_shipment(uuid,text,text) from public,anon;
grant execute on function public.advance_interstate_shipment(uuid,text,text) to authenticated;

notify pgrst,'reload schema';
