-- =============================================================================
-- Allegations: buyers/partners/clients report an allegation or compliance
-- concern against an organization or agent via a fully public, unauthenticated
-- form (no Partner Portal login required -- shareable link, matching the
-- Monday.com "New Allegation Request" form this replaces). Admin reviews and
-- tracks investigation status from the Compliance Portal.
--
-- Unlike Material Submissions (an authenticated partner writing their own
-- org-scoped row), a public reporter has no session and no org_id at all --
-- RLS here is insert-only-open for anon, with NO select policy for anon/
-- partner, so a submitted report can never be read back by the public or by
-- any Partner Portal login. Only is_admin() can read, update, or delete.
-- =============================================================================

create table allegations (
  id                    uuid primary key default gen_random_uuid(),
  reporter_name         text not null,
  reporter_email        text not null,
  reporter_phone        text,
  reporter_organization text,
  reported_org_name     text,
  reported_agent_name   text,
  carrier_product       text,
  incident_date         date,
  description           text not null,
  status                text not null default 'Open' check (status in ('Open', 'Investigating', 'Resolved', 'Dismissed')),
  investigation_notes   text,
  resolved_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index idx_allegations_status on allegations(status);

alter table allegations enable row level security;

create policy admin_all_allegations on allegations for all
  using (is_admin()) with check (is_admin());

-- Open to anyone, including anonymous/unauthenticated requests -- this is
-- the public intake form's write path. No select/update/delete policy
-- exists for anon, so a submission can never be read back once sent.
create policy public_insert_allegations on allegations for insert
  to anon
  with check (true);

create trigger allegations_touch
  before update on allegations
  for each row execute function touch_updated_at();

create table allegation_files (
  id            uuid primary key default gen_random_uuid(),
  allegation_id uuid not null references allegations(id) on delete cascade,
  file_path     text not null,
  file_name     text not null,
  created_at    timestamptz not null default now()
);
create index idx_allegation_files_allegation on allegation_files(allegation_id);

alter table allegation_files enable row level security;

create policy admin_all_allegation_files on allegation_files for all
  using (is_admin()) with check (is_admin());

create policy public_insert_allegation_files on allegation_files for insert
  to anon
  with check (true);

-- Storage: evidence files attached to a public allegation report. Open
-- insert (same trust model as the row above -- an anonymous reporter has
-- no session to scope a policy to), admin-only read so evidence stays
-- private to the compliance team.
insert into storage.buckets (id, name, public)
values ('allegation-evidence', 'allegation-evidence', false)
on conflict (id) do nothing;

create policy allegation_evidence_public_insert on storage.objects for insert
  to anon
  with check (bucket_id = 'allegation-evidence');

create policy allegation_evidence_admin_read on storage.objects for select
  using (bucket_id = 'allegation-evidence' and is_admin());
