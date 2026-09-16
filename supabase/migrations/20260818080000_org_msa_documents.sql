-- Master Service Agreement becomes a repeatable list of documents per
-- organization instead of a single fixed upload (mirrors
-- organization_guideline_documents), each optionally tagged with a Direct
-- Apex Client the agreement applies to -- an organization may have a
-- separate MSA on file for each Direct Apex Client it works with.
create table organization_msa_documents (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organizations(id) on delete cascade,
  assigned_org_id  uuid references organizations(id) on delete set null,
  file_path        text not null,
  file_name        text not null,
  created_at       timestamptz not null default now()
);
create index if not exists idx_org_msa_documents_org on organization_msa_documents(org_id);

alter table organization_msa_documents enable row level security;
drop policy if exists admin_all_org_msa_documents on organization_msa_documents;
create policy admin_all_org_msa_documents on organization_msa_documents for all
  using (is_admin()) with check (is_admin());

-- MSAs stay admin-only, unlike organization_guideline_documents -- no
-- affiliate-read storage/table policy is added here on purpose, matching
-- the Direct Apex Clients migration's explicit choice to exclude MSA and
-- submission-form files from what an affiliate-linked partner can see.

-- Preserve any single MSA already on file for an org, carried over as an
-- unassigned first entry.
insert into organization_msa_documents (org_id, file_path, file_name)
select id, msa_file_path, msa_file_name
from organizations
where msa_file_path is not null and msa_file_name is not null;
