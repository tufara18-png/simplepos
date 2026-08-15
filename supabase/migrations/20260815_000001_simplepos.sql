-- SimplePOS minimal Supabase schema
-- Run in Supabase SQL editor or as a migration.

create extension if not exists pgcrypto;

create table if not exists public.restaurants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.restaurant_members (
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'staff' check (role in ('owner','manager','staff')),
  created_at timestamptz not null default now(),
  primary key (restaurant_id, user_id)
);

create table if not exists public.restaurant_tables (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  number integer not null,
  label text,
  sort_order integer not null default 0,
  active boolean not null default true,
  unique (restaurant_id, number)
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name text not null,
  category text not null default 'AUTRES',
  price numeric(12,2) not null check (price >= 0),
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  table_id uuid references public.restaurant_tables(id) on delete set null,
  status text not null default 'open' check (status in ('open','partially_paid','paid','closed','cancelled')),
  guest_count integer not null default 1 check (guest_count >= 0),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create unique index if not exists one_open_order_per_table
  on public.orders(table_id)
  where table_id is not null and status in ('open','partially_paid');

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  name text not null,
  unit_price numeric(12,2) not null check (unit_price >= 0),
  quantity numeric(10,3) not null default 1 check (quantity > 0),
  paid_quantity numeric(10,3) not null default 0 check (paid_quantity >= 0),
  kitchen_status text not null default 'new' check (kitchen_status in ('new','sent','cancelled')),
  kitchen_sent_at timestamptz,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete restrict,
  subtotal numeric(12,2) not null,
  gst numeric(12,2) not null,
  qst numeric(12,2) not null,
  total numeric(12,2) not null,
  status text not null default 'pending_mev' check (status in ('pending_mev','accepted','failed','cancelled')),
  mev_transaction_id text,
  mev_payload jsonb,
  mev_response jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.invoice_items (
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  order_item_id uuid not null references public.order_items(id) on delete restrict,
  quantity numeric(10,3) not null default 1 check (quantity > 0),
  unit_price numeric(12,2) not null,
  line_total numeric(12,2) not null,
  primary key (invoice_id, order_item_id)
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete restrict,
  method text not null check (method in ('cash','card','other')),
  amount numeric(12,2) not null check (amount >= 0),
  external_reference text,
  created_at timestamptz not null default now()
);

create table if not exists public.printers (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name text not null,
  role text not null check (role in ('kitchen','receipt','bar')),
  ip_address text not null,
  port integer not null default 9100 check (port between 1 and 65535),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (restaurant_id, role, name)
);

create table if not exists public.sync_events (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  device_id text not null,
  event_type text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending','done','failed')),
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create or replace function public.is_restaurant_member(rid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.restaurant_members rm
    where rm.restaurant_id = rid and rm.user_id = auth.uid()
  ) or exists (
    select 1 from public.restaurants r
    where r.id = rid and r.owner_id = auth.uid()
  );
$$;

alter table public.restaurants enable row level security;
alter table public.restaurant_members enable row level security;
alter table public.restaurant_tables enable row level security;
alter table public.products enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.invoices enable row level security;
alter table public.invoice_items enable row level security;
alter table public.payments enable row level security;
alter table public.printers enable row level security;
alter table public.sync_events enable row level security;

-- Restaurants
create policy "restaurant owner read" on public.restaurants for select using (owner_id = auth.uid() or public.is_restaurant_member(id));
create policy "restaurant owner insert" on public.restaurants for insert with check (owner_id = auth.uid());
create policy "restaurant owner update" on public.restaurants for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Membership
create policy "members read" on public.restaurant_members for select using (public.is_restaurant_member(restaurant_id));
create policy "owner manages members" on public.restaurant_members for all using (
  exists (select 1 from public.restaurants r where r.id = restaurant_id and r.owner_id = auth.uid())
) with check (
  exists (select 1 from public.restaurants r where r.id = restaurant_id and r.owner_id = auth.uid())
);

-- Generic member access for restaurant-scoped tables
create policy "tables member access" on public.restaurant_tables for all using (public.is_restaurant_member(restaurant_id)) with check (public.is_restaurant_member(restaurant_id));
create policy "products member access" on public.products for all using (public.is_restaurant_member(restaurant_id)) with check (public.is_restaurant_member(restaurant_id));
create policy "orders member access" on public.orders for all using (public.is_restaurant_member(restaurant_id)) with check (public.is_restaurant_member(restaurant_id));
create policy "invoices member access" on public.invoices for all using (public.is_restaurant_member(restaurant_id)) with check (public.is_restaurant_member(restaurant_id));
create policy "payments member access" on public.payments for all using (public.is_restaurant_member(restaurant_id)) with check (public.is_restaurant_member(restaurant_id));
create policy "printers member access" on public.printers for all using (public.is_restaurant_member(restaurant_id)) with check (public.is_restaurant_member(restaurant_id));
create policy "sync member access" on public.sync_events for all using (public.is_restaurant_member(restaurant_id)) with check (public.is_restaurant_member(restaurant_id));

-- Child tables derive access through parent
create policy "order items member access" on public.order_items for all using (
  exists (select 1 from public.orders o where o.id = order_id and public.is_restaurant_member(o.restaurant_id))
) with check (
  exists (select 1 from public.orders o where o.id = order_id and public.is_restaurant_member(o.restaurant_id))
);

create policy "invoice items member access" on public.invoice_items for all using (
  exists (select 1 from public.invoices i where i.id = invoice_id and public.is_restaurant_member(i.restaurant_id))
) with check (
  exists (select 1 from public.invoices i where i.id = invoice_id and public.is_restaurant_member(i.restaurant_id))
);

-- Automatically make creator an owner member.
create or replace function public.add_owner_membership()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.restaurant_members(restaurant_id,user_id,role)
  values (new.id,new.owner_id,'owner')
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists trg_add_owner_membership on public.restaurants;
create trigger trg_add_owner_membership
after insert on public.restaurants
for each row execute function public.add_owner_membership();
