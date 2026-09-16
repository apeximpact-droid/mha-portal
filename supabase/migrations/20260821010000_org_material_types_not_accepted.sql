-- Per-organization list of Marketing Material Types that org does not
-- accept for compliance review, so admin can see at a glance which types
-- (Print, Digital/Banner, Social Media, etc.) to steer that org away from
-- before it becomes a rejected Material Submission.
alter table organizations
  add column if not exists material_types_not_accepted text[];
