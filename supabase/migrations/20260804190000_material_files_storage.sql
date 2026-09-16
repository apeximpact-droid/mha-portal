-- =============================================================================
-- material-files Storage bucket + RLS
-- =============================================================================
-- material_files.storage_path points into this bucket, at the convention
-- materials/{material_id}/{filename}. Admin writes (upload/delete) go
-- through the Compliance Portal Worker using the service_role key, which
-- bypasses RLS entirely -- the policies below exist for two reasons:
--   1. They are what actually lets a PARTNER's browser download a file --
--      the client calls Supabase Storage directly with the anon key under
--      their own session, so without a read policy every download would
--      fail with a permissions error.
--   2. Defense in depth: even though no client-side upload UI exists,
--      these policies also block any anon-key-authenticated write outright.
--
-- Admin's own downloads do NOT rely on these policies -- the Compliance
-- Portal has no Supabase session at all (it authenticates via Cloudflare
-- Access, not Supabase Auth), so admin downloads go through the Worker's
-- service_role key too, same as every other admin write in that section.
-- =============================================================================

insert into storage.buckets (id, name, public)
values ('material-files', 'material-files', false)
on conflict (id) do nothing;

-- storage.foldername(name) splits the object path into folder segments;
-- for "materials/{material_id}/{filename}" that's ['materials', '{material_id}'],
-- so index 2 (1-indexed) is the material_id.
create policy "material_files_read" on storage.objects for select
  using (
    bucket_id = 'material-files'
    and (
      public.is_admin()
      or public.can_see_material(((storage.foldername(name))[2])::uuid)
    )
  );

create policy "material_files_admin_insert" on storage.objects for insert
  with check (bucket_id = 'material-files' and public.is_admin());

create policy "material_files_admin_update" on storage.objects for update
  using (bucket_id = 'material-files' and public.is_admin())
  with check (bucket_id = 'material-files' and public.is_admin());

create policy "material_files_admin_delete" on storage.objects for delete
  using (bucket_id = 'material-files' and public.is_admin());
