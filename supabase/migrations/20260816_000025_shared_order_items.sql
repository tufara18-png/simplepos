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
