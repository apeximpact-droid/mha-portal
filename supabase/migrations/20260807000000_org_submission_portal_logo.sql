-- Per-organization admin-side reference info: not every partner has a
-- submission form or their own compliance portal, so these are optional
-- links. Logo is shown in the admin's own view of that organization. MSA is
-- the signed Master Service Agreement Apex is contracted under with that
-- partner. All admin-only, same pattern as every other admin-only asset in
-- this schema -- never exposed to a partner's own session.
alter table organizations add column if not exists submission_form_url text;
alter table organizations add column if not exists compliance_portal_url text;
alter table organizations add column if not exists logo_path text;
alter table organizations add column if not exists msa_file_path text;
alter table organizations add column if not exists msa_file_name text;

insert into storage.buckets (id, name, public)
values ('organization-logos', 'organization-logos', false)
on conflict (id) do nothing;

create policy organization_logos_admin_only on storage.objects for all
  using (bucket_id = 'organization-logos' and public.is_admin())
  with check (bucket_id = 'organization-logos' and public.is_admin());

insert into storage.buckets (id, name, public)
values ('organization-documents', 'organization-documents', false)
on conflict (id) do nothing;

create policy organization_documents_admin_only on storage.objects for all
  using (bucket_id = 'organization-documents' and public.is_admin())
  with check (bucket_id = 'organization-documents' and public.is_admin());
