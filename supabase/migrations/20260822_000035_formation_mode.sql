-- SW-77 Cas 008/508 "Utiliser le mode Formation" / SW-78 FO-117: a SEV may let staff practice
-- with fictitious transactions, but SW-73 4.4.1.1.16 is explicit that "peu importe le mode,
-- toutes les transactions doivent être transmises au MEV-WEB" -- Formation sales are still real
-- transmissions (modTrans "FOR" instead of "OPE"), just excluded from the operator's real sales
-- totals ("sans que celles-ci soient comptabilisées dans les ventes courantes de l'exploitant").
--
-- formation_mode is read server-side from app_settings, not trusted from the client, for the
-- same reason finalize_invoice() already recomputes every amount itself: a client cannot be
-- trusted to correctly self-report whether a sale should count as fiscal or not.

alter table public.app_settings
  add column if not exists formation_mode boolean not null default false;

alter table public.invoices
  add column if not exists mode_transaction text not null default 'OPE';

alter table public.invoices drop constraint if exists invoices_mode_transaction_check;
alter table public.invoices add constraint invoices_mode_transaction_check
  check (mode_transaction in ('OPE', 'FOR'));

-- Same body as 20260822_000034_card_type_credit_debit.sql's finalize_invoice() (itself a
-- verbatim copy of 20260816_000023's, plus p_card_type) with formation_mode looked up
-- alongside the tax rates and written to invoices.mode_transaction.

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

-- A credit note reversing a Formation-mode sale must itself stay Formation-mode -- otherwise a
-- practice sale's reversal would count as a real (negative) sale in reporting. Same body as
-- 20260816_000024_credit_notes_and_void_order.sql's create_credit_note(), copied verbatim, with
-- v_src.mode_transaction added to the insert (available for free since v_src is `select *`).

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
