-- One-time backfill: organization_portal_logins rows that were tagged with a
-- Direct Apex Client (direct_client_org_ids) before the auto-link-on-save
-- logic (ensureDirectClientLinks) was deployed never got a corresponding
-- direct_client_org_links row, so that client's own Partner Portal login has
-- no actual read access despite the admin UI showing the login as "linked."
-- This creates the missing links for every existing tagged login, retroactively.
insert into direct_client_org_links (direct_client_org_id, linked_org_id)
select distinct unnest(opl.direct_client_org_ids), opl.org_id
from organization_portal_logins opl
where opl.direct_client_org_ids is not null
  and array_length(opl.direct_client_org_ids, 1) > 0
on conflict (direct_client_org_id, linked_org_id) do nothing;
