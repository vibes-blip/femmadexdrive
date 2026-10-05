-- Prevent authenticated users from changing their own authorization or rider-approval fields.
-- Keep only the profile/document updates required by the frontend.

revoke update on table public.profiles from anon, authenticated;
grant update (full_name, phone) on table public.profiles to authenticated;

revoke update on table public.riders from anon, authenticated;
grant update (bike_image_path, identity_document_path) on table public.riders to authenticated;
