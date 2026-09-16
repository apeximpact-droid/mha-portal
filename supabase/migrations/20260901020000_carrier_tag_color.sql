-- Admin-editable per-carrier tag color (e.g. Humana's own brand color),
-- shown as a colored chip anywhere a carrier name is rendered as a tag.
alter table carrier_organizations
  add column if not exists color text;
