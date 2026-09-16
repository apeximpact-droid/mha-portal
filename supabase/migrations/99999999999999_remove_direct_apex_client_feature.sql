-- =============================================================================
-- Remove the Direct Apex Client feature entirely
-- =============================================================================
-- The Direct Apex Client / Affiliate Organizations feature (introduced in
-- 20260818010000_material_owner.sql, 20260818050000_direct_apex_clients.sql,
-- 20260818070000_direct_client_material_shares_affiliate_read.sql,
-- 20260819010000_org_portal_login_direct_clients.sql,
-- 20260820010000_backfill_direct_client_links_from_tags.sql,
-- 20260821030000_material_direct_client_tags.sql (already dropped again by
-- 20260824110000_drop_material_direct_client_tags.sql),
-- and 20260825140000_scope_affiliate_portal_logins_by_direct_client.sql) is
-- an Apex-specific concept that has no meaning for My Health Angel as a
-- standalone system. All of those migrations are kept AS-IS earlier in this
-- history -- on purpose -- because the developer's new database is populated
-- by restoring a pg_dump data export taken from the live Apex production
-- database, and that restore needs every column/table the export's data
-- actually lives in to already exist, or it fails with "column/table does
-- not exist". This migration runs LAST (after the data restore) and tears
-- the feature back down once the data has landed.
--
-- Order matters:
--   1. Data cleanup first, while the old policies/functions are still in
--      place (the migration role isn't subject to RLS, so this ordering is
--      not strictly required for correctness, but it mirrors the intended
--      "clean up the data this feature produced, then remove the feature"
--      sequence).
--   2. Redefine can_see_material() and read_own_share to drop their
--      affiliate clauses BEFORE dropping can_see_as_affiliate(). Both
--      currently call it in their body (a SQL-language function body creates
--      a real pg_depend dependency on any function it calls) -- dropping
--      can_see_as_affiliate() first, even with CASCADE, would take
--      can_see_material() down with it, and can_see_material() gates most of
--      the partner-facing RLS surface (materials, material_files,
--      material_carrier_optins, messages, material_org_status, the
--      material-files storage bucket, geotargeting grids). That is far too
--      large a blast radius for a "remove one feature" migration.
--   3. Only once nothing references it any more do we drop the
--      affiliate-only policies, the can_see_as_affiliate() function itself,
--      and the Direct-Apex-Client-only columns/tables.
--
-- The two org ids below are the only rows in this data set ever flagged as a
-- Direct Apex Client relationship in Apex's live database:
--   0eb4febc-cc2a-44bf-ae96-6d29b2bbc85f = My Health Angel's own organization (KEPT)
--   946a2aeb-f672-4010-bd56-e2ec432e16f7 = the other affiliate, BroadBase Media
--                                          (REMOVED -- it has no place in
--                                          My Health Angel's standalone system)
-- If you are setting up with NO data import, this whole section is a no-op.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Data cleanup
-- -----------------------------------------------------------------------------

-- Portal logins tagged exclusively to the other affiliate (i.e. NOT also
-- tagged to My Health Angel's own org) existed only for that affiliate
-- relationship and go with it.
delete from organization_portal_logins
where direct_client_org_ids @> array['946a2aeb-f672-4010-bd56-e2ec432e16f7']::uuid[]
  and not (direct_client_org_ids @> array['0eb4febc-cc2a-44bf-ae96-6d29b2bbc85f']::uuid[]);

-- The other affiliate's organization itself. `on delete cascade` on org_id across users,
-- material_shares, material_org_status, material_status_history, messages,
-- organization_guideline_documents, organization_submission_forms, the
-- remaining organization_portal_logins rows, organization_msa_documents,
-- material_submissions, and direct_client_org_links (both as
-- direct_client_org_id and as linked_org_id) cleans up everything that
-- belonged to it. material_owner.owned_by_org_id and the
-- organization_guideline_documents/organization_msa_documents
-- .assigned_org_id columns are `on delete set null`, not cascade -- that's
-- fine: material_owner is dropped outright below, and assigned_org_id is
-- just an admin label that can live on documents belonging to other
-- organizations, so nulling it out is harmless, not data loss.
--
-- NOTE: this does NOT delete the corresponding Supabase Auth user account(s)
-- for that organization's partner logins. `users.id references auth.users(id)
-- on delete cascade` only cascades from auth.users down to the public.users
-- profile row, not the other direction -- deleting the organizations row
-- removes the profile row but leaves an orphaned auth.users account behind.
-- Remove those separately via the Supabase Auth admin panel/API if they
-- should go too.
delete from organizations where id = '946a2aeb-f672-4010-bd56-e2ec432e16f7';

-- -----------------------------------------------------------------------------
-- 2. Strip the affiliate clause out of the function/policy that still need
--    to exist afterward, BEFORE touching can_see_as_affiliate()
-- -----------------------------------------------------------------------------

-- Restored to its pre-Direct-Apex-Client body, exactly as originally defined
-- in 20260804013500_initial_schema.sql.
create or replace function can_see_material(m uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select is_admin() or exists (
    select 1 from material_shares s
    where s.material_id = m and s.org_id = current_org_id()
  );
$$;

-- Restored to its pre-Direct-Apex-Client body, exactly as originally defined
-- in 20260804013500_initial_schema.sql. (Rewritten by
-- 20260818070000_direct_client_material_shares_affiliate_read.sql to add
-- the now-removed `or can_see_as_affiliate(org_id)` clause.)
drop policy if exists read_own_share on material_shares;
create policy read_own_share on material_shares for select
  using (is_admin() or org_id = current_org_id());

-- -----------------------------------------------------------------------------
-- 3. Drop every affiliate-only policy, the function they all leaned on, and
--    the Direct-Apex-Client-only columns/tables
-- -----------------------------------------------------------------------------

-- There is no more "affiliate" relationship to grant read access through --
-- these are dropped outright, not rewritten.
drop policy if exists affiliate_read_orgs on organizations;
drop policy if exists affiliate_read_org_guideline_documents on organization_guideline_documents;
drop policy if exists affiliate_read_org_submission_forms on organization_submission_forms;
drop policy if exists affiliate_read_org_portal_logins on organization_portal_logins;
-- Storage policy from 20260818050000_direct_apex_clients.sql that let an
-- affiliate-linked partner download another org's guideline document PDFs.
drop policy if exists organization_documents_affiliate_guideline_read on storage.objects;

-- Safe now that nothing above still calls it -- left without CASCADE
-- deliberately, so if some other dependency was missed this fails loudly
-- instead of silently dropping an unrelated policy.
drop function if exists can_see_as_affiliate(uuid);

alter table organizations drop column if exists is_direct_apex_client;
alter table organization_portal_logins drop column if exists direct_client_org_ids;

drop table if exists direct_client_org_links;

-- "Owned By" only ever meant "which Direct Apex Client owns this material" --
-- meaningless without the feature. This is its own table (material_owner),
-- not a column on materials.
drop table if exists material_owner;
