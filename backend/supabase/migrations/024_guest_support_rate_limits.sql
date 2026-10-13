create table if not exists public.guest_support_rate_limits(
 subject_hash text primary key check(subject_hash ~ '^[0-9a-f]{64}$'),
 window_started_at timestamptz not null default now(),
 request_count integer not null check(request_count>0),
 last_request_at timestamptz not null default now()
);

create index if not exists guest_support_rate_limits_last_request_idx
 on public.guest_support_rate_limits(last_request_at);

alter table public.guest_support_rate_limits enable row level security;
revoke all on public.guest_support_rate_limits from public,anon,authenticated;
grant select,insert,update,delete on public.guest_support_rate_limits to service_role;

create or replace function public.consume_guest_support_rate_limit(
 p_ip_hash text,
 p_session_hash text,
 p_ip_limit integer,
 p_session_limit integer,
 p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
 ip_count integer;
 session_count integer;
begin
 if p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{64}$'
    or p_session_hash is null or p_session_hash !~ '^[0-9a-f]{64}$'
    or p_ip_limit<1 or p_session_limit<1
    or p_window_seconds<1 or p_window_seconds>86400 then
  raise exception 'Invalid guest support rate-limit request';
 end if;

 if random()<0.01 then
  delete from public.guest_support_rate_limits
  where last_request_at<now()-interval '30 days';
 end if;

 insert into public.guest_support_rate_limits(subject_hash,window_started_at,request_count,last_request_at)
 values(p_ip_hash,now(),1,now())
 on conflict(subject_hash) do update
 set request_count=case
       when guest_support_rate_limits.window_started_at+make_interval(secs=>p_window_seconds)<=now() then 1
       else guest_support_rate_limits.request_count+1
     end,
     window_started_at=case
       when guest_support_rate_limits.window_started_at+make_interval(secs=>p_window_seconds)<=now() then now()
       else guest_support_rate_limits.window_started_at
     end,
     last_request_at=now()
 returning request_count into ip_count;

 insert into public.guest_support_rate_limits(subject_hash,window_started_at,request_count,last_request_at)
 values(p_session_hash,now(),1,now())
 on conflict(subject_hash) do update
 set request_count=case
       when guest_support_rate_limits.window_started_at+make_interval(secs=>p_window_seconds)<=now() then 1
       else guest_support_rate_limits.request_count+1
     end,
     window_started_at=case
       when guest_support_rate_limits.window_started_at+make_interval(secs=>p_window_seconds)<=now() then now()
       else guest_support_rate_limits.window_started_at
     end,
     last_request_at=now()
 returning request_count into session_count;

 return ip_count<=p_ip_limit and session_count<=p_session_limit;
end
$$;

revoke all on function public.consume_guest_support_rate_limit(text,text,integer,integer,integer)
 from public,anon,authenticated;
grant execute on function public.consume_guest_support_rate_limit(text,text,integer,integer,integer)
 to service_role;

notify pgrst,'reload schema';
