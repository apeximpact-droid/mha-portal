-- =============================================================================
-- Owned By -- admin-only, never visible to a partner
-- =============================================================================
-- Same reasoning as material_internal_status: its own table with an
-- admin-only policy and no partner policy at all, rather than a column on
-- `materials` a partner client's own select list just happens not to ask
-- for. RLS is row-level, not column-level, so omission alone is not a
-- security boundary -- a raw select('*') under a partner's own session
-- would still return it if it lived on `materials` itself.
create table material_owner (
  material_id      uuid primary key references materials(id) on delete cascade,
  owned_by_org_id  uuid references organizations(id) on delete set null,
  updated_at       timestamptz not null default now()
);

alter table material_owner enable row level security;

create policy admin_all_material_owner on material_owner for all
  using (public.is_admin()) with check (public.is_admin());

create trigger material_owner_touch
  before update on material_owner
  for each row execute function touch_updated_at();
