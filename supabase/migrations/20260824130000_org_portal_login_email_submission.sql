-- Some carriers/portals Apex works with don't have a submission portal at
-- all -- materials go to them by email instead. Lets an Affiliate Login
-- entry (organization_portal_logins) skip the URL/username/password fields
-- entirely and record the submission email instead, while still keeping
-- Line of Business and Direct Apex Client(s) usable on the same entry.
alter table organization_portal_logins
  add column if not exists no_submission_portal boolean not null default false,
  add column if not exists submission_email text;
