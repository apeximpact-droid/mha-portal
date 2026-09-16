-- Partner Statuses (material_org_status) tracked only an Approval Date --
-- admin also needs to record when the material was submitted to each
-- carrier/org, independent of when it was approved.
alter table material_org_status
  add column if not exists submission_date date;
