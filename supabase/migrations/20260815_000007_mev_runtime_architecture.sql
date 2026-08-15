create table if not exists public.mev_devices (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  device_key text not null,
  environment text not null default 'simulator' check (environment in ('simulator','certification','production')),
  status text not null default 'unregistered' check (status in ('unregistered','pending','active','blocked','expired','error')),
  certificate_status text not null default 'missing' check (certificate_status in ('missing','pending','active','expired','revoked','error')),
  external_device_id text,
  last_seen_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (restaurant_id, device_key)
);

create table if not exists public.mev_transactions (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  device_id uuid references public.mev_devices(id) on delete set null,
  environment text not null default 'simulator' check (environment in ('simulator','certification','production')),
  status text not null default 'pending' check (status in ('pending','sending','accepted','retryable','rejected','failed','cancelled')),
  transaction_id text,
  document_id text,
  request_payload jsonb not null default '{}'::jsonb,
  response_payload jsonb not null default '{}'::jsonb,
  attempt_count integer not null default 0,
  last_error_code text,
  last_error_message text,
  retry_after timestamptz,
  sent_at timestamptz,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (invoice_id)
);

create table if not exists public.mev_receipts (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  mev_transaction_id uuid references public.mev_transactions(id) on delete cascade,
  document_type text not null default 'closing_receipt' check (document_type in ('addition','closing_receipt','credit_note','correction')),
  fiscal_document_id text,
  qr_payload text,
  receipt_payload jsonb not null default '{}'::jsonb,
  is_simulated boolean not null default true,
  created_at timestamptz not null default now(),
  unique (invoice_id, document_type)
);

create index if not exists idx_mev_transactions_pending on public.mev_transactions (restaurant_id, status, retry_after) where status in ('pending','retryable');
create index if not exists idx_mev_transactions_txid on public.mev_transactions (transaction_id) where transaction_id is not null;
create index if not exists idx_mev_devices_restaurant on public.mev_devices (restaurant_id, status);

alter table public.mev_devices enable row level security;
alter table public.mev_transactions enable row level security;
alter table public.mev_receipts enable row level security;

drop policy if exists mev_devices_member_all on public.mev_devices;
create policy mev_devices_member_all on public.mev_devices for all to authenticated using (public.is_restaurant_member(restaurant_id)) with check (public.is_restaurant_member(restaurant_id));
drop policy if exists mev_transactions_member_all on public.mev_transactions;
create policy mev_transactions_member_all on public.mev_transactions for all to authenticated using (public.is_restaurant_member(restaurant_id)) with check (public.is_restaurant_member(restaurant_id));
drop policy if exists mev_receipts_member_all on public.mev_receipts;
create policy mev_receipts_member_all on public.mev_receipts for all to authenticated using (public.is_restaurant_member(restaurant_id)) with check (public.is_restaurant_member(restaurant_id));

create or replace function public.mirror_mev_attempt_to_runtime()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  tx_id uuid;
  normalized_status text;
  env text;
begin
  normalized_status := case
    when new.status = 'accepted' then 'accepted'
    when new.status in ('retryable','timeout','pending') then 'retryable'
    when new.status = 'rejected' then 'rejected'
    else 'failed'
  end;
  env := case lower(coalesce(new.environment,'simulator'))
    when 'production' then 'production'
    when 'certification' then 'certification'
    else 'simulator'
  end;

  insert into public.mev_transactions (
    restaurant_id, invoice_id, environment, status, transaction_id,
    request_payload, response_payload, attempt_count,
    last_error_message, retry_after, sent_at, accepted_at, updated_at
  ) values (
    new.restaurant_id, new.invoice_id, env, normalized_status, new.transaction_id,
    coalesce(new.request_payload,'{}'::jsonb), coalesce(new.response_payload,'{}'::jsonb), 1,
    new.error_message,
    case when normalized_status = 'retryable' then now() + interval '1 minute' else null end,
    new.created_at,
    case when normalized_status = 'accepted' then coalesce(new.created_at, now()) else null end,
    now()
  )
  on conflict (invoice_id) do update set
    environment = excluded.environment,
    status = excluded.status,
    transaction_id = coalesce(excluded.transaction_id, public.mev_transactions.transaction_id),
    request_payload = excluded.request_payload,
    response_payload = excluded.response_payload,
    attempt_count = public.mev_transactions.attempt_count + 1,
    last_error_message = excluded.last_error_message,
    retry_after = excluded.retry_after,
    sent_at = excluded.sent_at,
    accepted_at = coalesce(excluded.accepted_at, public.mev_transactions.accepted_at),
    updated_at = now()
  returning id into tx_id;

  if new.qr_payload is not null or normalized_status = 'accepted' then
    insert into public.mev_receipts (
      restaurant_id, invoice_id, mev_transaction_id, document_type,
      fiscal_document_id, qr_payload, receipt_payload, is_simulated
    ) values (
      new.restaurant_id, new.invoice_id, tx_id, 'closing_receipt',
      coalesce(new.response_payload->>'document_id', new.transaction_id),
      new.qr_payload,
      coalesce(new.response_payload->'receipt','{}'::jsonb),
      env <> 'production'
    )
    on conflict (invoice_id, document_type) do update set
      mev_transaction_id = excluded.mev_transaction_id,
      fiscal_document_id = excluded.fiscal_document_id,
      qr_payload = excluded.qr_payload,
      receipt_payload = excluded.receipt_payload,
      is_simulated = excluded.is_simulated;
  end if;
  return new;
end;
$$;

revoke all on function public.mirror_mev_attempt_to_runtime() from public, anon, authenticated;

drop trigger if exists trg_mirror_mev_attempt_runtime on public.mev_attempts;
create trigger trg_mirror_mev_attempt_runtime
after insert on public.mev_attempts
for each row execute function public.mirror_mev_attempt_to_runtime();
