-- A single Geotargeting Grid Excel file per material, alongside the existing
-- National/County Distribution Area dropdown (which is unchanged). Uses the
-- same materials/{material_id}/{filename} path convention and the existing
-- material-files bucket, so the storage RLS policy from
-- 20260804190000_material_files_storage.sql already covers partner reads --
-- no new storage policy needed.
alter table materials
  add column if not exists geotargeting_grid_file_path text,
  add column if not exists geotargeting_grid_file_name text;
