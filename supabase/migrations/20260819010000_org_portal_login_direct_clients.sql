-- Affiliate Logins (organization_portal_logins) can now be tagged with one
-- or more Direct Apex Clients, for admin-side tracking of which login goes
-- with which client. Admin-only labeling, same as carrier_contacts'
-- assigned_org_ids -- does not change what a linked Direct Apex Client can
-- see on their own Affiliate Organizations tab (that stays governed by
-- direct_client_org_links, unaffected by this column).
alter table organization_portal_logins
  add column if not exists direct_client_org_ids uuid[];
