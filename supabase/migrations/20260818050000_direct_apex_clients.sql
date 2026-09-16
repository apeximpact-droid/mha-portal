-- =============================================================================
-- Direct Apex Clients
-- =============================================================================
-- A Direct Apex Client is an ordinary organization (same shape as every
-- other Partner Organization -- name, POC contacts, portal logins, logo,
-- MSA, submission forms, guideline docs) flagged with is_direct_apex_client,
-- that can additionally be linked to one or more existing organizations.
-- Once linked, that client's own Partner Portal login gains read access to
-- the linked organization's materials, guideline documents, submission form
-- links, and portal login credentials, surfaced there as a new "Affiliate
-- Organizations" tab. Regular Partner Organizations are unaffected -- this
-- whole mechanism only activates through direct_client_org_links rows.
-- =============================================================================

alter table organizations
  add column if not exists is_direct_apex_client boolean not null default false;

create table direct_client_org_links (
  id                    uuid primary key default gen_random_uuid(),
  direct_client_org_id  uuid not null references organizations(id) on delete cascade,
  linked_org_id         uuid not null references organizations(id) on delete cascade,
  created_at            timestamptz not null default now(),
  unique (direct_client_org_id, linked_org_id)
);
create index if not exists idx_direct_client_links_client on direct_client_org_links(direct_client_org_id);
create index if not exists idx_direct_client_links_linked on direct_client_org_links(linked_org_id);

alter table direct_client_org_links enable row level security;
drop policy if exists admin_all_direct_client_org_links on direct_client_org_links;
create policy admin_all_direct_client_org_links on direct_client_org_links for all
  using (is_admin()) with check (is_admin());
-- A Direct Apex Client's own login needs to read its own link rows, so the
-- partner client knows which organizations to fetch for Affiliate Organizations.
drop policy if exists partner_read_own_direct_client_links on direct_client_org_links;
create policy partner_read_own_direct_client_links on direct_client_org_links for select
  using (direct_client_org_id = current_org_id());

-- True only if the caller's own org has been linked to target_org_id as a
-- Direct Apex Client affiliate.
create or replace function can_see_as_affiliate(target_org_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from direct_client_org_links l
    where l.direct_client_org_id = current_org_id() and l.linked_org_id = target_org_id
  );
$$;

-- Extend material visibility: a Direct Apex Client sees a material if it's
-- shared with their own org OR with any org they're affiliate-linked to.
-- Every policy that already gates through can_see_material (the material
-- row itself, its files, its carrier opt-ins) inherits this automatically --
-- no changes needed there. Messages and per-org status stay strictly
-- own-org-only (those policies additionally require org_id =
-- current_org_id(), so this change does not expose another organization's
-- private discussion threads or internal status).
create or replace function can_see_material(m uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select is_admin() or exists (
    select 1 from material_shares s
    where s.material_id = m
      and (s.org_id = current_org_id() or can_see_as_affiliate(s.org_id))
  );
$$;

-- Partners previously had no read access to `organizations` at all. Let a
-- partner read their own org row plus any org they're affiliate-linked to
-- (name, active flag, etc., for display on the Affiliate Organizations tab).
drop policy if exists affiliate_read_orgs on organizations;
create policy affiliate_read_orgs on organizations for select
  using (id = current_org_id() or can_see_as_affiliate(id));

-- Guideline documents, submission form links, and portal login credentials
-- for an affiliate-linked organization become readable too (admin-only
-- until now).
drop policy if exists affiliate_read_org_guideline_documents on organization_guideline_documents;
create policy affiliate_read_org_guideline_documents on organization_guideline_documents for select
  using (can_see_as_affiliate(org_id));

drop policy if exists affiliate_read_org_submission_forms on organization_submission_forms;
create policy affiliate_read_org_submission_forms on organization_submission_forms for select
  using (can_see_as_affiliate(org_id));

drop policy if exists affiliate_read_org_portal_logins on organization_portal_logins;
create policy affiliate_read_org_portal_logins on organization_portal_logins for select
  using (can_see_as_affiliate(org_id));

-- Storage: guideline document PDFs live in the same admin-only
-- organization-documents bucket as MSAs and submission form files, keyed
-- only by org id in the path (orgs/{org_id}/{filename}), so a broad
-- "any file under this org's folder" policy would over-expose those other,
-- not-requested document types. Match the exact file_path from
-- organization_guideline_documents instead, so only guideline PDFs become
-- downloadable to an affiliate-linked partner -- MSAs and submission form
-- files stay admin-only.
create policy organization_documents_affiliate_guideline_read on storage.objects for select
  using (
    bucket_id = 'organization-documents'
    and exists (
      select 1 from organization_guideline_documents gd
      where gd.file_path = storage.objects.name
        and can_see_as_affiliate(gd.org_id)
    )
  );
