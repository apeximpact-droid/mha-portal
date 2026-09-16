-- Benefit Type is now multi-select (a material can offer more than one
-- benefit type at once), so this becomes an array instead of a single
-- value. Existing single values are preserved as one-element arrays.
alter table materials
  alter column benefit_type type text[]
  using case when benefit_type is null then null else array[benefit_type] end;
