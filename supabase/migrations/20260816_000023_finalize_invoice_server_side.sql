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
