-- Add Organization Name and Submitter Name to the allegations intake form,
-- rename partner_poc_email to submitter_email to match (the field always
-- meant "the person submitting this report", not specifically an org's
-- POC), and make Email Thread Title / Allegation Form Link optional --
-- neither applies when the allegation wasn't also sent by email or backed
-- by a carrier/portal form.
alter table allegations
  add column if not exists org_name text not null default '',
  add column if not exists submitter_name text not null default '';

alter table allegations
  alter column org_name drop default,
  alter column submitter_name drop default;

alter table allegations rename column partner_poc_email to submitter_email;

alter table allegations
  alter column email_thread_title drop not null,
  alter column allegation_form_link drop not null;
