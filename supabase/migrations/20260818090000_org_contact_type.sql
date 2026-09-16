-- Each Partner Organization contact (a users row with role='partner') can
-- now be tagged with what they do for that org, so the admin side can tell
-- at a glance who to reach for a compliance question vs. a media buy.
alter table users add column if not exists contact_type text
  check (contact_type is null or contact_type in ('Compliance', 'Operations', 'Owner', 'Media Buyer'));
