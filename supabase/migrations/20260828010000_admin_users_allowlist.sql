-- Admin login for the CRM Admin Portal (see admin/index.html's new
-- login/signup/2FA screen). This table is an ALLOWLIST only -- it does not
-- create any accounts or passwords itself. Each admin signs up themselves
-- (their own email + their own chosen password) via the app's own signup
-- form; that form calls is_allowed_admin_email() below before allowing
-- signUp() to succeed, so only these pre-approved addresses can ever
-- create an account. Add more rows here any time to admit another admin.
create table if not exists admin_users (
  email       text primary key,
  created_at  timestamptz not null default now()
);

alter table admin_users enable row level security;

-- No client (anon or authenticated) has any direct read/write access to
-- this table -- membership is checked exclusively through the
-- SECURITY DEFINER RPC below, so the full list of admin emails is never
-- exposed to the browser.
create policy admin_users_no_client_access on admin_users for all
  using (false) with check (false);

create or replace function is_allowed_admin_email(check_email text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from admin_users where email = lower(trim(check_email))
  );
$$;

grant execute on function is_allowed_admin_email(text) to anon, authenticated;

-- My Health Angel's admin team. Emails are stored lowercase; the login check
-- and the task assignee list both compare case-insensitively. To add someone
-- later:  insert into admin_users (email) values ('name@myhealthangel.com');
insert into admin_users (email) values
  ('amorman@myhealthangel.com'),
  ('compliance@myhealthangel.com'),
  ('hsolis@myhealthangel.com'),
  ('contato@caroline.art.br'),
  ('mgeorge@myhealthangel.com'),
  ('vnaevov@myhealthangel.com'),
  ('tlacayo@myhealthangel.com'),
  ('nritter@myhealthangel.com'),
  ('keith@myhealthangel.com'),
  ('dstein@myhealthangel.com'),
  ('dfeldman@myhealthangel.com')
on conflict (email) do nothing;
