create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 2 and 120),
  phone text,
  email text,
  notes text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists customers_restaurant_idx on public.customers(restaurant_id);
create index if not exists customers_phone_idx on public.customers(restaurant_id, phone) where phone is not null;
create index if not exists customers_email_idx on public.customers(restaurant_id, lower(email)) where email is not null;

create table if not exists public.reservation_settings (
  restaurant_id uuid primary key references public.restaurants(id) on delete cascade,
  capacity integer not null default 50 check (capacity between 1 and 500),
  duration_minutes integer not null default 90 check (duration_minutes between 15 and 360),
  auto_accept_web boolean not null default false,
  public_booking_enabled boolean not null default false,
  booking_slug text,
  updated_at timestamptz not null default now()
);
create unique index if not exists reservation_settings_booking_slug_uidx on public.reservation_settings(lower(booking_slug)) where booking_slug is not null;

create table if not exists public.reservation_slots (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  slot_time time not null,
  active boolean not null default true,
  unique(restaurant_id, weekday, slot_time)
);
create index if not exists reservation_slots_restaurant_idx on public.reservation_slots(restaurant_id, weekday, slot_time);

create table if not exists public.reservation_slot_closures (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  reservation_date date not null,
  slot_time time not null,
  reason text,
  created_at timestamptz not null default now(),
  unique(restaurant_id, reservation_date, slot_time)
);
create index if not exists reservation_slot_closures_restaurant_idx on public.reservation_slot_closures(restaurant_id, reservation_date);

create table if not exists public.reservations (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  reservation_date date not null,
  reservation_time time not null,
  party_size integer not null check (party_size between 1 and 100),
  customer_name text not null check (char_length(trim(customer_name)) between 2 and 120),
  phone text,
  email text,
  source text not null default 'telephone' check (source in ('web','telephone','walk_in','staff')),
  status text not null default 'confirmed' check (status in ('pending','confirmed','rejected','cancelled','no_show','arrived','seated','completed')),
  seating_preference text not null default 'any' check (seating_preference in ('any','table','bar','terrace')),
  notes text,
  assigned_table_id uuid references public.restaurant_tables(id) on delete set null,
  order_id uuid references public.orders(id) on delete set null,
  arrived_at timestamptz,
  seated_at timestamptz,
  completed_at timestamptz,
  cancel_token uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists reservations_cancel_token_uidx on public.reservations(cancel_token);
create index if not exists reservations_restaurant_date_idx on public.reservations(restaurant_id, reservation_date, reservation_time);
create index if not exists reservations_customer_idx on public.reservations(customer_id) where customer_id is not null;
create index if not exists reservations_table_idx on public.reservations(assigned_table_id) where assigned_table_id is not null;
create index if not exists reservations_order_idx on public.reservations(order_id) where order_id is not null;

alter table public.orders add column if not exists customer_id uuid references public.customers(id) on delete set null;
alter table public.orders add column if not exists reservation_id uuid references public.reservations(id) on delete set null;
create index if not exists orders_customer_idx on public.orders(customer_id) where customer_id is not null;
create index if not exists orders_reservation_idx on public.orders(reservation_id) where reservation_id is not null;

alter table public.invoices add column if not exists customer_id uuid references public.customers(id) on delete set null;
alter table public.invoices add column if not exists reservation_id uuid references public.reservations(id) on delete set null;
create index if not exists invoices_customer_idx on public.invoices(customer_id) where customer_id is not null;
create index if not exists invoices_reservation_idx on public.invoices(reservation_id) where reservation_id is not null;

create table if not exists public.business_costs (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 2 and 160),
  category text not null default 'other' check (category in ('rent','utilities','inventory','payroll','insurance','software','professional','maintenance','marketing','taxes','financing','goodwill','equipment','other')),
  vendor text,
  amount numeric(12,2) not null check (amount >= 0),
  recurrence text not null default 'one_time' check (recurrence in ('one_time','weekly','monthly','quarterly','yearly')),
  incurred_on date not null default current_date,
  amortization_months integer check (amortization_months is null or amortization_months between 1 and 600),
  invoice_reference text,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists business_costs_restaurant_idx on public.business_costs(restaurant_id, active, incurred_on desc);
create index if not exists business_costs_category_idx on public.business_costs(restaurant_id, category);

insert into public.reservation_settings(restaurant_id)
select id from public.restaurants
on conflict (restaurant_id) do nothing;
update public.reservation_settings set booking_slug = 'restaurant-' || left(replace(restaurant_id::text,'-',''),8) where booking_slug is null;

alter table public.customers enable row level security;
alter table public.reservation_settings enable row level security;
alter table public.reservation_slots enable row level security;
alter table public.reservation_slot_closures enable row level security;
alter table public.reservations enable row level security;
alter table public.business_costs enable row level security;

drop policy if exists customers_member_access on public.customers;
create policy customers_member_access on public.customers for all to authenticated using (private.is_restaurant_member(restaurant_id)) with check (private.is_restaurant_member(restaurant_id));
drop policy if exists reservation_settings_member_access on public.reservation_settings;
create policy reservation_settings_member_access on public.reservation_settings for all to authenticated using (private.is_restaurant_member(restaurant_id)) with check (private.is_restaurant_member(restaurant_id));
drop policy if exists reservation_slots_member_access on public.reservation_slots;
create policy reservation_slots_member_access on public.reservation_slots for all to authenticated using (private.is_restaurant_member(restaurant_id)) with check (private.is_restaurant_member(restaurant_id));
drop policy if exists reservation_slot_closures_member_access on public.reservation_slot_closures;
create policy reservation_slot_closures_member_access on public.reservation_slot_closures for all to authenticated using (private.is_restaurant_member(restaurant_id)) with check (private.is_restaurant_member(restaurant_id));
drop policy if exists reservations_member_access on public.reservations;
create policy reservations_member_access on public.reservations for all to authenticated using (private.is_restaurant_member(restaurant_id)) with check (private.is_restaurant_member(restaurant_id));
drop policy if exists business_costs_member_access on public.business_costs;
create policy business_costs_member_access on public.business_costs for all to authenticated using (private.is_restaurant_member(restaurant_id)) with check (private.is_restaurant_member(restaurant_id));

create or replace function public.propagate_order_customer_to_invoice()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if new.customer_id is null or new.reservation_id is null then
    select coalesce(new.customer_id, o.customer_id), coalesce(new.reservation_id, o.reservation_id)
      into new.customer_id, new.reservation_id
    from public.orders o where o.id = new.order_id;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_invoice_customer_context on public.invoices;
create trigger trg_invoice_customer_context before insert or update of order_id on public.invoices for each row execute function public.propagate_order_customer_to_invoice();

create or replace function public.complete_reservation_from_order()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if new.status = 'closed' and old.status is distinct from new.status and new.reservation_id is not null then
    update public.reservations set status='completed', completed_at=coalesce(completed_at, now()), updated_at=now() where id=new.reservation_id;
    if new.customer_id is not null then update public.customers set last_seen_at=now(), updated_at=now() where id=new.customer_id; end if;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_complete_reservation_from_order on public.orders;
create trigger trg_complete_reservation_from_order after update of status on public.orders for each row execute function public.complete_reservation_from_order();