-- SW-78 FO-121/FO-124: the exploitant must be able to delete their data from the SEV. Deleting
-- the whole restaurant row would cascade onto every fiscal table too (invoices, payments,
-- mev_attempts/transactions/receipts, fiscal_events all reference restaurants(id) on delete
-- cascade) -- that would both violate SW-76's append-only fiscal chain requirement and Quebec's
-- accounting-record retention obligation. This deletes only operational/configuration data:
-- menu, tables, printers, sections, tip presets, reservations, customers, business costs/fixed
-- expenses, MEV partner config/devices/requests, sync events, and staff access (except the
-- owner's own membership). It never touches orders, order_items, invoices, invoice_items,
-- payments, mev_attempts, mev_transactions, mev_receipts, fiscal_events, fiscal_documents,
-- user_reports or invoice/fiscal document counters.
--
-- Every foreign key from a table this deletes into a table it must NOT delete is "on delete set
-- null" (order_items.product_id, orders.table_id, mev_transactions/mev_receipts.device_id) --
-- confirmed by reading every "references public.restaurants(id)"/"references public.mev_devices"
-- in the migration history before writing this, not assumed.

create or replace function public.delete_operator_data()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_restaurant_id uuid;
begin
  select id into v_restaurant_id from public.restaurants where owner_id = auth.uid() order by created_at asc limit 1;
  if v_restaurant_id is null then
    raise exception 'MEV: aucun restaurant trouve pour ce compte' using errcode = 'P0002';
  end if;

  delete from public.reservation_slot_closures where restaurant_id = v_restaurant_id;
  delete from public.reservation_slots where restaurant_id = v_restaurant_id;
  delete from public.reservation_settings where restaurant_id = v_restaurant_id;
  delete from public.reservations where restaurant_id = v_restaurant_id;
  delete from public.customers where restaurant_id = v_restaurant_id;
  delete from public.business_cost_documents where restaurant_id = v_restaurant_id;
  delete from public.business_costs where restaurant_id = v_restaurant_id;
  delete from public.fixed_expenses where restaurant_id = v_restaurant_id;
  delete from public.tip_presets where restaurant_id = v_restaurant_id;
  delete from public.sync_events where restaurant_id = v_restaurant_id;
  delete from public.mev_partner_requests where restaurant_id = v_restaurant_id;
  delete from public.mev_partner_config where restaurant_id = v_restaurant_id;
  delete from public.mev_devices where restaurant_id = v_restaurant_id;
  delete from public.printers where restaurant_id = v_restaurant_id;
  delete from public.products where restaurant_id = v_restaurant_id;
  delete from public.restaurant_tables where restaurant_id = v_restaurant_id;
  delete from public.restaurant_sections where restaurant_id = v_restaurant_id;
  delete from public.restaurant_members where restaurant_id = v_restaurant_id and user_id <> auth.uid();

  -- app_settings has restaurant_id as its primary key (one row per restaurant, referenced by
  -- finalize_invoice() for tax rates on every future sale) -- reset it to defaults instead of
  -- deleting the row, so the restaurant keeps working immediately afterward. Tax rates are left
  -- untouched: they aren't operator-identifying data, and mev_devices/mev_partner_config are
  -- gone above, so mev_mode/demo_mode/formation_mode must fall back to safe defaults regardless.
  update public.app_settings
  set mev_mode = 'simulator', demo_mode = false, formation_mode = false, updated_at = now()
  where restaurant_id = v_restaurant_id;
end;
$$;
revoke all on function public.delete_operator_data() from public, anon;
grant execute on function public.delete_operator_data() to authenticated;
