-- Records, as a real migration, a change made live during debugging: the
-- combined "for all" admin_all_allegations policy is split into separate
-- select/update/delete policies. This was done to rule out a multi-policy
-- interaction while diagnosing why a public INSERT ... RETURNING failed --
-- it turned out RETURNING triggers Postgres to also check the new row
-- against the SELECT policy, which (correctly) denies anon, so the actual
-- fix was removing RETURNING/.select() from the client's insert call, not
-- this split. Kept anyway since it's a harmless, equivalent restructuring
-- and this migration exists so the repo's history matches the live schema.
drop policy if exists admin_all_allegations on allegations;
create policy allegations_admin_select on allegations for select using (is_admin());
create policy allegations_admin_update on allegations for update using (is_admin()) with check (is_admin());
create policy allegations_admin_delete on allegations for delete using (is_admin());
