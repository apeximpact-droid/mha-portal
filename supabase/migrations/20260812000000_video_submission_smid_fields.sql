-- The real MHA "Video Submission Template" documents have a metadata
-- block above the scene table (Material Type, SMID, Previous SMID,
-- Corresponding URLs) and a footer line (Static End Screen Disclaimer +
-- SMID) that the exported docx needs to fill in verbatim. These didn't
-- exist on the submission yet -- only end_screen_disclaimer did.
alter table video_submissions add column if not exists smid text;
alter table video_submissions add column if not exists previous_smid text;
alter table video_submissions add column if not exists corresponding_urls text;
