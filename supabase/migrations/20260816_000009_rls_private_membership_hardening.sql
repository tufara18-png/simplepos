create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create or replace function private.is_restaurant_member(rid uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1 from public.restaurant_members rm
    where rm.restaurant_id = rid and rm.user_id = (select auth.uid())
  ) or exists (
    select 1 from public.restaurants r
    where r.id = rid and r.owner_id = (select auth.uid())
  );
$$;
revoke all on function private.is_restaurant_member(uuid) from public, anon;
grant execute on function private.is_restaurant_member(uuid) to authenticated;

drop policy if exists "app settings member access" on public.app_settings;
create policy "app settings member access" on public.app_settings for all to authenticated using (private.is_restaurant_member(restaurant_id)) with check (private.is_restaurant_member(restaurant_id));

drop policy if exists "invoice items member access" on public.invoice_items;
create policy "invoice items member access" on public.invoice_items for all to authenticated using (exists (select 1 from public.invoices i where i.id=invoice_items.invoice_id and private.is_restaurant_member(i.restaurant_id))) with check (exists (select 1 from public.invoices i where i.id=invoice_items.invoice_id and private.is_restaurant_member(i.restaurant_id)));

drop policy if exists "invoices member access" on public.invoices;
create policy "invoices member access" on public.invoices for all to authenticated using (private.is_restaurant_member(restaurant_id)) with check (private.is_restaurant_member(restaurant_id));

drop policy if exists "mev attempts member access" on public.mev_attempts;
create policy "mev attempts member access" on public.mev_attempts for all to authenticated using (private.is_restaurant_member(restaurant_id)) with check (private.is_restaurant_member(restaurant_id));

drop policy if exists mev_devices_member_all on public.mev_devices;
create policy mev_devices_member_all on public.mev_devices for all to authenticated using (private.is_restaurant_member(restaurant_id)) with check (private.is_restaurant_member(restaurant_id));

drop policy if exists mev_receipts_member_all on public.mev_receipts;
create policy mev_receipts_member_all on public.mev_receipts for all to authenticated using (private.is_restaurant_member(restaurant_id)) with check (private.is_restaurant_member(restaurant_id));

drop policy if exists mev_transactions_member_all on public.mev_transactions;
create policy mev_transactions_member_all on public.mev_transactions for all to authenticated using (private.is_restaurant_member(restaurant_id)) with check (private.is_restaurant_member(restaurant_id));

drop policy if exists "order items member access" on public.order_items;
create policy "order items member access" on public.order_items for all to authenticated using (exists (select 1 from public.orders o where o.id=order_items.order_id and private.is_restaurant_member(o.restaurant_id))) with check (exists (select 1 from public.orders o where o.id=order_items.order_id and private.is_restaurant_member(o.restaurant_id)));

drop policy if exists "orders member access" on public.orders;
create policy "orders member access" on public.orders for all to authenticated using (private.is_restaurant_member(restaurant_id)) with check (private.is_restaurant_member(restaurant_id));

drop policy if exists "payments member access" on public.payments;
create policy "payments member access" on public.payments for all to authenticated using (private.is_restaurant_member(restaurant_id)) with check (private.is_restaurant_member(restaurant_id));

drop policy if exists "printers member access" on public.printers;
create policy "printers member access" on public.printers for all to authenticated using (private.is_restaurant_member(restaurant_id)) with check (private.is_restaurant_member(restaurant_id));

drop policy if exists "products member access" on public.products;
create policy "products member access" on public.products for all to authenticated using (private.is_restaurant_member(restaurant_id)) with check (private.is_restaurant_member(restaurant_id));

drop policy if exists "members read" on public.restaurant_members;
create policy "members read" on public.restaurant_members for select to authenticated using (private.is_restaurant_member(restaurant_id));

drop policy if exists "owner manages members" on public.restaurant_members;
create policy "owner manages members" on public.restaurant_members for all to authenticated using (exists (select 1 from public.restaurants r where r.id=restaurant_members.restaurant_id and r.owner_id=(select auth.uid()))) with check (exists (select 1 from public.restaurants r where r.id=restaurant_members.restaurant_id and r.owner_id=(select auth.uid())));

drop policy if exists "sections member access" on public.restaurant_sections;
create policy "sections member access" on public.restaurant_sections for all to authenticated using (private.is_restaurant_member(restaurant_id)) with check (private.is_restaurant_member(restaurant_id));

drop policy if exists "tables member access" on public.restaurant_tables;
create policy "tables member access" on public.restaurant_tables for all to authenticated using (private.is_restaurant_member(restaurant_id)) with check (private.is_restaurant_member(restaurant_id));

drop policy if exists "restaurant owner insert" on public.restaurants;
create policy "restaurant owner insert" on public.restaurants for insert to authenticated with check (owner_id=(select auth.uid()));
drop policy if exists "restaurant owner read" on public.restaurants;
create policy "restaurant owner read" on public.restaurants for select to authenticated using (owner_id=(select auth.uid()) or private.is_restaurant_member(id));
drop policy if exists "restaurant owner update" on public.restaurants;
create policy "restaurant owner update" on public.restaurants for update to authenticated using (owner_id=(select auth.uid())) with check (owner_id=(select auth.uid()));

drop policy if exists "sync member access" on public.sync_events;
create policy "sync member access" on public.sync_events for all to authenticated using (private.is_restaurant_member(restaurant_id)) with check (private.is_restaurant_member(restaurant_id));

drop policy if exists "tip presets member access" on public.tip_presets;
create policy "tip presets member access" on public.tip_presets for all to authenticated using (private.is_restaurant_member(restaurant_id)) with check (private.is_restaurant_member(restaurant_id));

drop function if exists public.is_restaurant_member(uuid);

create index if not exists products_restaurant_idx on public.products(restaurant_id);
create index if not exists restaurant_members_user_idx on public.restaurant_members(user_id);
create index if not exists restaurants_owner_idx on public.restaurants(owner_id);
create index if not exists sync_events_restaurant_idx on public.sync_events(restaurant_id);
