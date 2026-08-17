-- SW-76 / vendor-confirmed requirements not yet covered:
-- 1. "Parti sans payer" (left without paying) must be a supported payment method.
-- 2. "Rapport de l'utilisateur" (user report): a document sent to Revenu Quebec each
--    time it's shown/printed, containing a sales summary for the current or previous
--    year. We don't have the real MEV-WEB request format yet (SW-73 is partner-only),
--    so this table only logs that a report was generated locally; it is not wired
--    into the mev_attempts trigger chain, which is invoice-scoped and would not fit
--    a report that spans a whole year of invoices.

alter table public.payments drop constraint if exists payments_method_check;
alter table public.payments add constraint payments_method_check check (method in ('cash','card','other','left_without_paying'));

create table if not exists public.user_reports (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  period_year integer not null check (period_year between 2000 and 2100),
  sales_count integer not null default 0,
  sales_subtotal numeric(12,2) not null default 0,
  sales_gst numeric(12,2) not null default 0,
  sales_qst numeric(12,2) not null default 0,
  sales_total numeric(12,2) not null default 0,
  last_invoice_number bigint,
  last_invoice_at timestamptz,
  generated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

alter table public.user_reports enable row level security;

drop policy if exists "user reports select" on public.user_reports;
create policy "user reports select" on public.user_reports for select to authenticated using (private.is_restaurant_member(restaurant_id));
drop policy if exists "user reports insert" on public.user_reports;
create policy "user reports insert" on public.user_reports for insert to authenticated with check (private.is_restaurant_member(restaurant_id));
-- Granted explicitly rather than relying on the project's default privileges,
-- which are not guaranteed to cover newly created tables.
grant select, insert on public.user_reports to authenticated;
-- Append-only: no update/delete policy, same rationale as the fiscal ledger hardening.
revoke update, delete on public.user_reports from authenticated, anon;

create index if not exists user_reports_restaurant_idx on public.user_reports (restaurant_id, period_year);
