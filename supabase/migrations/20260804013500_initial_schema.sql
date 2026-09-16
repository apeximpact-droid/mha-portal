-- =============================================================================
-- Apex Digital Partner Compliance Portal — initial schema
-- Postgres 14+ / Supabase.
--
-- Adapted from apex-schema.sql (the reference/spec version) for Supabase
-- specifically. Two changes from the reference file, both anticipated by its
-- own comments:
--   1. current_user_id() uses auth.uid() instead of a session GUC -- Supabase
--      resolves the logged-in user automatically from the request's JWT.
--   2. users.id references auth.users(id) and there is no password_hash
--      column -- Supabase Auth owns credentials entirely; this table is a
--      profile/role extension of auth.users, not a credentials store.
--
-- Everything else (materials, files, opt-ins, shares, per-partner status,
-- messages, audit log, RLS policies, triggers) is unchanged from the
-- reference file at the repo root.
--
-- The row-level security policies below enforce partner isolation at the
-- DATABASE level, deliberately, so an application-layer bug cannot leak one
-- partner's data to another.
-- =============================================================================

create extension if not exists "pgcrypto";
create extension if not exists "citext";

-- =============================================================================
-- 1. ORGANIZATIONS & USERS
-- =============================================================================

create table organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text        not null,
  active      boolean     not null default true,
  created_at  timestamptz not null default now()
);

create type user_role as enum ('admin','partner');

-- Supabase: id matches auth.users(id) -- Supabase Auth owns credentials
-- entirely; this table is a profile/role extension, never stores a password.
create table users (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         citext      not null unique,
  role          user_role   not null,
  org_id        uuid        references organizations(id) on delete cascade,
  active        boolean     not null default true,
  created_at    timestamptz not null default now(),
  last_login_at timestamptz,
  -- admins have no org; partners must have one
  constraint org_required_for_partners
    check ((role = 'admin' and org_id is null) or (role = 'partner' and org_id is not null))
);
create index on users(org_id);

-- =============================================================================
-- 2. MATERIALS (creative assets)
-- =============================================================================

create type material_status as enum ('Submitted','In Review','Approved','Will Not Use');
create type classification_t as enum ('Marketing','Communications');

create table materials (
  id                     uuid primary key default gen_random_uuid(),
  smid                   text            not null,
  status                 material_status not null default 'Submitted', -- Apex's own status
  plan_year              int             not null,
  classification         classification_t not null default 'Marketing',
  is_annual_resubmission boolean         not null default false,
  medium                 text,
  benefit_type           text,
  distribution_area      text,
  time_period            text,   -- AEP / SEP / Year-Round
  election_period        text,   -- AEP Only / SEP / N/A
  start_date             date,
  end_date               date,
  hpms_filing_date       date,
  media_type             text,
  deleted_at             timestamptz,   -- soft delete (CMS retention)
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index on materials(smid);
create index on materials(plan_year);
create index on materials(deleted_at);

-- =============================================================================
-- 3. FILES & CARRIER OPT-INS
-- =============================================================================

create table material_files (
  id           uuid primary key default gen_random_uuid(),
  material_id  uuid not null references materials(id) on delete cascade,
  file_name    text not null,
  category     text,                    -- 'Clean & Final', 'HPMS Opt-In', 'Screenshot', ...
  storage_path text not null,           -- object-storage key. NOT a public URL.
  size_bytes   bigint,
  mime_type    text,
  uploaded_by  uuid references users(id),
  uploaded_at  timestamptz not null default now()
);
create index on material_files(material_id);

-- One row per carrier. A material may have many.
create table material_carrier_optins (
  id                   uuid primary key default gen_random_uuid(),
  material_id          uuid not null references materials(id) on delete cascade,
  carrier              text not null,
  opted_in             boolean not null default false,
  optin_date           date,
  confirmation_file_id uuid references material_files(id) on delete set null,
  unique (material_id, carrier)
);
create index on material_carrier_optins(material_id);

-- =============================================================================
-- 4. SHARING — this table IS the access control list
-- =============================================================================

create table material_shares (
  material_id uuid not null references materials(id) on delete cascade,
  org_id      uuid not null references organizations(id) on delete cascade,
  shared_at   timestamptz not null default now(),
  shared_by   uuid references users(id),
  primary key (material_id, org_id)
);
create index on material_shares(org_id);

-- =============================================================================
-- 5. PER-PARTNER STATUS & HISTORY
-- =============================================================================

-- Each partner tracks the material through THEIR internal process.
-- Absent row => partner sees materials.status as the default.
create table material_org_status (
  material_id uuid not null references materials(id) on delete cascade,
  org_id      uuid not null references organizations(id) on delete cascade,
  status      material_status not null,
  updated_at  timestamptz not null default now(),
  primary key (material_id, org_id)
);

create table material_status_history (
  id          uuid primary key default gen_random_uuid(),
  material_id uuid not null references materials(id) on delete cascade,
  org_id      uuid references organizations(id) on delete cascade, -- NULL = Apex-level change
  from_status text,
  to_status   text not null,
  changed_by  text not null,   -- display name, e.g. 'Apex Digital Compliance' or 'Bright Path Marketing'
  changed_at  timestamptz not null default now()
);
create index on material_status_history(material_id);
create index on material_status_history(org_id);

-- =============================================================================
-- 6. MESSAGES — one private thread per (material, org)
-- =============================================================================

create type author_t as enum ('admin','partner');

create table messages (
  id          uuid primary key default gen_random_uuid(),
  material_id uuid not null references materials(id) on delete cascade,
  org_id      uuid not null references organizations(id) on delete cascade,
  author_type author_t not null,
  author_name text     not null,
  body        text     not null,
  created_at  timestamptz not null default now()
);
create index on messages(material_id, org_id, created_at);

-- =============================================================================
-- 7. AUDIT LOG — append only
-- =============================================================================

create type audit_kind as enum ('access','status','file','item','client');

create table audit_log (
  id          bigserial primary key,
  occurred_at timestamptz not null default now(),
  actor_type  text not null,          -- 'admin' | 'partner' | 'system'
  actor_name  text not null,
  kind        audit_kind not null,
  action      text not null,          -- 'Access granted', 'Document removed', ...
  target      text,                   -- SMID or organization name
  detail      text,
  material_id uuid references materials(id) on delete set null,
  org_id      uuid references organizations(id) on delete set null,
  backfilled  boolean not null default false  -- reconstructed; date-only, no time
);
create index on audit_log(occurred_at desc);
create index on audit_log(material_id);
create index on audit_log(kind);

-- =============================================================================
-- 8. HELPERS  (Supabase flavour — auth.uid() is the logged-in user)
-- =============================================================================

create or replace function current_user_id() returns uuid
language sql stable as $$
  select auth.uid();
$$;

create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from users u
    where u.id = current_user_id() and u.role = 'admin' and u.active
  );
$$;

create or replace function current_org_id() returns uuid
language sql stable security definer set search_path = public as $$
  select u.org_id
  from users u
  join organizations o on o.id = u.org_id
  where u.id = current_user_id() and u.active and o.active;
$$;

-- true only if the caller's org has been granted this material
create or replace function can_see_material(m uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select is_admin() or exists (
    select 1 from material_shares s
    where s.material_id = m and s.org_id = current_org_id()
  );
$$;

-- NOTE: the helpers above are SECURITY DEFINER on purpose. They read `users`,
-- which itself has RLS enabled; without SECURITY DEFINER the policies would
-- recurse infinitely. Owning role must not have FORCE ROW LEVEL SECURITY set.

-- =============================================================================
-- 9. ROW LEVEL SECURITY
-- =============================================================================

alter table organizations          enable row level security;
alter table users                  enable row level security;
alter table materials              enable row level security;
alter table material_files         enable row level security;
alter table material_carrier_optins enable row level security;
alter table material_shares        enable row level security;
alter table material_org_status    enable row level security;
alter table material_status_history enable row level security;
alter table messages               enable row level security;
alter table audit_log              enable row level security;

-- Rule 6: partners never read orgs or users (admin only)
create policy admin_all_orgs  on organizations for all using (is_admin()) with check (is_admin());
create policy admin_all_users on users         for all using (is_admin()) with check (is_admin());
create policy self_read_user  on users         for select using (id = current_user_id());

-- Rule 1: a partner reads a material only if it is shared with their org
create policy read_materials on materials for select
  using (deleted_at is null and can_see_material(id));
create policy admin_write_materials on materials for all
  using (is_admin()) with check (is_admin());

-- Rule 2: files and opt-ins inherit the material's access
create policy read_files on material_files for select
  using (can_see_material(material_id));
create policy admin_write_files on material_files for all
  using (is_admin()) with check (is_admin());

create policy read_optins on material_carrier_optins for select
  using (can_see_material(material_id));
create policy admin_write_optins on material_carrier_optins for all
  using (is_admin()) with check (is_admin());

-- Partners may see THEIR OWN share row only; admin manages all (rules 1, 7)
create policy read_own_share on material_shares for select
  using (is_admin() or org_id = current_org_id());
create policy admin_write_shares on material_shares for all
  using (is_admin()) with check (is_admin());

-- Rule 4: a partner reads/writes only their own status row
create policy read_own_status on material_org_status for select
  using (is_admin() or org_id = current_org_id());
create policy write_own_status on material_org_status for all
  using (is_admin() or (org_id = current_org_id() and can_see_material(material_id)))
  with check (is_admin() or (org_id = current_org_id() and can_see_material(material_id)));

-- Rule 5: own history + Apex-level history; never another org's
create policy read_status_history on material_status_history for select
  using (is_admin() or (can_see_material(material_id)
                        and (org_id is null or org_id = current_org_id())));
create policy insert_status_history on material_status_history for insert
  with check (is_admin() or (org_id = current_org_id() and can_see_material(material_id)));

-- Rule 3: messages are strictly per (material, org)
create policy read_own_messages on messages for select
  using (is_admin() or (org_id = current_org_id() and can_see_material(material_id)));
create policy insert_own_messages on messages for insert
  with check (
    is_admin()
    or (org_id = current_org_id()
        and can_see_material(material_id)
        and author_type = 'partner')
  );
-- no update/delete policies => messages are immutable

-- Rule 9: audit log is admin-readable, insert-only, never mutable
create policy admin_read_audit on audit_log for select using (is_admin());
create policy insert_audit     on audit_log for insert with check (true);
-- no update/delete policies => append-only by construction

revoke update, delete on audit_log from public;

-- =============================================================================
-- 10. TRIGGERS
-- =============================================================================

create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create trigger materials_touch
  before update on materials
  for each row execute function touch_updated_at();

-- Audit every access grant/revoke automatically, so it cannot be forgotten
-- in application code.
create or replace function audit_share_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare o text; m text;
begin
  if (tg_op = 'INSERT') then
    select name into o from organizations where id = new.org_id;
    select smid into m from materials    where id = new.material_id;
    insert into audit_log(actor_type,actor_name,kind,action,target,detail,material_id,org_id)
    values ('admin','Administrator','access','Access granted',m,'to '||coalesce(o,'?'),new.material_id,new.org_id);
    return new;
  else
    select name into o from organizations where id = old.org_id;
    select smid into m from materials    where id = old.material_id;
    insert into audit_log(actor_type,actor_name,kind,action,target,detail,material_id,org_id)
    values ('admin','Administrator','access','Access revoked',m,'from '||coalesce(o,'?'),old.material_id,old.org_id);
    return old;
  end if;
end $$;

create trigger share_audit_ins after insert on material_shares
  for each row execute function audit_share_change();
create trigger share_audit_del after delete on material_shares
  for each row execute function audit_share_change();
