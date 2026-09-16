-- Fix: the anon-scoped insert policies from the allegations migration
-- rejected real inserts ("new row violates row-level security policy"),
-- confirmed via a live test against the deployed anon key. Re-create them
-- without the `to anon` role restriction, matching every other policy in
-- this schema (they all omit the role clause and gate purely through
-- USING/WITH CHECK), and add the explicit table/schema grants a brand-new
-- public-facing table needs for the anon role in Postgres, since RLS is a
-- second gate on top of the underlying grant, not a replacement for it.
drop policy if exists public_insert_allegations on allegations;
create policy public_insert_allegations on allegations for insert
  with check (true);

drop policy if exists public_insert_allegation_files on allegation_files;
create policy public_insert_allegation_files on allegation_files for insert
  with check (true);

grant usage on schema public to anon;
grant insert on allegations to anon;
grant insert on allegation_files to anon;

drop policy if exists allegation_evidence_public_insert on storage.objects;
create policy allegation_evidence_public_insert on storage.objects for insert
  with check (bucket_id = 'allegation-evidence');
