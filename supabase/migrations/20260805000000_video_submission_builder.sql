-- =============================================================================
-- Video Submission Builder -- standalone admin-only tool, never visible to
-- partners and never nested inside a material record. Admin starts a
-- submission, uploads a video, marks scenes (real captured screenshot +
-- AI-drafted on-screen language via Claude vision + AI-drafted voiceover
-- transcript via Cloudflare Workers AI Whisper, both editable before
-- export). material_id stays null until admin explicitly finishes and
-- chooses "Create Marketing Material" -- the video file and scene
-- screenshots are never copied into the partner-readable materials bucket,
-- so a partner can never see or reach this tool regardless of sharing.
-- =============================================================================
create table video_submissions (
  id                    uuid primary key default gen_random_uuid(),
  title                 text not null,
  end_screen_disclaimer text,
  template              text,
  video_file_name       text,
  storage_path          text,
  duration_seconds      numeric,
  material_id           uuid references materials(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

alter table video_submissions enable row level security;

create policy admin_all_video_submissions on video_submissions for all
  using (public.is_admin()) with check (public.is_admin());

create trigger video_submissions_touch
  before update on video_submissions
  for each row execute function touch_updated_at();

create table video_submission_scenes (
  id                 uuid primary key default gen_random_uuid(),
  submission_id      uuid not null references video_submissions(id) on delete cascade,
  scene_order        int not null,
  start_seconds      numeric not null,
  end_seconds        numeric not null,
  screenshot_path    text,             -- object-storage key in material-video-assets
  on_screen_language text,
  voiceover_script   text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index on video_submission_scenes(submission_id, scene_order);

alter table video_submission_scenes enable row level security;

create policy admin_all_video_submission_scenes on video_submission_scenes for all
  using (public.is_admin()) with check (public.is_admin());

create trigger video_submission_scenes_touch
  before update on video_submission_scenes
  for each row execute function touch_updated_at();

-- Separate, admin-only bucket -- source videos and scene screenshots are
-- both large/numerous enough to warrant their own bucket rather than
-- crowding material-admin-files, but the RLS shape is identical: nothing
-- here is ever reachable by a partner's own Supabase session.
insert into storage.buckets (id, name, public)
values ('material-video-assets', 'material-video-assets', false)
on conflict (id) do nothing;

create policy material_video_assets_admin_only on storage.objects for all
  using (bucket_id = 'material-video-assets' and public.is_admin())
  with check (bucket_id = 'material-video-assets' and public.is_admin());
