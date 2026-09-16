-- =============================================================================
-- Internal status -- admin-only, never visible to a partner
-- =============================================================================
-- Deliberately its own table, not a column on `materials`. RLS in Postgres
-- is row-level, not column-level -- a partner's SELECT on `materials` would
-- still return this value if it were just a column there, regardless of
-- what the client-side query happens to ask for (the anon key is public;
-- RLS is the real boundary, not omission in a hand-written select list).
-- Putting it in its own table with an admin-only policy and NO partner
-- policy at all means a partner gets zero rows back, full stop.
create table material_internal_status (
  material_id uuid primary key references materials(id) on delete cascade,
  status      text not null default 'In Development',
  updated_at  timestamptz not null default now()
);

alter table material_internal_status enable row level security;

create policy admin_all_internal_status on material_internal_status for all
  using (public.is_admin()) with check (public.is_admin());

create trigger material_internal_status_touch
  before update on material_internal_status
  for each row execute function touch_updated_at();
