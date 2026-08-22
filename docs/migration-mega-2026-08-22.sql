-- Resto360 — migration à appliquer dans le SQL Editor de Supabase (2026-08-22).
--
-- Regroupe, dans l'ordre, les deux migrations écrites cette session :
--   - supabase/migrations/20260822_000034_card_type_credit_debit.sql
--   - supabase/migrations/20260822_000035_formation_mode.sql
-- La seconde remplace déjà finalize_invoice()/create_credit_note() une deuxième fois avec tout
-- inclus (card_type + formation_mode) -- ce fichier ne les répète pas séparément, seule la
-- version finale des fonctions est incluse ci-dessous, pour éviter deux CREATE OR REPLACE
-- successifs de la même fonction dans un seul copier-coller.
--
-- Tout s'exécute dans une seule transaction : en cas d'erreur, rien n'est appliqué et la base
-- reste exactement dans son état actuel. Le réexécuter une deuxième fois ne casse rien (colonnes
-- en "add column if not exists", fonctions en "create or replace").

begin;

-- ============================================================
-- Nouvelles colonnes
-- ============================================================

alter table public.payments
  add column if not exists card_type text;

alter table public.payments drop constraint if exists payments_card_type_check;
alter table public.payments add constraint payments_card_type_check
  check (card_type is null or (method = 'card' and card_type in ('credit', 'debit')));

alter table public.app_settings
  add column if not exists formation_mode boolean not null default false;

alter table public.invoices
  add column if not exists mode_transaction text not null default 'OPE';

alter table public.invoices drop constraint if exists invoices_mode_transaction_check;
alter table public.invoices add constraint invoices_mode_transaction_check
  check (mode_transaction in ('OPE', 'FOR'));

-- ============================================================
-- finalize_invoice() -- version finale (card_type + formation_mode)
-- ============================================================

drop function if exists public.finalize_invoice(uuid, uuid[], numeric, text, numeric, numeric, text, boolean);

create or replace function public.finalize_invoice(
  p_order_id uuid,
  p_item_ids uuid[] default null,
  p_amount numeric default null,
  p_method text default 'cash',
  p_tip_amount numeric default 0,
  p_tendered_amount numeric default 0,
  p_tip_source text default 'none',
  p_produced_offline boolean default false,
  p_card_type text default null
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
  v_formation_mode boolean;
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
  if p_card_type is not null and (p_method <> 'card' or p_card_type not in ('credit', 'debit')) then
    raise exception 'MEV: card_type invalide pour ce mode de paiement' using errcode = '22023';
  end if;

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

  select coalesce(tax_gst, 0.05), coalesce(tax_qst, 0.09975), coalesce(formation_mode, false)
    into v_gst_rate, v_qst_rate, v_formation_mode
  from public.app_settings where restaurant_id = v_order.restaurant_id;
  v_gst_rate := coalesce(v_gst_rate, 0.05);
  v_qst_rate := coalesce(v_qst_rate, 0.09975);
  v_formation_mode := coalesce(v_formation_mode, false);

  select coalesce(sum(oi.unit_price * (oi.quantity - oi.paid_quantity)), 0)
    into v_remaining_gross
  from public.order_items oi
  where oi.order_id = p_order_id
    and oi.kitchen_status <> 'cancelled'
    and oi.paid_quantity < oi.quantity;
  v_remaining_gross := round(v_remaining_gross * (1 + v_gst_rate + v_qst_rate), 2);

  if p_item_ids is not null and array_length(p_item_ids, 1) > 0 then
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
    tip_amount, payment_total, tip_mode, tip_value, status, produced_offline, mev_payload,
    mode_transaction
  ) values (
    v_order.restaurant_id, p_order_id, v_sub, v_gst, v_qst, v_total,
    v_tip, round(v_total + v_tip, 2), p_tip_source, v_tip, 'pending_mev', coalesce(p_produced_offline, false),
    jsonb_build_object('kind', case when p_item_ids is not null and array_length(p_item_ids,1) > 0 then 'items' else 'amount' end,
                       'server_computed', true),
    case when v_formation_mode then 'FOR' else 'OPE' end
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
    tendered_amount, terminal_total, change_due, tip_source, card_type
  ) values (
    v_order.restaurant_id, v_invoice.id, p_method, round(v_total + v_tip, 2), v_tip,
    round(coalesce(p_tendered_amount, 0), 2),
    case when p_method = 'card' then round(coalesce(p_tendered_amount, 0), 2) else null end,
    greatest(round(coalesce(p_tendered_amount, 0) - v_total - v_tip, 2), 0),
    p_tip_source, p_card_type
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

revoke all on function public.finalize_invoice(uuid, uuid[], numeric, text, numeric, numeric, text, boolean, text) from public, anon;
grant execute on function public.finalize_invoice(uuid, uuid[], numeric, text, numeric, numeric, text, boolean, text) to authenticated;

-- ============================================================
-- create_credit_note() -- version finale (propage mode_transaction)
-- ============================================================

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
    tip_amount, payment_total, status, replaces_invoice_id, mev_payload, mode_transaction
  ) values (
    v_src.restaurant_id, v_src.order_id, -v_src.subtotal, -v_src.gst, -v_src.qst, -v_src.total,
    0, -(v_src.payment_total), 'pending_mev', v_src.id,
    jsonb_build_object('kind', 'credit_note', 'reason', p_reason, 'server_computed', true),
    v_src.mode_transaction
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

commit;

-- ============================================================
-- Vérification -- ne modifie rien, tout doit afficher OK
-- ============================================================

select 'Colonne payments.card_type' as verification,
       case when exists (select 1 from information_schema.columns where table_schema='public' and table_name='payments' and column_name='card_type')
            then 'OK' else 'MANQUANT' end as etat
union all
select 'Colonne app_settings.formation_mode',
       case when exists (select 1 from information_schema.columns where table_schema='public' and table_name='app_settings' and column_name='formation_mode')
            then 'OK' else 'MANQUANT' end
union all
select 'Colonne invoices.mode_transaction',
       case when exists (select 1 from information_schema.columns where table_schema='public' and table_name='invoices' and column_name='mode_transaction')
            then 'OK' else 'MANQUANT' end
union all
select 'finalize_invoice() accepte p_card_type',
       case when exists (
         select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='finalize_invoice' and pg_get_function_identity_arguments(p.oid) ilike '%p_card_type%'
       ) then 'OK' else 'MANQUANT' end;
