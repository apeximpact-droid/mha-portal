-- Line of business is now multi-select (a portal login can serve more than
-- one line of business at once), so this becomes an array instead of a
-- single value. Existing single values are preserved as one-element arrays.
alter table organization_portal_logins
  alter column line_of_business type text[]
  using case when line_of_business is null then null else array[line_of_business] end;
