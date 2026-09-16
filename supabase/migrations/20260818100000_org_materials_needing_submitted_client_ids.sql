-- Materials Needing Submitted moves from a free-text "organization name"
-- field to a multi-select of this org's actual Direct Apex Clients, so the
-- admin picks from a real list instead of typing a name that might not
-- match anything. Separate array per plan year, same convention as
-- carrier_contacts.assigned_org_ids. The old free-text columns are left in
-- place, unused, matching how earlier deprecated fields were handled.
alter table organizations
  add column if not exists py26_materials_needing_submitted_org_ids uuid[],
  add column if not exists py27_materials_needing_submitted_org_ids uuid[];
