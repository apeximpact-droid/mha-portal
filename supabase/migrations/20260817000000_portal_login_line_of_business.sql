-- Each Portal Login can now be tagged as belonging to Medicare Advantage
-- or Medicare Supplement business, so a single organization's Portal
-- Logins list can hold separate submission/portal entries per line of
-- business instead of relying on fixed single-value URL fields.
alter table organization_portal_logins add column if not exists line_of_business text;
