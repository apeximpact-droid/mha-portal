-- Internal Tasks: a simple assignable to-do list for the CRM Admin Portal.
-- Admin-only, same access model as apex_operational_logins/admin_users --
-- no direct client access, every read/write goes through the Worker's
-- service-role key. assigned_to/created_by store the admin's email
-- directly (references admin_users, the same allowlist used for login)
-- rather than a separate id, since the Worker's admin-auth model has no
-- other durable per-admin identifier to key off of. org_id/direct_client_org_id
-- both reference organizations (a Direct Client is just an org with
-- is_direct_apex_client = true) -- kept as two separate nullable columns so
-- a task can independently tag a regular organization and/or a direct
-- client rather than being forced into one merged dropdown.
create table if not exists tasks (
  id                    uuid primary key default gen_random_uuid(),
  title                 text not null,
  description           text,
  assigned_to           text not null references admin_users(email),
  created_by            text references admin_users(email),
  status                text not null default 'Open' check (status in ('Open','In Progress','Completed')),
  due_date              date,
  submission_date       date,
  org_id                uuid references organizations(id),
  direct_client_org_id  uuid references organizations(id),
  carrier_id            uuid references carrier_organizations(id),
  portal_link           text,
  email_thread_title    text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists idx_tasks_assigned_to on tasks(assigned_to);
create index if not exists idx_tasks_status on tasks(status);

alter table tasks enable row level security;
create policy tasks_no_client_access on tasks for all
  using (false) with check (false);

-- Fires on every new task so the assigned admin gets an email with the
-- task's details. Same fire-and-forget pg_net pattern as
-- notify_new_allegation() -- a slow/failing email send never blocks or
-- fails the task insert itself.
create or replace function notify_new_task() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform net.http_post(
    url := 'REPLACE_WITH_YOUR_WORKER_URL/tasks/notify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-webhook-secret', '516c74895002471b8304d44c67fa9fc76906a3e22e434e28'
    ),
    body := to_jsonb(NEW)
  );
  return NEW;
end;
$$;

drop trigger if exists tasks_notify_after_insert on tasks;
create trigger tasks_notify_after_insert
  after insert on tasks
  for each row execute function notify_new_task();
