-- Lets admin record an approval date and an approval confirmation file
-- (image or document) alongside a partner organization's status -- on the
-- same material_org_status row, mirroring how material_carrier_optins
-- already links a confirmation_file_id per carrier.
alter table material_org_status
  add column if not exists approval_date date,
  add column if not exists approval_confirmation_file_id uuid references material_files(id) on delete set null;

-- Admin already has full access via the existing admin_all-style pattern on
-- other tables; material_org_status's existing policies already grant
-- admin "using (is_admin() or ...)" for all operations, so no new policy
-- is needed here -- only the columns are new.
