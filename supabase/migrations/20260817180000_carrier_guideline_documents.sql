-- Carrier Guidelines & Guardrails becomes a repeatable list of PDFs (one per
-- plan year) instead of a single fixed upload per carrier, mirroring the
-- organization_submission_forms conversion. plan_year distinguishes PY26 vs
-- PY27 materials. Admin-only, same is_admin() gate as every other
-- admin-only table in this schema.
create table if not exists carrier_guideline_documents (
  id          uuid primary key default gen_random_uuid(),
  carrier_id  uuid not null references carrier_organizations(id) on delete cascade,
  plan_year   text not null check (plan_year in ('PY26', 'PY27')),
  file_path   text not null,
  file_name   text not null,
  created_at  timestamptz not null default now()
);
create index if not exists idx_carrier_guideline_documents_carrier on carrier_guideline_documents(carrier_id);

alter table carrier_guideline_documents enable row level security;
drop policy if exists admin_all_carrier_guideline_documents on carrier_guideline_documents;
create policy admin_all_carrier_guideline_documents on carrier_guideline_documents for all
  using (is_admin()) with check (is_admin());

-- Preserve any single PDF already on file for a carrier by carrying it over
-- as a PY26 entry (a reasonable default; can be re-tagged PY27 in the UI).
insert into carrier_guideline_documents (carrier_id, plan_year, file_path, file_name)
select id, 'PY26', guidelines_file_path, guidelines_file_name
from carrier_organizations
where guidelines_file_path is not null and guidelines_file_name is not null;
