-- Carrier Organizations are a separate concept from the existing
-- "organizations" table (Apex's selling partners): a Carrier Organization
-- is the insurance carrier itself (e.g. Humana, Aetna) -- its own
-- submission form link, a repeatable list of named contacts, and an
-- uploaded Guidelines/Guardrails PDF admin staff can view directly.
-- Admin-only throughout, same is_admin() gate as every other admin-only
-- table in this schema.
create table if not exists carrier_organizations (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null,
  submission_form_url   text,
  guidelines_file_path  text,
  guidelines_file_name  text,
  active                boolean not null default true,
  created_at            timestamptz not null default now()
);

create table if not exists carrier_contacts (
  id               uuid primary key default gen_random_uuid(),
  carrier_org_id   uuid not null references carrier_organizations(id) on delete cascade,
  first_name       text,
  last_name        text,
  email            text,
  created_at       timestamptz not null default now()
);
create index if not exists idx_carrier_contacts_org on carrier_contacts(carrier_org_id);

alter table carrier_organizations enable row level security;
drop policy if exists admin_all_carrier_organizations on carrier_organizations;
create policy admin_all_carrier_organizations on carrier_organizations for all
  using (is_admin()) with check (is_admin());

alter table carrier_contacts enable row level security;
drop policy if exists admin_all_carrier_contacts on carrier_contacts;
create policy admin_all_carrier_contacts on carrier_contacts for all
  using (is_admin()) with check (is_admin());

insert into storage.buckets (id, name, public)
values ('carrier-guidelines', 'carrier-guidelines', false)
on conflict (id) do nothing;

drop policy if exists carrier_guidelines_admin_only on storage.objects;
create policy carrier_guidelines_admin_only on storage.objects for all
  using (bucket_id = 'carrier-guidelines' and public.is_admin())
  with check (bucket_id = 'carrier-guidelines' and public.is_admin());

-- Partner organizations can also have an uploaded submission form file --
-- not every partner's submission form is a web link, some hand Apex an
-- actual document instead. Reuses the existing admin-only
-- organization-documents bucket the MSA already uses (any file type).
alter table organizations add column if not exists submission_form_file_path text;
alter table organizations add column if not exists submission_form_file_name text;

-- Submission Guide: a separate uploaded reference document (any file type),
-- same admin-only organization-documents bucket.
alter table organizations add column if not exists submission_guide_file_path text;
alter table organizations add column if not exists submission_guide_file_name text;
