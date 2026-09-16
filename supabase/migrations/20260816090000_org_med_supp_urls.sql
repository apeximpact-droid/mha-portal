-- Some organizations submit Medicare Supplement business through a
-- different form/portal than their default Medicare Advantage submission
-- form and compliance portal, so these are separate optional fields
-- alongside the existing submission_form_url / compliance_portal_url.
alter table organizations add column if not exists med_supp_submission_form_url text;
alter table organizations add column if not exists med_supp_compliance_portal_url text;
