-- Tracks whether a given Internal Operational Login (apex_operational_logins --
-- My Health Angel's own internal tool/portal credentials, admin-only) requires 2FA
-- to sign in, so the team knows at a glance which ones need an authenticator
-- code on top of the stored password.
alter table apex_operational_logins
  add column if not exists requires_2fa boolean not null default false;

-- Admin-only Batch ID# field on materials, entered under Plan Year in the
-- material shell. Deliberately never added to the Partner Portal client's
-- MATERIAL_SELECT field allowlist, so it stays invisible to partners while
-- still showing in the admin's materials list and both export reports.
alter table materials
  add column if not exists batch_id text;
