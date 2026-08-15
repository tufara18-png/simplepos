create table if not exists public.mev_attempts (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  environment text not null default 'simulator' check (environment in ('simulator','confirmation','production')),
  attempt_no integer not null default 1 check (attempt_no > 0),
  request_payload jsonb not null default '{}'::jsonb,
  response_payload jsonb,
  status text not null default 'pending' check (status in ('pending','accepted','rejected','failed')),
  http_status integer,
  error_code text,
  error_message text,
  transaction_id text,
  qr_payload text,
  sent_at timestamptz,
  received_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_mev_attempts_invoice
  on public.mev_attempts(invoice_id, created_at desc);

create index if not exists idx_mev_attempts_pending
  on public.mev_attempts(status, created_at)
  where status in ('pending','failed');

alter table public.mev_attempts enable row level security;

create policy "mev attempts member access"
  on public.mev_attempts for all
  using (public.is_restaurant_member(restaurant_id))
  with check (public.is_restaurant_member(restaurant_id));
