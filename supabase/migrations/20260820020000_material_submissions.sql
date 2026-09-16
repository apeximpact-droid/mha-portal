-- =============================================================================
-- Material Submissions: outside/partner organizations submit their own
-- marketing materials to Apex for compliance review, directly from the
-- Partner Portal (client app), using their own authenticated session --
-- unlike every other admin-authored feature in this schema, the INSERT here
-- is partner-initiated and RLS-gated (org_id = current_org_id()), mirroring
-- how `messages` and `material_org_status` already let a partner write their
-- own org-scoped rows. Admin review/status changes go through the Worker
-- (service-role key), same as every other admin-side CRUD in this app.
--
-- A rejected/needs-changes submission can be resubmitted as a new version,
-- linked back to the prior version via parent_submission_id, so the full
-- review history of one piece of creative stays traceable.
-- =============================================================================

create table material_submissions (
  id                              uuid primary key default gen_random_uuid(),
  org_id                          uuid not null references organizations(id) on delete cascade,
  submitter_name                  text not null,
  submitter_email                 text not null,
  submitter_phone                 text,
  material_type                   text not null,
  carrier_tags                    text[],
  line_of_business                text[],
  attestation_reviewed_guidelines boolean not null default false,
  attestation_meets_requirements  boolean not null default false,
  attestation_changes_made        boolean,
  attestation_owns_creative       boolean not null default false,
  status                          text not null default 'Pending' check (status in ('Pending', 'Approved', 'Rejected', 'Needs Changes')),
  review_notes                    text,
  reviewed_at                     timestamptz,
  version                         int not null default 1,
  parent_submission_id            uuid references material_submissions(id) on delete set null,
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now()
);
create index idx_material_submissions_org on material_submissions(org_id);
create index idx_material_submissions_parent on material_submissions(parent_submission_id);

alter table material_submissions enable row level security;

drop policy if exists admin_all_material_submissions on material_submissions;
create policy admin_all_material_submissions on material_submissions for all
  using (is_admin()) with check (is_admin());

-- Partner can create and read their own org's submissions, but cannot
-- update/delete after submitting -- only admin can change status/notes.
drop policy if exists partner_insert_own_material_submissions on material_submissions;
create policy partner_insert_own_material_submissions on material_submissions for insert
  with check (org_id = current_org_id());

drop policy if exists partner_select_own_material_submissions on material_submissions;
create policy partner_select_own_material_submissions on material_submissions for select
  using (org_id = current_org_id());

create trigger material_submissions_touch
  before update on material_submissions
  for each row execute function touch_updated_at();

create table material_submission_files (
  id            uuid primary key default gen_random_uuid(),
  submission_id uuid not null references material_submissions(id) on delete cascade,
  file_path     text not null,
  file_name     text not null,
  created_at    timestamptz not null default now()
);
create index idx_material_submission_files_submission on material_submission_files(submission_id);

alter table material_submission_files enable row level security;

drop policy if exists admin_all_material_submission_files on material_submission_files;
create policy admin_all_material_submission_files on material_submission_files for all
  using (is_admin()) with check (is_admin());

drop policy if exists partner_insert_own_material_submission_files on material_submission_files;
create policy partner_insert_own_material_submission_files on material_submission_files for insert
  with check (exists (
    select 1 from material_submissions ms
    where ms.id = submission_id and ms.org_id = current_org_id()
  ));

drop policy if exists partner_select_own_material_submission_files on material_submission_files;
create policy partner_select_own_material_submission_files on material_submission_files for select
  using (exists (
    select 1 from material_submissions ms
    where ms.id = submission_id and ms.org_id = current_org_id()
  ));

-- Storage: the first partner-writable bucket in this schema. Path convention
-- is orgs/{org_id}/{submission_id}/{filename}, matching the "orgs/{org_id}/..."
-- convention used by every other org-scoped bucket -- the (storage.foldername
-- (name))[2] segment is the org id, checked against current_org_id() so a
-- partner can only write/read under their own org's folder. Admin gets full
-- access via is_admin(), same as every other bucket.
insert into storage.buckets (id, name, public)
values ('material-submission-files', 'material-submission-files', false)
on conflict (id) do nothing;

drop policy if exists material_submission_files_partner_rw on storage.objects;
create policy material_submission_files_partner_rw on storage.objects for all
  using (
    bucket_id = 'material-submission-files'
    and (
      is_admin()
      or (storage.foldername(name))[1] = 'orgs'
      and (storage.foldername(name))[2] = current_org_id()::text
    )
  )
  with check (
    bucket_id = 'material-submission-files'
    and (
      is_admin()
      or (storage.foldername(name))[1] = 'orgs'
      and (storage.foldername(name))[2] = current_org_id()::text
    )
  );
