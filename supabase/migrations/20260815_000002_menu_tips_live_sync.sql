alter table public.products add column if not exists tax_category text not null default 'standard';
alter table public.products add column if not exists kitchen_station text not null default 'kitchen';
alter table public.products add column if not exists description text;
alter table public.products add column if not exists sku text;
alter table public.products add column if not exists updated_at timestamptz not null default now();

alter table public.invoices add column if not exists tip_amount numeric(12,2) not null default 0 check (tip_amount >= 0);
alter table public.invoices add column if not exists payment_total numeric(12,2);
alter table public.invoices add column if not exists tip_mode text check (tip_mode in ('none','percent','amount'));
alter table public.invoices add column if not exists tip_value numeric(12,2);
alter table public.payments add column if not exists tip_amount numeric(12,2) not null default 0 check (tip_amount >= 0);

create table if not exists public.tip_presets (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  label text not null,
  percentage numeric(6,3) not null check (percentage >= 0 and percentage <= 100),
  sort_order integer not null default 0,
  active boolean not null default true,
  unique (restaurant_id, percentage)
);

create table if not exists public.app_settings (
  restaurant_id uuid primary key references public.restaurants(id) on delete cascade,
  tax_gst numeric(8,5) not null default 0.05,
  tax_qst numeric(8,5) not null default 0.09975,
  tips_enabled boolean not null default true,
  tip_basis text not null default 'after_tax' check (tip_basis in ('before_tax','after_tax')),
  mev_mode text not null default 'simulator' check (mev_mode in ('simulator','live','disabled')),
  updated_at timestamptz not null default now()
);

alter table public.tip_presets enable row level security;
alter table public.app_settings enable row level security;
create policy "tip presets member access" on public.tip_presets for all using (public.is_restaurant_member(restaurant_id)) with check (public.is_restaurant_member(restaurant_id));
create policy "app settings member access" on public.app_settings for all using (public.is_restaurant_member(restaurant_id)) with check (public.is_restaurant_member(restaurant_id));

alter publication supabase_realtime add table public.restaurant_tables;
alter publication supabase_realtime add table public.products;
alter publication supabase_realtime add table public.orders;
alter publication supabase_realtime add table public.order_items;
alter publication supabase_realtime add table public.invoices;
alter publication supabase_realtime add table public.payments;
alter publication supabase_realtime add table public.printers;
alter publication supabase_realtime add table public.tip_presets;
alter publication supabase_realtime add table public.app_settings;
