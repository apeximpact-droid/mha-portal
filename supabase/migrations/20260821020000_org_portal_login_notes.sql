-- Free-text notes on each Affiliate Login (organization_portal_logins), for
-- admin-side context specific to that login -- e.g. quirks of that portal,
-- who to contact if access breaks, anything not captured by the other
-- structured fields.
alter table organization_portal_logins
  add column if not exists notes text;
