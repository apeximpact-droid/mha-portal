-- Point-of-contact details for each partner login, plus the admin-side gap
-- this closes: today there's no way for admin to see who a login's email
-- actually belongs to, or to reach them by phone / reset their password.
alter table users add column if not exists first_name text;
alter table users add column if not exists last_name text;
alter table users add column if not exists phone_number text;
