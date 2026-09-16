-- Marketing Materials Guideline / Material Compliance Contracts becomes a
-- repeatable list of documents per organization instead of a single fixed
-- upload (mirrors carrier_guideline_documents), each optionally tagged with
-- another Partner Organization it applies to (e.g. a guideline that governs
-- a specific compliance contract between two orgs).
create table organization_guideline_documents (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organizations(id) on delete cascade,
  assigned_org_id  uuid references organizations(id) on delete set null,
  file_path        text not null,
  file_name        text not null,
  created_at       timestamptz not null default now()
);
create index if not exists idx_org_guideline_documents_org on organization_guideline_documents(org_id);

alter table organization_guideline_documents enable row level security;
drop policy if exists admin_all_org_guideline_documents on organization_guideline_documents;
create policy admin_all_org_guideline_documents on organization_guideline_documents for all
  using (is_admin()) with check (is_admin());

-- Preserve any single guideline PDF already on file for an org, carried
-- over as an unassigned entry (no specific other org tagged yet).
insert into organization_guideline_documents (org_id, file_path, file_name)
select id, submission_guide_file_path, submission_guide_file_name
from organizations
where submission_guide_file_path is not null and submission_guide_file_name is not null;
