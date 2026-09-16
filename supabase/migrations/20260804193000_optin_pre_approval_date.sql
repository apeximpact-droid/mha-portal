-- Pre-Approval Date: a separate date from optin_date (when the carrier
-- confirmed the opt-in) -- this tracks when the carrier pre-approved the
-- material for that carrier, before/independent of the opt-in confirmation.
alter table material_carrier_optins
  add column if not exists pre_approval_date date;
