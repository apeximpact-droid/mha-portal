-- Materials Needing Submitted -- a per-plan-year toggle on each Partner
-- Organization plus a free-text note of which organization the outstanding
-- materials pertain to. Separate columns per plan year since PY26 and PY27
-- outstanding materials may point at different organizations.
alter table organizations
  add column if not exists py26_materials_needing_submitted boolean not null default false,
  add column if not exists py26_materials_needing_submitted_org text,
  add column if not exists py27_materials_needing_submitted boolean not null default false,
  add column if not exists py27_materials_needing_submitted_org text;
