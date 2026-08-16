-- Two documents the SW-76 requires that SimplePOS could not produce at all:
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
