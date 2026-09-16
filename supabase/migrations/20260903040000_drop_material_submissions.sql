-- The admin-side "Material Submissions" tool (partner orgs self-submitting
-- marketing materials for review) was removed from the admin portal and the
-- Worker on 2026-09-03. Drop the now-orphaned tables (files first: FK ->
-- submissions).
--
-- The matching Storage bucket, `material-submission-files`, cannot be removed
-- from SQL (Supabase's storage.protect_delete() trigger blocks direct deletes
-- on storage.objects / storage.buckets). Remove it from the dashboard instead:
-- Storage -> material-submission-files -> "Empty bucket" -> "Delete bucket".
drop table if exists material_submission_files cascade;
drop table if exists material_submissions cascade;
