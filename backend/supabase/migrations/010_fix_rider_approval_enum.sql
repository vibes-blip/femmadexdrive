-- Fix approval assignment for the rider_approval enum.
-- Existing authorization is retained: only admins and supervisors can approve.
create or replace function public.approve_rider(p_rider_id uuid, p_approved boolean)
returns public.riders
language plpgsql
security definer
set search_path = public
as $$
declare
  rider_row public.riders;
begin
  if public.current_user_role() not in ('admin', 'supervisor') then
    raise exception 'Operations access required';
  end if;

  update public.riders
  set approval_status = case
    when p_approved then 'approved'::public.rider_approval
    else 'rejected'::public.rider_approval
  end
  where id = p_rider_id
  returning * into rider_row;

  if rider_row.id is null then
    raise exception 'Rider application not found';
  end if;

  return rider_row;
end
$$;

revoke execute on function public.approve_rider(uuid, boolean) from public, anon;
grant execute on function public.approve_rider(uuid, boolean) to authenticated;
