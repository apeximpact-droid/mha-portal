-- Admin-only tag on each individual material for which Direct Apex Client(s)
-- it belongs to. Purely a label for admin-side organization/filtering --
-- does NOT grant a Direct Apex Client's own login any visibility (that stays
-- governed entirely by material_shares / direct_client_org_links, per
-- can_see_material()).
--
-- Deliberately its own table with admin-only RLS, NOT a column on materials
-- itself -- RLS is row-level, not column-level, and materials rows are
-- already partner-readable (gated by can_see_material()), so any column
-- added directly to materials would technically be fetchable by a partner's
-- own session via an explicit PostgREST column selection, even though the
-- client app's own query never asks for it. Keeping this as a separate
-- table with only an admin_all policy (no partner policy at all, on this
-- table or in storage) is the same pattern material_owner already uses.
create table material_direct_client_tags (
  id                    uuid primary key default gen_random_uuid(),
  material_id           uuid not null references materials(id) on delete cascade,
  direct_client_org_id  uuid not null references organizations(id) on delete cascade,
  created_at            timestamptz not null default now(),
  unique (material_id, direct_client_org_id)
);
create index idx_material_direct_client_tags_material on material_direct_client_tags(material_id);

alter table material_direct_client_tags enable row level security;
create policy admin_all_material_direct_client_tags on material_direct_client_tags for all
  using (is_admin()) with check (is_admin());
