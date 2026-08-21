-- Resto360 — migration complète à appliquer dans le SQL Editor de Supabase.
--
-- Regroupe, dans l'ordre, les migrations 20260816_000017 à 20260817_000029.
-- Tout s'exécute dans une seule transaction : en cas d'erreur, rien n'est
-- appliqué et la base reste exactement dans son état actuel.
--
-- Testé sur une base reconstruite de zéro, avec pgcrypto dans le schéma
-- extensions comme chez Supabase : passe d'un seul coup, et le relancer une
-- deuxième fois ne change rien et ne casse rien.

begin;

-- ============================================================
-- 20260816_000017_fiscal_ledger_hardening.sql
-- ============================================================

-- Fiscal ledger hardening for MEV certification readiness.
--
-- Problem: invoices/invoice_items/payments/mev_attempts/mev_transactions/mev_receipts
-- currently use "for all" RLS policies, so any authenticated staff member can UPDATE
-- or DELETE fiscal records directly through the Supabase REST API, bypassing the POS
-- UI entirely. mev-architecture.md describes mev_attempts as an "immutable attempt/
-- audit history", but nothing enforced that. This migration makes the fiscal chain
-- append-only from the client's point of view and moves the few legitimate state
-- transitions the app needs behind SECURITY DEFINER functions that re-check restaurant
-- membership themselves (since RLS no longer gates those tables for UPDATE).

-- 1. Narrow RLS policies: SELECT + INSERT only for the fiscal chain.

drop policy if exists "invoices member access" on public.invoices;
drop policy if exists "invoices select" on public.invoices;
create policy "invoices select" on public.invoices for select to authenticated using (private.is_restaurant_member(restaurant_id));
drop policy if exists "invoices insert" on public.invoices;
create policy "invoices insert" on public.invoices for insert to authenticated with check (private.is_restaurant_member(restaurant_id));
revoke update, delete on public.invoices from authenticated, anon;

drop policy if exists "invoice items member access" on public.invoice_items;
drop policy if exists "invoice items select" on public.invoice_items;
create policy "invoice items select" on public.invoice_items for select to authenticated using (exists (select 1 from public.invoices i where i.id = invoice_items.invoice_id and private.is_restaurant_member(i.restaurant_id)));
drop policy if exists "invoice items insert" on public.invoice_items;
create policy "invoice items insert" on public.invoice_items for insert to authenticated with check (exists (select 1 from public.invoices i where i.id = invoice_items.invoice_id and private.is_restaurant_member(i.restaurant_id)));
revoke update, delete on public.invoice_items from authenticated, anon;

drop policy if exists "payments member access" on public.payments;
drop policy if exists "payments select" on public.payments;
create policy "payments select" on public.payments for select to authenticated using (private.is_restaurant_member(restaurant_id));
drop policy if exists "payments insert" on public.payments;
create policy "payments insert" on public.payments for insert to authenticated with check (private.is_restaurant_member(restaurant_id));
revoke update, delete on public.payments from authenticated, anon;

drop policy if exists "mev attempts member access" on public.mev_attempts;
drop policy if exists "mev attempts select" on public.mev_attempts;
create policy "mev attempts select" on public.mev_attempts for select to authenticated using (private.is_restaurant_member(restaurant_id));
drop policy if exists "mev attempts insert" on public.mev_attempts;
create policy "mev attempts insert" on public.mev_attempts for insert to authenticated with check (private.is_restaurant_member(restaurant_id));
revoke update, delete on public.mev_attempts from authenticated, anon;

-- mev_transactions and mev_receipts are only ever written by the mirror_mev_attempt_to_runtime
-- trigger (SECURITY DEFINER, bypasses RLS) or by the RPCs defined below. The client only reads them.
drop policy if exists mev_transactions_member_all on public.mev_transactions;
drop policy if exists "mev transactions select" on public.mev_transactions;
create policy "mev transactions select" on public.mev_transactions for select to authenticated using (private.is_restaurant_member(restaurant_id));
revoke insert, update, delete on public.mev_transactions from authenticated, anon;

drop policy if exists mev_receipts_member_all on public.mev_receipts;
drop policy if exists "mev receipts select" on public.mev_receipts;
create policy "mev receipts select" on public.mev_receipts for select to authenticated using (private.is_restaurant_member(restaurant_id));
revoke insert, update, delete on public.mev_receipts from authenticated, anon;

-- mev_devices stays mutable by staff (device/certificate bookkeeping, not the transaction ledger itself).

-- 2. Controlled state-transition RPCs, each re-checking restaurant membership explicitly
--    because the tables above are no longer directly writable by authenticated.

create or replace function public.mev_transaction_mark_sending(p_invoice_id uuid)
returns public.mev_transactions
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_row public.mev_transactions;
begin
  select * into v_row from public.mev_transactions where invoice_id = p_invoice_id;
  if v_row.id is null then
    raise exception 'MEV: transaction introuvable pour cette facture' using errcode = 'P0002';
  end if;
  if not private.is_restaurant_member(v_row.restaurant_id) then
    raise exception 'MEV: accès refusé' using errcode = '42501';
  end if;
  if v_row.status not in ('pending', 'retryable') then
    return v_row;
  end if;
  update public.mev_transactions
  set status = 'sending', sent_at = now(), updated_at = now()
  where id = v_row.id
  returning * into v_row;
  return v_row;
end;
$$;
revoke all on function public.mev_transaction_mark_sending(uuid) from public, anon;
grant execute on function public.mev_transaction_mark_sending(uuid) to authenticated;

create or replace function public.mev_transaction_mark_exhausted(p_invoice_id uuid, p_message text default 'Nombre maximal de tentatives atteint')
returns void
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_row public.mev_transactions;
begin
  select * into v_row from public.mev_transactions where invoice_id = p_invoice_id;
  if v_row.id is null then
    raise exception 'MEV: transaction introuvable pour cette facture' using errcode = 'P0002';
  end if;
  if not private.is_restaurant_member(v_row.restaurant_id) then
    raise exception 'MEV: accès refusé' using errcode = '42501';
  end if;
  if v_row.attempt_count < 8 then
    raise exception 'MEV: nombre de tentatives insuffisant pour marquer la transaction comme épuisée' using errcode = '22023';
  end if;
  update public.mev_transactions
  set status = 'failed', last_error_message = p_message, updated_at = now()
  where id = v_row.id;
  update public.invoices set status = 'failed' where id = p_invoice_id;
end;
$$;
revoke all on function public.mev_transaction_mark_exhausted(uuid, text) from public, anon;
grant execute on function public.mev_transaction_mark_exhausted(uuid, text) to authenticated;

create or replace function public.mev_receipt_mark_printed(p_receipt_id uuid)
returns void
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_row public.mev_receipts;
begin
  select * into v_row from public.mev_receipts where id = p_receipt_id;
  if v_row.id is null then
    raise exception 'MEV: reçu introuvable' using errcode = 'P0002';
  end if;
  if not private.is_restaurant_member(v_row.restaurant_id) then
    raise exception 'MEV: accès refusé' using errcode = '42501';
  end if;
  update public.mev_receipts
  set printed_at = now(), print_attempts = print_attempts + 1, last_print_error = null
  where id = p_receipt_id;
end;
$$;
revoke all on function public.mev_receipt_mark_printed(uuid) from public, anon;
grant execute on function public.mev_receipt_mark_printed(uuid) to authenticated;

create or replace function public.mev_receipt_mark_print_failed(p_receipt_id uuid, p_message text)
returns void
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_row public.mev_receipts;
begin
  select * into v_row from public.mev_receipts where id = p_receipt_id;
  if v_row.id is null then
    raise exception 'MEV: reçu introuvable' using errcode = 'P0002';
  end if;
  if not private.is_restaurant_member(v_row.restaurant_id) then
    raise exception 'MEV: accès refusé' using errcode = '42501';
  end if;
  update public.mev_receipts
  set print_attempts = print_attempts + 1, last_print_error = p_message
  where id = p_receipt_id;
end;
$$;
revoke all on function public.mev_receipt_mark_print_failed(uuid, text) from public, anon;
grant execute on function public.mev_receipt_mark_print_failed(uuid, text) to authenticated;

-- 3. Gapless sequential invoice numbering per restaurant (MEV-WEB requires continuous
--    numbering so a deleted/skipped document is detectable; UUIDs alone don't provide that).

create table if not exists public.invoice_counters (
  restaurant_id uuid primary key references public.restaurants(id) on delete cascade,
  next_number bigint not null default 1
);
alter table public.invoice_counters enable row level security;
revoke all on public.invoice_counters from authenticated, anon;
-- No policies: authenticated/anon get zero rows either way; only the trigger below
-- (running as table owner) ever touches this table.

alter table public.invoices add column if not exists invoice_number bigint;

create or replace function public.assign_invoice_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_num bigint;
begin
  if new.invoice_number is not null then
    return new;
  end if;

  insert into public.invoice_counters (restaurant_id, next_number)
  values (new.restaurant_id, 1)
  on conflict (restaurant_id) do nothing;

  update public.invoice_counters
  set next_number = next_number + 1
  where restaurant_id = new.restaurant_id
  returning next_number - 1 into v_num;

  new.invoice_number := v_num;
  return new;
end;
$$;
revoke all on function public.assign_invoice_number() from public, anon, authenticated;

drop trigger if exists trg_assign_invoice_number on public.invoices;
create trigger trg_assign_invoice_number
before insert on public.invoices
for each row execute function public.assign_invoice_number();

create unique index if not exists invoices_restaurant_number_idx on public.invoices (restaurant_id, invoice_number);

-- 4. Reject invoices whose declared taxes don't match the restaurant's configured rates.
--    This does not (yet) re-derive subtotal from order_items server-side -- see
--    docs/certification-readiness.md for that remaining gap -- but it closes the
--    trivial version of the attack where a tampered client posts an arbitrary
--    gst/qst/total independent of subtotal.

create or replace function public.validate_invoice_tax_consistency()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_gst_rate numeric;
  v_qst_rate numeric;
  v_expected_gst numeric;
  v_expected_qst numeric;
  v_expected_total numeric;
  v_tolerance constant numeric := 0.03; -- covers split-payment penny redistribution
begin
  select tax_gst, tax_qst into v_gst_rate, v_qst_rate
  from public.app_settings where restaurant_id = new.restaurant_id;

  v_gst_rate := coalesce(v_gst_rate, 0.05);
  v_qst_rate := coalesce(v_qst_rate, 0.09975);

  if new.subtotal < 0 or new.gst < 0 or new.qst < 0 or new.total < 0 then
    raise exception 'MEV: montants négatifs refusés' using errcode = '23514';
  end if;

  v_expected_gst := round(new.subtotal * v_gst_rate, 2);
  v_expected_qst := round(new.subtotal * v_qst_rate, 2);
  v_expected_total := new.subtotal + new.gst + new.qst;

  if abs(new.gst - v_expected_gst) > v_tolerance then
    raise exception 'MEV: TPS incohérente avec le sous-total déclaré' using errcode = '23514';
  end if;

  if abs(new.qst - v_expected_qst) > v_tolerance then
    raise exception 'MEV: TVQ incohérente avec le sous-total déclaré' using errcode = '23514';
  end if;

  if abs(new.total - v_expected_total) > v_tolerance then
    raise exception 'MEV: total incohérent avec le sous-total et les taxes déclarées' using errcode = '23514';
  end if;

  return new;
end;
$$;
revoke all on function public.validate_invoice_tax_consistency() from public, anon, authenticated;

drop trigger if exists trg_validate_invoice_tax on public.invoices;
create trigger trg_validate_invoice_tax
before insert on public.invoices
for each row execute function public.validate_invoice_tax_consistency();

-- ============================================================
-- 20260816_000018_restaurant_fiscal_profile.sql
-- ============================================================

-- Business identity fields required on every facture/note de credit per SW-76 (4.4):
-- legal/trade name, address, phone, GST and QST registration numbers. These are plain
-- identification data (not secrets), so no RLS change is needed: the existing
-- "restaurant owner read" policy already lets any member SELECT them for receipts, and
-- the existing "restaurant owner update" policy already restricts UPDATE to the owner.

alter table public.restaurants
  add column if not exists legal_name text,
  add column if not exists address text,
  add column if not exists city text,
  add column if not exists postal_code text,
  add column if not exists phone text,
  add column if not exists gst_number text,
  add column if not exists qst_number text;

-- ============================================================
-- 20260816_000019_left_without_paying_and_user_reports.sql
-- ============================================================

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

-- ============================================================
-- 20260816_000020_order_item_pivots.sql
-- ============================================================

-- Additive pivot/place support. Existing fiscal tables and RPCs are untouched.

alter table public.order_items
  add column if not exists seat_number integer not null default 1;

alter table public.order_items
  drop constraint if exists order_items_seat_number_check;

alter table public.order_items
  add constraint order_items_seat_number_check
  check (seat_number between 1 and 99);

alter table public.invoice_items
  add column if not exists seat_number integer;

alter table public.invoice_items
  drop constraint if exists invoice_items_seat_number_check;

alter table public.invoice_items
  add constraint invoice_items_seat_number_check
  check (seat_number is null or seat_number between 1 and 99);

create index if not exists order_items_order_id_seat_number_idx
  on public.order_items(order_id, seat_number);

comment on column public.order_items.seat_number is
  'Service pivot/place assigned while taking the order. Operational only; does not alter fiscal totals.';

comment on column public.invoice_items.seat_number is
  'Snapshot of the originating service pivot/place when available.';

-- ============================================================
-- 20260816_000021_demo_mode.sql
-- ============================================================

-- Lets an operator click through the entire flow (order, addition, payment, MEV
-- simulator, receipts, parti sans payer, duplicata, rapport de l'utilisateur)
-- without any physical printer. Purely a client-side display toggle: no fiscal
-- table, RLS policy, or trigger is affected.

alter table public.app_settings
  add column if not exists demo_mode boolean not null default false;

-- ============================================================
-- 20260816_000022_fiscal_journal_and_references.sql
-- ============================================================

-- Groundwork that the SW-76 requires regardless of the exact MEV-WEB wire format,
-- so it can be built before we are a registered partner. Nothing here invents a
-- Revenu Quebec format: it is all internal bookkeeping the SEV must keep anyway.
--
--   SW-76 4.3 : a transaction that modifies a previous one must reference it.
--   SW-76 4.5 : keep the originals plus every later change, not just final state.
--   SW-76 4.6 : journal post-invoice item/price changes, MEV error return codes,
--               and offline-mode activation/deactivation.

-- 1. Append-only journal for the events SW-76 4.6 requires.

create table if not exists public.fiscal_events (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  event_type text not null check (event_type in (
    'item_added_after_invoice',
    'item_removed_after_invoice',
    'item_price_changed_after_invoice',
    'mev_error',
    'offline_mode_on',
    'offline_mode_off',
    'order_voided',
    'document_reprinted',
    'addition_revised'
  )),
  invoice_id uuid references public.invoices(id) on delete set null,
  order_id uuid references public.orders(id) on delete set null,
  order_item_id uuid references public.order_items(id) on delete set null,
  error_code text,
  error_message text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

alter table public.fiscal_events enable row level security;

drop policy if exists "fiscal events select" on public.fiscal_events;
create policy "fiscal events select" on public.fiscal_events for select to authenticated using (private.is_restaurant_member(restaurant_id));
drop policy if exists "fiscal events insert" on public.fiscal_events;
create policy "fiscal events insert" on public.fiscal_events for insert to authenticated with check (private.is_restaurant_member(restaurant_id));
-- Granted explicitly rather than relying on the project's default privileges,
-- which are not guaranteed to cover newly created tables.
grant select, insert on public.fiscal_events to authenticated;
-- Append-only, same rationale as the rest of the fiscal chain.
revoke update, delete on public.fiscal_events from authenticated, anon;

create index if not exists fiscal_events_restaurant_idx on public.fiscal_events (restaurant_id, created_at desc);
create index if not exists fiscal_events_invoice_idx on public.fiscal_events (invoice_id) where invoice_id is not null;

-- 2. Reference chain (SW-76 4.3). Nothing produces credit notes/corrections yet,
--    but the column has to exist before they do or the chain is unreconstructable.

alter table public.invoices
  add column if not exists replaces_invoice_id uuid references public.invoices(id) on delete set null,
  add column if not exists produced_offline boolean not null default false;

create index if not exists invoices_replaces_idx on public.invoices (replaces_invoice_id) where replaces_invoice_id is not null;

-- 3. Addition revision counter, so a reprinted-after-change addition can say
--    "FACTURE REVISEE / Remplace N factures" instead of claiming to be original.

alter table public.orders
  add column if not exists addition_print_count integer not null default 0;

-- 4. Arithmetic integrity on invoice lines. A tampered client could previously post
--    an invoice_item with an arbitrary unit_price unrelated to the item actually
--    ordered. The declared price must match the source order_item, and line_total
--    must actually be quantity x unit_price.
--
--    Note: the split-by-amount payment path inserts no invoice_items at all, so this
--    trigger simply does not fire there. That remaining gap is documented in
--    docs/certification-readiness.md.

create or replace function public.validate_invoice_item_integrity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source_price numeric;
  v_tolerance constant numeric := 0.01;
begin
  if new.quantity <= 0 then
    raise exception 'MEV: quantite de ligne invalide' using errcode = '23514';
  end if;

  if abs(new.line_total - round(new.quantity * new.unit_price, 2)) > v_tolerance then
    raise exception 'MEV: total de ligne incoherent avec quantite x prix unitaire' using errcode = '23514';
  end if;

  select unit_price into v_source_price
  from public.order_items where id = new.order_item_id;

  if v_source_price is null then
    raise exception 'MEV: article de commande introuvable pour cette ligne de facture' using errcode = '23503';
  end if;

  if abs(new.unit_price - v_source_price) > v_tolerance then
    raise exception 'MEV: prix unitaire facture different du prix de l''article commande' using errcode = '23514';
  end if;

  return new;
end;
$$;
revoke all on function public.validate_invoice_item_integrity() from public, anon, authenticated;

drop trigger if exists trg_validate_invoice_item_integrity on public.invoice_items;
create trigger trg_validate_invoice_item_integrity
before insert on public.invoice_items
for each row execute function public.validate_invoice_item_integrity();

-- ============================================================
-- 20260816_000023_finalize_invoice_server_side.sql
-- ============================================================

-- Closes the last sales-suppression hole: until now the POS declared the sale
-- amount and the database only checked that the taxes were internally consistent
-- with whatever subtotal it was handed. A tampered client could record a $200
-- table as a $5 sale. finalize_invoice() derives every amount from order_items
-- and the restaurant's configured tax rates instead, so the recorded sale is a
-- function of what was actually ordered.

-- 0. Schema drift repair. app-v2.js has been writing these four columns on every
--    payment, but no migration in this repo ever created them: a database rebuilt
--    from migrations alone would reject every payment. Adding them here so the
--    migrations are once again the source of truth.

alter table public.payments
  add column if not exists tendered_amount numeric(12,2),
  add column if not exists terminal_total numeric(12,2),
  add column if not exists change_due numeric(12,2),
  add column if not exists tip_source text;

alter table public.payments drop constraint if exists payments_tip_source_check;
alter table public.payments add constraint payments_tip_source_check
  check (tip_source is null or tip_source in ('none','percent','amount','external_terminal','manual_cash'));

-- 1. The one entry point that may create a sale.

create or replace function public.finalize_invoice(
  p_order_id uuid,
  p_item_ids uuid[] default null,
  p_amount numeric default null,
  p_method text default 'cash',
  p_tip_amount numeric default 0,
  p_tendered_amount numeric default 0,
  p_tip_source text default 'none',
  p_produced_offline boolean default false
)
returns public.invoices
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_order public.orders;
  v_gst_rate numeric;
  v_qst_rate numeric;
  v_sub numeric := 0;
  v_gst numeric;
  v_qst numeric;
  v_total numeric;
  v_remaining_gross numeric := 0;
  v_invoice public.invoices;
  v_tip numeric := round(coalesce(p_tip_amount, 0), 2);
  v_item record;
  v_qty numeric;
  v_cents bigint;
  v_item_gross_cents bigint;
  v_fraction numeric;
  v_tolerance constant numeric := 0.02;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if v_order.id is null then
    raise exception 'MEV: commande introuvable' using errcode = 'P0002';
  end if;
  if not private.is_restaurant_member(v_order.restaurant_id) then
    raise exception 'MEV: acces refuse' using errcode = '42501';
  end if;
  if v_order.status not in ('open', 'partially_paid') then
    raise exception 'MEV: cette commande est deja fermee' using errcode = '22023';
  end if;
  if v_tip < 0 then
    raise exception 'MEV: pourboire negatif refuse' using errcode = '23514';
  end if;

  select coalesce(tax_gst, 0.05), coalesce(tax_qst, 0.09975)
    into v_gst_rate, v_qst_rate
  from public.app_settings where restaurant_id = v_order.restaurant_id;
  v_gst_rate := coalesce(v_gst_rate, 0.05);
  v_qst_rate := coalesce(v_qst_rate, 0.09975);

  -- What the table still genuinely owes, computed from the order itself.
  select coalesce(sum(oi.unit_price * (oi.quantity - oi.paid_quantity)), 0)
    into v_remaining_gross
  from public.order_items oi
  where oi.order_id = p_order_id
    and oi.kitchen_status <> 'cancelled'
    and oi.paid_quantity < oi.quantity;
  v_remaining_gross := round(v_remaining_gross * (1 + v_gst_rate + v_qst_rate), 2);

  if p_item_ids is not null and array_length(p_item_ids, 1) > 0 then
    -- Paying specific items: price them from the order, never from the request.
    for v_item in
      select oi.id, oi.unit_price, (oi.quantity - oi.paid_quantity) as remaining_qty
      from public.order_items oi
      where oi.id = any(p_item_ids)
        and oi.order_id = p_order_id
        and oi.kitchen_status <> 'cancelled'
        and oi.paid_quantity < oi.quantity
    loop
      v_sub := v_sub + (v_item.unit_price * v_item.remaining_qty);
    end loop;

    if v_sub <= 0 then
      raise exception 'MEV: aucun article impaye correspondant a cette demande' using errcode = '22023';
    end if;

    v_sub := round(v_sub, 2);
    v_gst := round(v_sub * v_gst_rate, 2);
    v_qst := round(v_sub * v_qst_rate, 2);
    v_total := round(v_sub + v_gst + v_qst, 2);
  else
    -- Paying an arbitrary amount (split). It may be less than the balance, that is
    -- a partial payment, but it may never exceed what the table actually owes.
    if p_amount is null or p_amount <= 0 then
      raise exception 'MEV: montant de paiement invalide' using errcode = '22023';
    end if;
    if round(p_amount, 2) > v_remaining_gross + v_tolerance then
      raise exception 'MEV: montant (%) superieur au solde reel de la commande (%)', round(p_amount, 2), v_remaining_gross using errcode = '22023';
    end if;
    v_total := round(p_amount, 2);
    v_sub := round(v_total / (1 + v_gst_rate + v_qst_rate), 2);
    v_gst := round(v_sub * v_gst_rate, 2);
    v_qst := round(v_sub * v_qst_rate, 2);
  end if;

  insert into public.invoices (
    restaurant_id, order_id, subtotal, gst, qst, total,
    tip_amount, payment_total, tip_mode, tip_value, status, produced_offline, mev_payload
  ) values (
    v_order.restaurant_id, p_order_id, v_sub, v_gst, v_qst, v_total,
    v_tip, round(v_total + v_tip, 2), p_tip_source, v_tip, 'pending_mev', coalesce(p_produced_offline, false),
    jsonb_build_object('kind', case when p_item_ids is not null and array_length(p_item_ids,1) > 0 then 'items' else 'amount' end,
                       'server_computed', true)
  )
  returning * into v_invoice;

  if p_item_ids is not null and array_length(p_item_ids, 1) > 0 then
    insert into public.invoice_items (invoice_id, order_item_id, quantity, unit_price, line_total)
    select v_invoice.id, oi.id, (oi.quantity - oi.paid_quantity), oi.unit_price,
           round(oi.unit_price * (oi.quantity - oi.paid_quantity), 2)
    from public.order_items oi
    where oi.id = any(p_item_ids)
      and oi.order_id = p_order_id
      and oi.kitchen_status <> 'cancelled'
      and oi.paid_quantity < oi.quantity;

    update public.order_items
    set paid_quantity = quantity
    where id = any(p_item_ids) and order_id = p_order_id and kitchen_status <> 'cancelled';
  else
    -- Proportional allocation across the open items, mirroring the previous
    -- client-side behaviour but done where it cannot be edited.
    v_cents := round(v_total * 100);
    for v_item in
      select oi.id, oi.unit_price, oi.quantity, oi.paid_quantity,
             (oi.quantity - oi.paid_quantity) as remaining_qty
      from public.order_items oi
      where oi.order_id = p_order_id
        and oi.kitchen_status <> 'cancelled'
        and oi.paid_quantity < oi.quantity
      order by oi.created_at
    loop
      exit when v_cents <= 0;
      v_item_gross_cents := round(v_item.unit_price * v_item.remaining_qty * (1 + v_gst_rate + v_qst_rate) * 100);
      if v_item_gross_cents <= 0 then
        continue;
      end if;
      if v_cents >= v_item_gross_cents then
        update public.order_items set paid_quantity = quantity where id = v_item.id;
        v_cents := v_cents - v_item_gross_cents;
      else
        v_fraction := v_cents::numeric / v_item_gross_cents::numeric;
        v_qty := round(v_item.paid_quantity + (v_fraction * v_item.remaining_qty), 3);
        update public.order_items set paid_quantity = least(v_qty, quantity) where id = v_item.id;
        v_cents := 0;
      end if;
    end loop;
  end if;

  insert into public.payments (
    restaurant_id, invoice_id, method, amount, tip_amount,
    tendered_amount, terminal_total, change_due, tip_source
  ) values (
    v_order.restaurant_id, v_invoice.id, p_method, round(v_total + v_tip, 2), v_tip,
    round(coalesce(p_tendered_amount, 0), 2),
    case when p_method = 'card' then round(coalesce(p_tendered_amount, 0), 2) else null end,
    greatest(round(coalesce(p_tendered_amount, 0) - v_total - v_tip, 2), 0),
    p_tip_source
  );

  update public.orders
  set status = case
        when exists (
          select 1 from public.order_items oi
          where oi.order_id = p_order_id
            and oi.kitchen_status <> 'cancelled'
            and oi.paid_quantity < oi.quantity
        ) then 'partially_paid' else 'closed' end,
      closed_at = case
        when exists (
          select 1 from public.order_items oi
          where oi.order_id = p_order_id
            and oi.kitchen_status <> 'cancelled'
            and oi.paid_quantity < oi.quantity
        ) then null else now() end,
      updated_at = now()
  where id = p_order_id;

  return v_invoice;
end;
$$;

revoke all on function public.finalize_invoice(uuid, uuid[], numeric, text, numeric, numeric, text, boolean) from public, anon;
grant execute on function public.finalize_invoice(uuid, uuid[], numeric, text, numeric, numeric, text, boolean) to authenticated;

-- 2. Now that sales can only be created through the function above, close the
--    direct insert path so a client cannot bypass it.

drop policy if exists "invoices insert" on public.invoices;
revoke insert on public.invoices from authenticated, anon;

drop policy if exists "invoice items insert" on public.invoice_items;
revoke insert on public.invoice_items from authenticated, anon;

drop policy if exists "payments insert" on public.payments;
revoke insert on public.payments from authenticated, anon;

-- ============================================================
-- 20260816_000024_credit_notes_and_void_order.sql
-- ============================================================

-- Two documents the SW-76 requires that Resto360 could not produce at all:
--   * the credit note (note de credit), a mandatory customer document;
--   * a full order cancellation with its own receipt.
-- Without a refund path, a disputed charge is settled out of the till with no
-- record, which is both untracked loss and a compliance failure.

-- 1. A credit note is an invoice with negative amounts that references the invoice
--    it reverses. The tax-consistency trigger has to allow that, but only in that
--    case: a standalone negative invoice stays refused.

create or replace function public.validate_invoice_tax_consistency()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_gst_rate numeric;
  v_qst_rate numeric;
  v_expected_gst numeric;
  v_expected_qst numeric;
  v_expected_total numeric;
  v_sign integer := 1;
  v_tolerance constant numeric := 0.03;
begin
  select tax_gst, tax_qst into v_gst_rate, v_qst_rate
  from public.app_settings where restaurant_id = new.restaurant_id;

  v_gst_rate := coalesce(v_gst_rate, 0.05);
  v_qst_rate := coalesce(v_qst_rate, 0.09975);

  if new.replaces_invoice_id is not null and new.subtotal < 0 then
    v_sign := -1;
  end if;

  if v_sign = 1 and (new.subtotal < 0 or new.gst < 0 or new.qst < 0 or new.total < 0) then
    raise exception 'MEV: montants negatifs refuses hors note de credit' using errcode = '23514';
  end if;

  if v_sign = -1 and (new.gst > 0 or new.qst > 0 or new.total > 0) then
    raise exception 'MEV: une note de credit doit avoir des montants negatifs coherents' using errcode = '23514';
  end if;

  v_expected_gst := round(new.subtotal * v_gst_rate, 2);
  v_expected_qst := round(new.subtotal * v_qst_rate, 2);
  v_expected_total := new.subtotal + new.gst + new.qst;

  if abs(new.gst - v_expected_gst) > v_tolerance then
    raise exception 'MEV: TPS incoherente avec le sous-total declare' using errcode = '23514';
  end if;
  if abs(new.qst - v_expected_qst) > v_tolerance then
    raise exception 'MEV: TVQ incoherente avec le sous-total declare' using errcode = '23514';
  end if;
  if abs(new.total - v_expected_total) > v_tolerance then
    raise exception 'MEV: total incoherent avec le sous-total et les taxes declares' using errcode = '23514';
  end if;

  return new;
end;
$$;
revoke all on function public.validate_invoice_tax_consistency() from public, anon, authenticated;

-- 2. Issue a credit note against a paid invoice.

create or replace function public.create_credit_note(p_invoice_id uuid, p_reason text default null)
returns public.invoices
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_src public.invoices;
  v_note public.invoices;
begin
  select * into v_src from public.invoices where id = p_invoice_id for update;
  if v_src.id is null then
    raise exception 'MEV: facture introuvable' using errcode = 'P0002';
  end if;
  if not private.is_restaurant_member(v_src.restaurant_id) then
    raise exception 'MEV: acces refuse' using errcode = '42501';
  end if;
  if v_src.subtotal < 0 then
    raise exception 'MEV: impossible de creer une note de credit sur une note de credit' using errcode = '22023';
  end if;
  if exists (select 1 from public.invoices where replaces_invoice_id = p_invoice_id) then
    raise exception 'MEV: cette facture a deja une note de credit' using errcode = '23505';
  end if;

  insert into public.invoices (
    restaurant_id, order_id, subtotal, gst, qst, total,
    tip_amount, payment_total, status, replaces_invoice_id, mev_payload
  ) values (
    v_src.restaurant_id, v_src.order_id, -v_src.subtotal, -v_src.gst, -v_src.qst, -v_src.total,
    0, -(v_src.payment_total), 'pending_mev', v_src.id,
    jsonb_build_object('kind', 'credit_note', 'reason', p_reason, 'server_computed', true)
  )
  returning * into v_note;

  insert into public.fiscal_events (restaurant_id, event_type, invoice_id, payload, created_by)
  values (v_src.restaurant_id, 'order_voided', v_note.id,
          jsonb_build_object('credit_note_for', v_src.id, 'reason', p_reason), (select auth.uid()));

  return v_note;
end;
$$;
revoke all on function public.create_credit_note(uuid, text) from public, anon;
grant execute on function public.create_credit_note(uuid, text) to authenticated;

-- 3. Cancel a whole order, journalising every item that was dropped.

create or replace function public.void_order(p_order_id uuid, p_reason text default null)
returns integer
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_order public.orders;
  v_cancelled integer := 0;
  v_items jsonb;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if v_order.id is null then
    raise exception 'MEV: commande introuvable' using errcode = 'P0002';
  end if;
  if not private.is_restaurant_member(v_order.restaurant_id) then
    raise exception 'MEV: acces refuse' using errcode = '42501';
  end if;
  if v_order.status not in ('open', 'partially_paid') then
    raise exception 'MEV: cette commande est deja fermee' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('name', oi.name, 'unit_price', oi.unit_price,
                                               'quantity', oi.quantity - oi.paid_quantity)), '[]'::jsonb)
    into v_items
  from public.order_items oi
  where oi.order_id = p_order_id
    and oi.kitchen_status <> 'cancelled'
    and oi.paid_quantity < oi.quantity;

  update public.order_items
  set kitchen_status = 'cancelled'
  where order_id = p_order_id
    and kitchen_status <> 'cancelled'
    and paid_quantity < quantity;
  get diagnostics v_cancelled = row_count;

  update public.orders
  set status = 'cancelled', closed_at = now(), updated_at = now()
  where id = p_order_id;

  insert into public.fiscal_events (restaurant_id, event_type, order_id, payload, created_by)
  values (v_order.restaurant_id, 'order_voided', p_order_id,
          jsonb_build_object('reason', p_reason, 'cancelled_items', v_items), (select auth.uid()));

  return v_cancelled;
end;
$$;
revoke all on function public.void_order(uuid, text) from public, anon;
grant execute on function public.void_order(uuid, text) to authenticated;

-- ============================================================
-- 20260816_000025_shared_order_items.sql
-- ============================================================

-- Shared items: a bottle of wine split four ways while everyone still pays their
-- own food. Neither the current pivot feature nor the Cluster demo does this;
-- both assign an item to exactly one seat.
--
-- Implementation choice: rather than a separate ownership table, a shared item is
-- physically split into one fractional order_items row per seat. That composes with
-- everything already built (finalize_invoice pays whole rows, the invoice_items
-- integrity trigger already accepts fractional quantities) instead of forcing the
-- fiscal path to understand partial ownership.

alter table public.order_items
  add column if not exists share_group_id uuid;

-- Three decimals of quantity cannot express a cent-fair share: a $40 bottle split
-- three ways lands on 13.32/13.32/13.36. Widening the scale (no data loss, this is
-- strictly a widening) lets each share land within a cent of the others.
alter table public.order_items alter column quantity type numeric(12,6);
alter table public.order_items alter column paid_quantity type numeric(12,6);
alter table public.invoice_items alter column quantity type numeric(12,6);

create index if not exists order_items_share_group_idx
  on public.order_items (share_group_id) where share_group_id is not null;

comment on column public.order_items.share_group_id is
  'Rows carrying the same value are fractions of one physically shared item.';

alter table public.fiscal_events drop constraint if exists fiscal_events_event_type_check;
alter table public.fiscal_events add constraint fiscal_events_event_type_check check (event_type in (
  'item_added_after_invoice',
  'item_removed_after_invoice',
  'item_price_changed_after_invoice',
  'item_shared',
  'mev_error',
  'offline_mode_on',
  'offline_mode_off',
  'order_voided',
  'document_reprinted',
  'addition_revised'
));

create or replace function public.split_order_item(p_order_item_id uuid, p_seats integer[])
returns setof public.order_items
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_item public.order_items;
  v_order public.orders;
  v_seats integer[];
  v_n integer;
  v_group uuid := gen_random_uuid();
  v_qty numeric(12,6);
  v_assigned numeric(12,6) := 0;
  v_seat integer;
  v_i integer := 0;
  v_total_cents bigint;
  v_base_cents bigint;
  v_extra bigint;
  v_cents bigint;
begin
  select * into v_item from public.order_items where id = p_order_item_id for update;
  if v_item.id is null then
    raise exception 'MEV: article introuvable' using errcode = 'P0002';
  end if;

  select * into v_order from public.orders where id = v_item.order_id;
  if not private.is_restaurant_member(v_order.restaurant_id) then
    raise exception 'MEV: acces refuse' using errcode = '42501';
  end if;
  if v_order.status not in ('open', 'partially_paid') then
    raise exception 'MEV: cette commande est deja fermee' using errcode = '22023';
  end if;
  if v_item.kitchen_status = 'cancelled' then
    raise exception 'MEV: article annule' using errcode = '22023';
  end if;
  if v_item.paid_quantity > 0 then
    raise exception 'MEV: article deja paye en tout ou en partie, partage impossible' using errcode = '22023';
  end if;

  -- Distinct, sorted, valid seats.
  select array_agg(distinct s order by s) into v_seats
  from unnest(p_seats) as s
  where s between 1 and 99;

  v_n := coalesce(array_length(v_seats, 1), 0);
  if v_n < 2 then
    raise exception 'MEV: il faut au moins deux places pour partager un article' using errcode = '22023';
  end if;

  -- Split the money in whole cents first, spreading the remainder one cent at a
  -- time, then derive each quantity from its cent share. Everyone lands within a
  -- cent of everyone else and the quantities still add back up to the original.
  v_total_cents := round(v_item.unit_price * v_item.quantity * 100);
  if v_total_cents < v_n then
    raise exception 'MEV: montant trop petit pour etre partage entre % places', v_n using errcode = '22023';
  end if;
  v_base_cents := v_total_cents / v_n;
  v_extra := v_total_cents - (v_base_cents * v_n);

  foreach v_seat in array v_seats loop
    v_i := v_i + 1;
    if v_i = v_n then
      v_qty := v_item.quantity - v_assigned;
    else
      v_cents := v_base_cents + case when v_i <= v_extra then 1 else 0 end;
      v_qty := round(v_cents::numeric / (v_item.unit_price * 100), 6);
      v_assigned := v_assigned + v_qty;
    end if;

    if v_qty <= 0 then
      raise exception 'MEV: quantite trop petite pour etre partagee entre % places', v_n using errcode = '22023';
    end if;

    insert into public.order_items (
      order_id, product_id, name, unit_price, quantity, paid_quantity,
      kitchen_status, kitchen_sent_at, notes, seat_number, share_group_id
    ) values (
      v_item.order_id, v_item.product_id, v_item.name, v_item.unit_price, v_qty, 0,
      v_item.kitchen_status, v_item.kitchen_sent_at, v_item.notes, v_seat, v_group
    );
  end loop;

  -- Safe to remove: the row is unpaid, so no invoice_items reference it.
  delete from public.order_items where id = p_order_item_id;

  insert into public.fiscal_events (restaurant_id, event_type, order_id, payload, created_by)
  values (v_order.restaurant_id, 'item_shared', v_item.order_id,
          jsonb_build_object('name', v_item.name, 'unit_price', v_item.unit_price,
                             'quantity', v_item.quantity, 'seats', v_seats,
                             'share_group_id', v_group),
          (select auth.uid()));

  return query
    select * from public.order_items where share_group_id = v_group order by seat_number;
end;
$$;

revoke all on function public.split_order_item(uuid, integer[]) from public, anon;
grant execute on function public.split_order_item(uuid, integer[]) to authenticated;

-- ============================================================
-- 20260816_000026_seat_tracking_setting.sql
-- ============================================================

-- Per-seat tracking is the right default for table service, but a counter or a
-- fast bistro does not want the extra step. Making it a per-restaurant switch
-- rather than forcing one flow on everyone.

alter table public.app_settings
  add column if not exists seat_tracking_enabled boolean not null default true;

comment on column public.app_settings.seat_tracking_enabled is
  'When false the POS hides the seat map and bills the table as one, without tagging items to a seat.';

-- ============================================================
-- 20260817_000027_sw76_fiscal_documents.sql
-- ============================================================

-- SW-76 groundwork that is independent from the private SW-73 wire format.
--
-- This migration does NOT invent a Revenu Quebec request, signature or QR format.
-- It creates an immutable internal ledger for every fiscal/customer document
-- produced by Resto360, gives each document a unique number per civil day,
-- preserves references, content and hashes, and makes retries idempotent.

create table if not exists public.fiscal_document_counters (
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  civil_date date not null,
  next_number bigint not null default 1 check (next_number >= 1),
  primary key (restaurant_id, civil_date)
);

alter table public.fiscal_document_counters enable row level security;
revoke all on public.fiscal_document_counters from public, anon, authenticated;

create table if not exists public.fiscal_documents (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  local_document_id uuid not null,
  local_reference text not null,
  civil_date date not null,
  transaction_number bigint not null check (transaction_number >= 1),
  document_type text not null check (document_type in (
    'addition_original',
    'addition_revised',
    'closing_receipt',
    'credit_note',
    'customer_reproduction',
    'merchant_duplicate',
    'order_cancellation',
    'user_report'
  )),
  request_type text not null check (request_type in ('transaction','document')),
  invoice_id uuid references public.invoices(id) on delete set null,
  order_id uuid references public.orders(id) on delete set null,
  replaces_document_id uuid references public.fiscal_documents(id) on delete set null,
  support text not null default 'paper' check (support in ('paper','electronic','screen')),
  produced_offline boolean not null default false,
  official_status text not null default 'blocked_sw73' check (official_status in (
    'blocked_sw73','queued_offline','ready_for_gateway','sent','accepted','retryable','rejected','failed'
  )),
  content_text text not null,
  content_sha256 text not null,
  payload jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (restaurant_id, local_document_id),
  unique (restaurant_id, local_reference),
  unique (restaurant_id, civil_date, transaction_number)
);

comment on table public.fiscal_documents is
  'Immutable local ledger of documents produced by Resto360. Official MEV-WEB fields remain blocked until SW-73 is available.';
comment on column public.fiscal_documents.transaction_number is
  'Resto360 internal number unique per restaurant and Quebec civil day. It is not the number returned by Revenu Quebec.';
comment on column public.fiscal_documents.local_reference is
  'Device-local idempotency and paper trace reference, explicitly non-official.';

create index if not exists fiscal_documents_restaurant_created_idx
  on public.fiscal_documents (restaurant_id, created_at desc);
create index if not exists fiscal_documents_invoice_idx
  on public.fiscal_documents (invoice_id) where invoice_id is not null;
create index if not exists fiscal_documents_order_idx
  on public.fiscal_documents (order_id) where order_id is not null;
create index if not exists fiscal_documents_type_idx
  on public.fiscal_documents (restaurant_id, document_type, created_at desc);

alter table public.fiscal_documents enable row level security;
drop policy if exists "fiscal documents select" on public.fiscal_documents;
create policy "fiscal documents select"
  on public.fiscal_documents for select to authenticated
  using (private.is_restaurant_member(restaurant_id));

grant select on public.fiscal_documents to authenticated;
revoke insert, update, delete on public.fiscal_documents from public, anon, authenticated;

-- Add the public-guide events we can record now without knowing SW-73.
-- item_shared comes from migration 25 and must stay in the list: dropping it here
-- makes this file unreplayable as soon as one item has been shared, because the
-- new constraint would be violated by rows already in the journal.
alter table public.fiscal_events drop constraint if exists fiscal_events_event_type_check;
alter table public.fiscal_events add constraint fiscal_events_event_type_check check (event_type in (
  'item_added_after_invoice',
  'item_removed_after_invoice',
  'item_price_changed_after_invoice',
  'item_shared',
  'mev_error',
  'offline_mode_on',
  'offline_mode_off',
  'order_voided',
  'document_reprinted',
  'addition_revised',
  'print_error',
  'transmission_error',
  'customer_reproduction',
  'fiscal_archive_exported',
  'fiscal_document_recorded'
));

create or replace function public.record_fiscal_document(
  p_restaurant_id uuid,
  p_local_document_id uuid,
  p_local_reference text,
  p_document_type text,
  p_invoice_id uuid default null,
  p_order_id uuid default null,
  p_replaces_document_id uuid default null,
  p_support text default 'paper',
  p_produced_offline boolean default false,
  p_content_text text default '',
  p_payload jsonb default '{}'::jsonb
)
returns public.fiscal_documents
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_existing public.fiscal_documents;
  v_date date;
  v_number bigint;
  v_request_type text;
  v_row public.fiscal_documents;
begin
  if not private.is_restaurant_member(p_restaurant_id) then
    raise exception 'Document fiscal: acces refuse' using errcode = '42501';
  end if;

  if p_local_document_id is null or nullif(trim(p_local_reference), '') is null then
    raise exception 'Document fiscal: identifiant local manquant' using errcode = '23502';
  end if;

  if p_document_type not in (
    'addition_original','addition_revised','closing_receipt','credit_note',
    'customer_reproduction','merchant_duplicate','order_cancellation','user_report'
  ) then
    raise exception 'Document fiscal: type invalide (%)', p_document_type using errcode = '23514';
  end if;

  if p_support not in ('paper','electronic','screen') then
    raise exception 'Document fiscal: support invalide (%)', p_support using errcode = '23514';
  end if;

  select * into v_existing
  from public.fiscal_documents
  where restaurant_id = p_restaurant_id
    and local_document_id = p_local_document_id;
  if v_existing.id is not null then
    return v_existing;
  end if;

  if p_invoice_id is not null and not exists (
    select 1 from public.invoices
    where id = p_invoice_id and restaurant_id = p_restaurant_id
  ) then
    raise exception 'Document fiscal: facture hors restaurant' using errcode = '42501';
  end if;

  if p_order_id is not null and not exists (
    select 1 from public.orders
    where id = p_order_id and restaurant_id = p_restaurant_id
  ) then
    raise exception 'Document fiscal: commande hors restaurant' using errcode = '42501';
  end if;

  if p_replaces_document_id is not null and not exists (
    select 1 from public.fiscal_documents
    where id = p_replaces_document_id and restaurant_id = p_restaurant_id
  ) then
    raise exception 'Document fiscal: reference hors restaurant' using errcode = '42501';
  end if;

  v_date := (now() at time zone 'America/Toronto')::date;

  insert into public.fiscal_document_counters (restaurant_id, civil_date, next_number)
  values (p_restaurant_id, v_date, 2)
  on conflict (restaurant_id, civil_date)
  do update set next_number = public.fiscal_document_counters.next_number + 1
  returning next_number - 1 into v_number;

  v_request_type := case when p_document_type = 'user_report' then 'document' else 'transaction' end;

  insert into public.fiscal_documents (
    restaurant_id, local_document_id, local_reference, civil_date,
    transaction_number, document_type, request_type,
    invoice_id, order_id, replaces_document_id,
    support, produced_offline, official_status,
    content_text, content_sha256, payload, created_by
  ) values (
    p_restaurant_id, p_local_document_id, trim(p_local_reference), v_date,
    v_number, p_document_type, v_request_type,
    p_invoice_id, p_order_id, p_replaces_document_id,
    p_support, coalesce(p_produced_offline, false),
    case when p_produced_offline then 'queued_offline' else 'blocked_sw73' end,
    coalesce(p_content_text, ''),
    encode(digest(convert_to(coalesce(p_content_text, ''), 'UTF8'), 'sha256'), 'hex'),
    coalesce(p_payload, '{}'::jsonb), auth.uid()
  ) returning * into v_row;

  insert into public.fiscal_events (
    restaurant_id, event_type, invoice_id, order_id, payload, created_by
  ) values (
    p_restaurant_id, 'fiscal_document_recorded', p_invoice_id, p_order_id,
    jsonb_build_object(
      'fiscal_document_id', v_row.id,
      'document_type', p_document_type,
      'transaction_number', v_number,
      'local_reference', p_local_reference
    ), auth.uid()
  );

  return v_row;
exception
  when unique_violation then
    select * into v_existing
    from public.fiscal_documents
    where restaurant_id = p_restaurant_id
      and (local_document_id = p_local_document_id or local_reference = p_local_reference)
    order by created_at asc
    limit 1;
    if v_existing.id is not null then
      return v_existing;
    end if;
    raise;
end;
$$;

revoke all on function public.record_fiscal_document(
  uuid, uuid, text, text, uuid, uuid, uuid, text, boolean, text, jsonb
) from public, anon;
grant execute on function public.record_fiscal_document(
  uuid, uuid, text, text, uuid, uuid, uuid, text, boolean, text, jsonb
) to authenticated;

-- ============================================================
-- 20260817_000028_sw76_event_types_and_crypto_path.sql
-- ============================================================

-- Follow-up to the SW-76 document ledger.
-- Migration 25 introduced item_shared; keep it while adding the public-guide
-- events used by the new local document and archive layer.

alter table public.fiscal_events
  drop constraint if exists fiscal_events_event_type_check;

alter table public.fiscal_events
  add constraint fiscal_events_event_type_check check (event_type in (
    'item_added_after_invoice',
    'item_removed_after_invoice',
    'item_price_changed_after_invoice',
    'item_shared',
    'mev_error',
    'offline_mode_on',
    'offline_mode_off',
    'order_voided',
    'document_reprinted',
    'addition_revised',
    'print_error',
    'transmission_error',
    'customer_reproduction',
    'fiscal_archive_exported',
    'fiscal_document_recorded'
  ));

-- pgcrypto is installed in the extensions schema on Supabase. The function uses
-- digest() to preserve the exact printed content, so include that schema in its
-- fixed SECURITY DEFINER search path.
alter function public.record_fiscal_document(
  uuid, uuid, text, text, uuid, uuid, uuid, text, boolean, text, jsonb
) set search_path = public, private, extensions;

-- ============================================================
-- 20260817_000029_pwa_device_crypto_readiness.sql
-- ============================================================

-- PWA/device capability groundwork that is independent from the private SW-73 wire format.
--
-- This migration stores only public metadata about a browser capability probe. It never
-- receives or stores a private key and it does not claim that the probe key is a MEV-WEB
-- certificate key. The official algorithm, CSR and certificate lifecycle remain blocked
-- until the partner documentation is available.

alter table public.mev_devices
  add column if not exists browser_device_id text,
  add column if not exists crypto_probe_public_key_spki text,
  add column if not exists crypto_probe_sha256 text,
  add column if not exists crypto_probe_algorithm text,
  add column if not exists crypto_probe_created_at timestamptz,
  add column if not exists storage_persistent boolean not null default false,
  add column if not exists capabilities jsonb not null default '{}'::jsonb,
  add column if not exists last_crypto_self_test_at timestamptz;

create unique index if not exists mev_devices_browser_device_idx
  on public.mev_devices (restaurant_id, browser_device_id)
  where browser_device_id is not null;

comment on column public.mev_devices.crypto_probe_public_key_spki is
  'Public key from a browser capability probe only. Not an official MEV-WEB certificate key.';
comment on column public.mev_devices.crypto_probe_sha256 is
  'SHA-256 fingerprint of the capability-probe public key.';
comment on column public.mev_devices.capabilities is
  'Observed browser, storage, cryptography and print-bridge capabilities. Never contains private key material.';

create or replace function public.register_pwa_device_capabilities(
  p_restaurant_id uuid,
  p_browser_device_id text,
  p_crypto_probe_public_key_spki text default null,
  p_crypto_probe_sha256 text default null,
  p_crypto_probe_algorithm text default null,
  p_storage_persistent boolean default false,
  p_capabilities jsonb default '{}'::jsonb,
  p_crypto_verified boolean default false
)
returns public.mev_devices
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_row public.mev_devices;
  v_device_key text;
begin
  if not private.is_restaurant_member(p_restaurant_id) then
    raise exception 'Appareil PWA: acces refuse' using errcode = '42501';
  end if;

  if nullif(trim(p_browser_device_id), '') is null or char_length(trim(p_browser_device_id)) > 160 then
    raise exception 'Appareil PWA: identifiant local invalide' using errcode = '23514';
  end if;

  if p_crypto_probe_sha256 is not null and p_crypto_probe_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'Appareil PWA: empreinte SHA-256 invalide' using errcode = '23514';
  end if;

  v_device_key := 'pwa:' || trim(p_browser_device_id);

  insert into public.mev_devices (
    restaurant_id,
    device_key,
    environment,
    status,
    certificate_status,
    browser_device_id,
    crypto_probe_public_key_spki,
    crypto_probe_sha256,
    crypto_probe_algorithm,
    crypto_probe_created_at,
    storage_persistent,
    capabilities,
    last_crypto_self_test_at,
    last_seen_at,
    metadata
  ) values (
    p_restaurant_id,
    v_device_key,
    'simulator',
    case when coalesce(p_crypto_verified, false) then 'pending' else 'unregistered' end,
    'missing',
    trim(p_browser_device_id),
    p_crypto_probe_public_key_spki,
    p_crypto_probe_sha256,
    p_crypto_probe_algorithm,
    case when p_crypto_probe_public_key_spki is not null then now() else null end,
    coalesce(p_storage_persistent, false),
    coalesce(p_capabilities, '{}'::jsonb),
    case when coalesce(p_crypto_verified, false) then now() else null end,
    now(),
    jsonb_build_object(
      'probe_only', true,
      'official_certificate_configured', false,
      'private_key_received_by_server', false
    )
  )
  on conflict (restaurant_id, device_key) do update set
    browser_device_id = excluded.browser_device_id,
    crypto_probe_public_key_spki = coalesce(excluded.crypto_probe_public_key_spki, public.mev_devices.crypto_probe_public_key_spki),
    crypto_probe_sha256 = coalesce(excluded.crypto_probe_sha256, public.mev_devices.crypto_probe_sha256),
    crypto_probe_algorithm = coalesce(excluded.crypto_probe_algorithm, public.mev_devices.crypto_probe_algorithm),
    crypto_probe_created_at = case
      when excluded.crypto_probe_public_key_spki is not null then coalesce(public.mev_devices.crypto_probe_created_at, now())
      else public.mev_devices.crypto_probe_created_at
    end,
    storage_persistent = excluded.storage_persistent,
    capabilities = excluded.capabilities,
    last_crypto_self_test_at = case
      when coalesce(p_crypto_verified, false) then now()
      else public.mev_devices.last_crypto_self_test_at
    end,
    last_seen_at = now(),
    updated_at = now(),
    status = case
      when public.mev_devices.status = 'active' then 'active'
      when coalesce(p_crypto_verified, false) then 'pending'
      else public.mev_devices.status
    end,
    metadata = coalesce(public.mev_devices.metadata, '{}'::jsonb) || jsonb_build_object(
      'probe_only', true,
      'official_certificate_configured', public.mev_devices.certificate_status = 'active',
      'private_key_received_by_server', false
    )
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.register_pwa_device_capabilities(
  uuid, text, text, text, text, boolean, jsonb, boolean
) from public, anon;
grant execute on function public.register_pwa_device_capabilities(
  uuid, text, text, text, text, boolean, jsonb, boolean
) to authenticated;

commit;
