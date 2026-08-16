-- Additive pivot/place support. Existing fiscal tables and RPCs are untouched.

alter table public.order_items
  add column if not exists seat_number integer not null default 1;

alter table public.order_items
  drop constraint if exists order_items_seat_number_check;

alter table public.order_items
  add constraint order_items_seat_number_check
  check (seat_number between 1 and 99);

alter table public.invoice_items
  add column if not exists seat_number integer;

alter table public.invoice_items
  drop constraint if exists invoice_items_seat_number_check;

alter table public.invoice_items
  add constraint invoice_items_seat_number_check
  check (seat_number is null or seat_number between 1 and 99);

create index if not exists order_items_order_id_seat_number_idx
  on public.order_items(order_id, seat_number);

comment on column public.order_items.seat_number is
  'Service pivot/place assigned while taking the order. Operational only; does not alter fiscal totals.';

comment on column public.invoice_items.seat_number is
  'Snapshot of the originating service pivot/place when available.';
