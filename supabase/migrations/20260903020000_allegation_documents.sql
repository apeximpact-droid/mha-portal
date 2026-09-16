-- Admin-uploaded "Clean and Final" documents associated with an allegation's
-- SMID. One allegation can have any number of documents, added at any time
-- (not just when the allegation is first reviewed) -- same admin-only,
-- reuse-the-evidence-bucket pattern as the audio recording.
create table if not exists allegation_documents (
  id uuid primary key default gen_random_uuid(),
  allegation_id uuid not null references allegations(id) on delete cascade,
  file_name text not null,
  storage_path text not null,
  uploaded_at timestamptz not null default now()
);

create index if not exists allegation_documents_allegation_id_idx
  on allegation_documents(allegation_id);
