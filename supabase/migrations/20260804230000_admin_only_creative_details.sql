-- =============================================================================
-- Admin-only creative details: End Screen Disclaimers, Social Ad Image
-- Proof, Google Search Ad Proof -- never visible to a partner, regardless
-- of whether the material is shared with their organization.
-- =============================================================================
-- Text field (End Screen Disclaimers). Its own table, not a column on
-- `materials`, for the same reason internal_status is its own table: RLS is
-- row-level, not column-level, and a shared material's row is otherwise
-- fully readable by the partner it's shared with.
create table material_admin_creative_details (
  material_id         uuid primary key references materials(id) on delete cascade,
  end_screen_disclaimer text,
  updated_at          timestamptz not null default now()
);

alter table material_admin_creative_details enable row level security;

create policy admin_all_creative_details on material_admin_creative_details for all
  using (public.is_admin()) with check (public.is_admin());

create trigger material_admin_creative_details_touch
  before update on material_admin_creative_details
  for each row execute function touch_updated_at();

-- Files (Social Ad Image Proof, Google Search Ad Proof). Deliberately a
-- SEPARATE table from material_files, whose read policy
-- (`using (can_see_material(material_id))`) is exactly what a shared
-- partner is allowed to read -- reusing that table for admin-only proof
-- images would leak them to any org the material is shared with.
create table material_admin_files (
  id           uuid primary key default gen_random_uuid(),
  material_id  uuid not null references materials(id) on delete cascade,
  category     text not null,   -- 'Social Ad Image Proof' | 'Google Search Ad Proof'
  file_name    text not null,
  storage_path text not null,   -- object-storage key in the material-admin-files bucket
  uploaded_at  timestamptz not null default now()
);
create index on material_admin_files(material_id);

alter table material_admin_files enable row level security;

create policy admin_all_admin_files on material_admin_files for all
  using (public.is_admin()) with check (public.is_admin());

-- Separate, private bucket -- also admin-only at the Storage layer, not
-- just the table layer. No partner-facing policy at all: unlike
-- material-files (where a partner's own Supabase session can read a
-- shared material's files directly), nothing here is ever reachable by an
-- anon-key + partner-JWT request, by design.
insert into storage.buckets (id, name, public)
values ('material-admin-files', 'material-admin-files', false)
on conflict (id) do nothing;

create policy material_admin_files_admin_only on storage.objects for all
  using (bucket_id = 'material-admin-files' and public.is_admin())
  with check (bucket_id = 'material-admin-files' and public.is_admin());
