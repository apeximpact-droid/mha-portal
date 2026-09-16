-- Both "Partner Submission Form" and "Medicare Supplement Submission Form"
-- become repeatable lists instead of a single fixed URL, since a partner
-- can have a separate submission form link per plan year (PY26 vs PY27).
-- form_type distinguishes which of the two original fields an entry
-- belongs to. Admin-only, same is_admin() gate as every other admin-only
-- table in this schema.
create table if not exists organization_submission_forms (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  form_type   text not null check (form_type in ('standard', 'medicare_supplement')),
  url         text not null,
  plan_year   text not null check (plan_year in ('PY26', 'PY27')),
  created_at  timestamptz not null default now()
);
create index if not exists idx_org_submission_forms_org on organization_submission_forms(org_id);

alter table organization_submission_forms enable row level security;
drop policy if exists admin_all_org_submission_forms on organization_submission_forms;
create policy admin_all_org_submission_forms on organization_submission_forms for all
  using (is_admin()) with check (is_admin());
