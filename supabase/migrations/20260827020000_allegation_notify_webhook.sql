-- Fires an outbound HTTP call to the Worker every time a new row lands in
-- `allegations` (from either submission path: the public allegations.html
-- form or the in-portal Allegation/Audit Request tab -- both just INSERT
-- directly into this table under RLS, so a trigger here is the one place
-- that reliably sees every submission regardless of which path it came
-- from). The Worker's /allegations/notify route (see worker.js) turns that
-- into an email via Resend, sent to ALLEGATION_NOTIFY_EMAIL
-- (compliance@myhealthangel.com).
--
-- pg_net's http_post is fire-and-forget/async -- it queues the request and
-- returns immediately, so a slow or failing email send never blocks or
-- fails the allegation insert itself.
--
-- BEFORE RUNNING: replace both placeholders below with your real deployed
-- Worker URL and a random secret string of your choosing (must match the
-- ALLEGATION_WEBHOOK_SECRET you set as a Worker secret -- see worker.js's
-- top-of-file docstring).
create extension if not exists pg_net with schema extensions;

create or replace function notify_new_allegation() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform net.http_post(
    url := 'REPLACE_WITH_YOUR_WORKER_URL/allegations/notify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-webhook-secret', 'REPLACE_WITH_YOUR_ALLEGATION_WEBHOOK_SECRET'
    ),
    body := to_jsonb(NEW)
  );
  return NEW;
end;
$$;

drop trigger if exists allegations_notify_after_insert on allegations;
create trigger allegations_notify_after_insert
  after insert on allegations
  for each row execute function notify_new_allegation();
