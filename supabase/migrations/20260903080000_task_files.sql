-- Task attachments: any number of files per task, addable after the task is
-- saved. Rows here, bytes in the private `task-files` bucket. Admin-only like
-- tasks themselves: RLS with a deny-all policy, so the Partner Portal's
-- anon/authenticated sessions can never touch them -- only the Worker's
-- service-role key (which bypasses RLS) can.
create table if not exists task_files (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null references tasks(id) on delete cascade,
  file_name    text not null,
  storage_path text not null,
  uploaded_at  timestamptz not null default now()
);
create index if not exists idx_task_files_task_id on task_files(task_id);

alter table task_files enable row level security;
create policy task_files_no_client_access on task_files for all
  using (false) with check (false);

insert into storage.buckets (id, name, public)
values ('task-files', 'task-files', false)
on conflict (id) do nothing;
