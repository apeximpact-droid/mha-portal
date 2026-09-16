-- Main Marketing Material Submission Email -- a single email address per
-- carrier, alongside the existing Submission Form Link.
alter table carrier_organizations
  add column if not exists main_submission_email text;

-- Lets a carrier contact be tagged to one or more Partner Organizations it
-- relates to, purely for admin tracking (e.g. "this carrier rep works with
-- both Acme Corp's and Summit Group's books of business"). An array since a
-- single contact can be assigned to more than one organization; nullable --
-- most contacts won't need it.
alter table carrier_contacts
  add column if not exists assigned_org_ids uuid[];

-- CMS Information -- a separate area under each carrier for the government
-- (CMS) side of the relationship: who Apex's CMS point of contact is, and
-- the HPMS/EUA login credentials Apex staff use to access that carrier's
-- CMS systems. Plain columns on carrier_organizations, same as the
-- Submission Form Link/Email above -- carriers have no partner-facing RLS
-- path anywhere in this schema (the partner client never queries this
-- table), so there is no column-vs-row exposure risk here the way there is
-- for materials.
alter table carrier_organizations
  add column if not exists cms_poc_name text,
  add column if not exists cms_poc_email text,
  add column if not exists cms_assigned_org_id uuid references organizations(id) on delete set null,
  add column if not exists hpms_username text,
  add column if not exists hpms_password text,
  add column if not exists eua_username text,
  add column if not exists eua_password text;
