-- Add "Final Expense" as a third submission-form type, alongside Medicare
-- Advantage (form_type='standard') and Medicare Supplement.
alter table organization_submission_forms drop constraint if exists organization_submission_forms_form_type_check;
alter table organization_submission_forms add constraint organization_submission_forms_form_type_check
  check (form_type in ('standard', 'medicare_supplement', 'final_expense'));

-- A submission form entry can now apply to more than one plan year at once
-- (checkboxes in the UI instead of a single-select dropdown), so plan_year
-- becomes a plan_years array. Existing rows are backfilled from their old
-- single value.
alter table organization_submission_forms add column if not exists plan_years text[];
update organization_submission_forms set plan_years = array[plan_year] where plan_years is null;
alter table organization_submission_forms alter column plan_years set not null;
alter table organization_submission_forms drop constraint if exists organization_submission_forms_plan_year_check;
alter table organization_submission_forms drop column if exists plan_year;
alter table organization_submission_forms add constraint organization_submission_forms_plan_years_check
  check (plan_years <@ array['PY26','PY27']::text[] and array_length(plan_years,1) > 0);
