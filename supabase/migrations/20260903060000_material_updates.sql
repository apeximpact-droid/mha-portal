-- Material Updates (admin-only): dated admin notes on a material, each with
-- optional carrier tags and any number of attached files. Files live in the
-- existing admin-only `material-admin-files` bucket.
--
-- Admin-only by construction: RLS is enabled with NO policies, so the
-- Partner Portal's anon/authenticated sessions can never read or write these
-- rows -- only the Worker's service-role key (which bypasses RLS) can.
create table if not exists material_updates (
  id uuid primary key default gen_random_uuid(),
  material_id uuid not null references materials(id) on delete cascade,
  body text not null,
  carrier_tags text[] not null default '{}',
  author_name text,
  created_at timestamptz not null default now()
);
create index if not exists material_updates_material_id_idx
  on material_updates(material_id);

create table if not exists material_update_files (
  id uuid primary key default gen_random_uuid(),
  update_id uuid not null references material_updates(id) on delete cascade,
  file_name text not null,
  storage_path text not null,
  uploaded_at timestamptz not null default now()
);
create index if not exists material_update_files_update_id_idx
  on material_update_files(update_id);

alter table material_updates enable row level security;
alter table material_update_files enable row level security;
