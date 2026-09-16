-- Replaces the allegations field set with the real fields from the actual
-- source form (Monday.com "New Allegation Request", confirmed field-by-field
-- against screenshots) -- the original schema guessed a generic
-- reporter/reported-party shape before the real form was available, and
-- never had any real submissions, so this cleanly replaces it rather than
-- leaving permanently-dead guessed columns around.
--
-- No file-upload field exists on the real form, so allegation_files and its
-- storage bucket/policies (never used) are dropped entirely too.
drop table if exists allegation_files;
-- Not dropping the allegation-evidence bucket/objects here: Supabase blocks
-- direct DELETE on storage.objects/storage.buckets via SQL ("Direct deletion
-- from storage tables is not allowed. Use the Storage API instead."). It
-- held exactly one test object from debugging, now orphaned and harmless --
-- left in place rather than routing through the Storage API for this.

alter table allegations
  drop column if exists reporter_name,
  drop column if exists reporter_email,
  drop column if exists reporter_phone,
  drop column if exists reporter_organization,
  drop column if exists reported_org_name,
  drop column if exists reported_agent_name,
  drop column if exists carrier_product,
  drop column if exists incident_date,
  drop column if exists description,
  add column if not exists receival_date date not null default current_date,
  add column if not exists due_date date not null default current_date,
  add column if not exists email_thread_title text not null default '',
  add column if not exists allegation_form_link text not null default '',
  add column if not exists partner_poc_email text not null default '',
  add column if not exists lead_date date not null default current_date,
  add column if not exists lead_phone_country_code text not null default '+1',
  add column if not exists lead_phone_number text not null default '',
  add column if not exists lead_name text not null default '',
  add column if not exists call_duration text not null default '';

-- The `not null default ''`/`default current_date` above exist only so the
-- ALTER succeeds cleanly against an empty table; drop the defaults now so
-- every real submission is forced to supply its own value.
alter table allegations
  alter column receival_date drop default,
  alter column due_date drop default,
  alter column email_thread_title drop default,
  alter column allegation_form_link drop default,
  alter column partner_poc_email drop default,
  alter column lead_date drop default,
  alter column lead_phone_country_code set default '+1',
  alter column lead_phone_number drop default,
  alter column lead_name drop default,
  alter column call_duration drop default;
