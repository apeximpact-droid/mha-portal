-- Supabase's default per-object Storage limit is 50MB, which real Medicare
-- marketing video files (even short 30-90s clips) can exceed. Raise the
-- material-video-assets bucket's own limit to 500MB -- this only works on a
-- paid Supabase plan; on the Free plan Supabase enforces a hard 50MB cap
-- project-wide regardless of this setting, and the update below is a no-op.
update storage.buckets
set file_size_limit = 524288000 -- 500MB in bytes
where id = 'material-video-assets';
