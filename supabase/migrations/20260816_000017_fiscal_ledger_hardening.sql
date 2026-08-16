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
create policy "invoices select" on public.invoices for select to authenticated using (private.is_restaurant_member(restaurant_id));
create policy "invoices insert" on public.invoices for insert to authenticated with check (private.is_restaurant_member(restaurant_id));
revoke update, delete on public.invoices from authenticated, anon;

drop policy if exists "invoice items member access" on public.invoice_items;
create policy "invoice items select" on public.invoice_items for select to authenticated using (exists (select 1 from public.invoices i where i.id = invoice_items.invoice_id and private.is_restaurant_member(i.restaurant_id)));
create policy "invoice items insert" on public.invoice_items for insert to authenticated with check (exists (select 1 from public.invoices i where i.id = invoice_items.invoice_id and private.is_restaurant_member(i.restaurant_id)));
revoke update, delete on public.invoice_items from authenticated, anon;

drop policy if exists "payments member access" on public.payments;
create policy "payments select" on public.payments for select to authenticated using (private.is_restaurant_member(restaurant_id));
create policy "payments insert" on public.payments for insert to authenticated with check (private.is_restaurant_member(restaurant_id));
revoke update, delete on public.payments from authenticated, anon;

drop policy if exists "mev attempts member access" on public.mev_attempts;
create policy "mev attempts select" on public.mev_attempts for select to authenticated using (private.is_restaurant_member(restaurant_id));
create policy "mev attempts insert" on public.mev_attempts for insert to authenticated with check (private.is_restaurant_member(restaurant_id));
revoke update, delete on public.mev_attempts from authenticated, anon;

-- mev_transactions and mev_receipts are only ever written by the mirror_mev_attempt_to_runtime
-- trigger (SECURITY DEFINER, bypasses RLS) or by the RPCs defined below. The client only reads them.
drop policy if exists mev_transactions_member_all on public.mev_transactions;
create policy "mev transactions select" on public.mev_transactions for select to authenticated using (private.is_restaurant_member(restaurant_id));
revoke insert, update, delete on public.mev_transactions from authenticated, anon;

drop policy if exists mev_receipts_member_all on public.mev_receipts;
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
