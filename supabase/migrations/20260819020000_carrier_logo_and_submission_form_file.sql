-- Carrier Organizations get the same Logo and uploaded Submission Form
-- (Excel) capabilities Partner Organizations already have.
alter table carrier_organizations
  add column if not exists logo_path text,
  add column if not exists submission_form_file_path text,
  add column if not exists submission_form_file_name text;

insert into storage.buckets (id, name, public)
values ('carrier-logos', 'carrier-logos', false)
on conflict (id) do nothing;

drop policy if exists carrier_logos_admin_only on storage.objects;
create policy carrier_logos_admin_only on storage.objects for all
  using (bucket_id = 'carrier-logos' and public.is_admin())
  with check (bucket_id = 'carrier-logos' and public.is_admin());

-- The Submission Form (Excel) reuses the existing admin-only
-- carrier-guidelines bucket rather than creating a new one -- same
-- convention as organizations reusing organization-documents for MSA,
-- submission form file, and guideline docs together.
