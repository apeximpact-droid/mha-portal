-- A Direct Apex Client linked to an organization (e.g. a carrier) could see
-- ALL of that organization's Affiliate Login credentials on their Affiliate
-- Organizations tab, including ones tagged (direct_client_org_ids) to a
-- DIFFERENT Direct Apex Client also linked to the same organization -- e.g.
-- two direct clients both linked to "Allstate/HealthCompare" could each see
-- the other's portal username/password, not just their own.
--
-- Restrict affiliate reads to logins with no client-specific tag at all
-- (still shared broadly with every affiliate-linked client, unchanged) or
-- tagged to the viewing client's own org.
drop policy if exists affiliate_read_org_portal_logins on organization_portal_logins;
create policy affiliate_read_org_portal_logins on organization_portal_logins for select
  using (
    can_see_as_affiliate(org_id)
    and (
      direct_client_org_ids is null
      or array_length(direct_client_org_ids, 1) is null
      or current_org_id() = any(direct_client_org_ids)
    )
  );
