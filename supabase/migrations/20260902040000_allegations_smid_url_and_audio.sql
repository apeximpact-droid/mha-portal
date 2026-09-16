-- Admin-only fields, not present on the public allegation submission form:
-- SMID and Corresponding URL, plus an optional uploaded audio recording of
-- the call (one per allegation, same single-file pattern as the org/carrier
-- submission form file uploads). Reuses the allegation-evidence bucket that
-- already exists from the original allegations design (left in place when
-- the file-upload field was dropped from the public form).
alter table allegations
  add column if not exists smid text,
  add column if not exists corresponding_url text,
  add column if not exists audio_file_path text,
  add column if not exists audio_file_name text;
