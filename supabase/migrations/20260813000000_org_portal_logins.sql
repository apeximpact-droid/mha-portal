-- Some organizations have more than one carrier/portal login Apex staff use
-- (a submission form is a single URL already on organizations; this is a
-- separate repeatable list of URL + username + password entries, each
-- optionally handed off to a specific partner login for day-to-day use).
-- Admin-only, same is_admin() gate as every other admin-only table.
create table if not exists organization_portal_logins (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations(id) on delete cascade,
  label             text,
  portal_url        text,
  username          text,
  password          text,
  assigned_user_id  uuid references users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_organization_portal_logins_org on organization_portal_logins(org_id);
create index if not exists idx_organization_portal_logins_assigned on organization_portal_logins(assigned_user_id);

alter table organization_portal_logins enable row level security;
create policy admin_all_org_portal_logins on organization_portal_logins for all
  using (is_admin()) with check (is_admin());
