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
