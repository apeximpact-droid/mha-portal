-- Apex Operational Logins: Apex's own internal tool/portal credentials
-- (Canva, Monday.com, hosting, etc.) -- not tied to any partner org or
-- carrier. Same shape as organization_portal_logins, plus a logo per entry.
create table apex_operational_logins (
  id           uuid primary key default gen_random_uuid(),
  label        text not null,
  portal_url   text,
  username     text,
  password     text,
  logo_path    text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table apex_operational_logins enable row level security;
drop policy if exists admin_all_apex_operational_logins on apex_operational_logins;
create policy admin_all_apex_operational_logins on apex_operational_logins for all
  using (is_admin()) with check (is_admin());

insert into storage.buckets (id, name, public)
values ('apex-operational-login-logos', 'apex-operational-login-logos', false)
on conflict (id) do nothing;

drop policy if exists apex_op_login_logos_admin_only on storage.objects;
create policy apex_op_login_logos_admin_only on storage.objects for all
  using (bucket_id = 'apex-operational-login-logos' and public.is_admin())
  with check (bucket_id = 'apex-operational-login-logos' and public.is_admin());

-- Finances: a transaction log (income/expense) with an optional attached
-- invoice/receipt file, a tax-deductible flag, and a category, so the
-- Finances tab can show revenue/expense/net totals and export a CSV for
-- an accountant. Admin-only, same as everything else in this schema.
create table finance_transactions (
  id               uuid primary key default gen_random_uuid(),
  txn_date         date not null,
  type             text not null check (type in ('Income', 'Expense')),
  amount           numeric(12,2) not null,
  category         text,
  vendor_client    text,
  payment_method   text,
  tax_deductible   boolean not null default false,
  notes            text,
  file_path        text,
  file_name        text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists idx_finance_transactions_date on finance_transactions(txn_date);

alter table finance_transactions enable row level security;
drop policy if exists admin_all_finance_transactions on finance_transactions;
create policy admin_all_finance_transactions on finance_transactions for all
  using (is_admin()) with check (is_admin());

insert into storage.buckets (id, name, public)
values ('finance-documents', 'finance-documents', false)
on conflict (id) do nothing;

drop policy if exists finance_documents_admin_only on storage.objects;
create policy finance_documents_admin_only on storage.objects for all
  using (bucket_id = 'finance-documents' and public.is_admin())
  with check (bucket_id = 'finance-documents' and public.is_admin());
