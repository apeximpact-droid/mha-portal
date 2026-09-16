-- Geotargeting Grid library: previously each material carried its own
-- direct upload (materials.geotargeting_grid_file_path/file_name), which
-- meant the same grid (e.g. the CMS Landscape file, reused across many
-- materials and reissued by CMS for the new plan year every December) had
-- to be re-uploaded to every material individually -- duplicate storage and
-- an easy-to-miss annual update across N materials.
--
-- Admin now uploads a grid once here, then links it to any number of
-- materials. materials.geotargeting_grid_file_path/file_name stay the
-- source of truth for the Partner Portal client's own reads/downloads
-- (unchanged there -- no schema or query change needed) -- the Worker keeps
-- them in sync with whichever library grid (if any) a material is linked
-- to, both when the link changes and whenever the library file itself is
-- replaced, so every linked material's partner-visible download instantly
-- reflects the new file with no per-material action needed.
create table geotargeting_grids (
  id            uuid primary key default gen_random_uuid(),
  file_name     text not null,
  storage_path  text not null,
  plan_year     integer,
  uploaded_at   timestamptz not null default now()
);

alter table geotargeting_grids enable row level security;
create policy admin_all_geotargeting_grids on geotargeting_grids for all
  using (is_admin()) with check (is_admin());

alter table materials add column if not exists geotargeting_grid_id uuid references geotargeting_grids(id) on delete set null;

-- Library files live at "geotargeting-grids/{grid_id}/{filename}" in the
-- same material-files bucket, outside the "materials/{material_id}/..."
-- prefix the existing material_files_read policy scopes to (a library file
-- isn't tied to one material, so there's no single material_id to check
-- can_see_material() against). Grids aren't per-org sensitive -- they're
-- just distribution lists, not confidential material content -- so any
-- authenticated partner login can read anything under this prefix; only
-- admin (service_role, via the Worker) can write.
create policy "geotargeting_grid_library_read" on storage.objects for select
  using (
    bucket_id = 'material-files'
    and (storage.foldername(name))[1] = 'geotargeting-grids'
    and (public.is_admin() or auth.role() = 'authenticated')
  );
