-- The original Direct Apex Clients migration extended can_see_material() so
-- an affiliate-linked client's login can already read the linked org's
-- materials/files/opt-ins rows directly. It did NOT extend material_shares
-- itself, which stayed restricted to org_id = current_org_id() only. The
-- partner-facing Affiliate Organizations tab needs to read material_shares
-- (filtered by the linked org's id) to know WHICH materials belong to that
-- org in the first place -- without this, that query returns nothing even
-- though the materials themselves are already visible.
drop policy if exists read_own_share on material_shares;
create policy read_own_share on material_shares for select
  using (is_admin() or org_id = current_org_id() or can_see_as_affiliate(org_id));
