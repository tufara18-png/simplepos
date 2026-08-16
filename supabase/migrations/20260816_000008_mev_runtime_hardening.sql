alter table public.invoices drop constraint if exists invoices_tip_mode_check;
alter table public.invoices add constraint invoices_tip_mode_check check (tip_mode is null or tip_mode in ('none','percent','amount','external_terminal','manual_cash'));

alter table public.invoices drop constraint if exists invoices_status_check;
alter table public.invoices add constraint invoices_status_check check (status in ('pending_mev','accepted','retryable','rejected','failed','cancelled'));

alter table public.mev_attempts drop constraint if exists mev_attempts_status_check;
alter table public.mev_attempts add constraint mev_attempts_status_check check (status in ('pending','sending','accepted','retryable','rejected','timeout','network_error','failed'));

alter table public.mev_attempts drop constraint if exists mev_attempts_environment_check;
alter table public.mev_attempts add constraint mev_attempts_environment_check check (environment in ('simulator','confirmation','certification','production'));

alter table public.mev_attempts
  add column if not exists operation text not null default 'sale_close',
  add column if not exists document_id text,
  add column if not exists remote_status text,
  add column if not exists retry_after timestamptz;

alter table public.mev_receipts
  add column if not exists printed_at timestamptz,
  add column if not exists print_attempts integer not null default 0,
  add column if not exists last_print_error text;

create index if not exists invoice_items_order_item_idx on public.invoice_items(order_item_id);
create index if not exists invoices_restaurant_idx on public.invoices(restaurant_id);
create index if not exists invoices_order_idx on public.invoices(order_id);
create index if not exists payments_restaurant_idx on public.payments(restaurant_id);
create index if not exists payments_invoice_idx on public.payments(invoice_id);
create index if not exists order_items_order_idx on public.order_items(order_id);
create index if not exists order_items_product_idx on public.order_items(product_id);
create index if not exists orders_restaurant_idx on public.orders(restaurant_id);
create index if not exists orders_created_by_idx on public.orders(created_by);
create index if not exists mev_attempts_restaurant_idx on public.mev_attempts(restaurant_id);
create index if not exists mev_receipts_restaurant_idx on public.mev_receipts(restaurant_id);
create index if not exists mev_receipts_transaction_idx on public.mev_receipts(mev_transaction_id);
create index if not exists mev_transactions_device_idx on public.mev_transactions(device_id);
create index if not exists mev_receipts_unprinted_idx on public.mev_receipts(restaurant_id, created_at) where printed_at is null;

insert into public.mev_devices (restaurant_id, device_key, environment, status, certificate_status, metadata)
select r.id, 'simplepos-simulator', 'simulator', 'active', 'active', jsonb_build_object('simulated', true, 'transport', 'supabase-edge')
from public.restaurants r
where not exists (
  select 1 from public.mev_devices d where d.restaurant_id=r.id and d.device_key='simplepos-simulator'
);

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
  sim_device uuid;
begin
  normalized_status := case
    when new.status = 'accepted' then 'accepted'
    when new.status in ('retryable','timeout','network_error','pending','sending') then 'retryable'
    when new.status = 'rejected' then 'rejected'
    else 'failed'
  end;
  env := case lower(coalesce(new.environment,'simulator'))
    when 'production' then 'production'
    when 'confirmation' then 'certification'
    when 'certification' then 'certification'
    else 'simulator'
  end;

  select id into sim_device
  from public.mev_devices
  where restaurant_id=new.restaurant_id
    and ((env='simulator' and device_key='simplepos-simulator') or environment=env)
  order by case when device_key='simplepos-simulator' then 0 else 1 end, created_at
  limit 1;

  insert into public.mev_transactions (
    restaurant_id, invoice_id, device_id, environment, status, transaction_id, document_id,
    request_payload, response_payload, attempt_count,
    last_error_code, last_error_message, retry_after, sent_at, accepted_at, updated_at
  ) values (
    new.restaurant_id, new.invoice_id, sim_device, env, normalized_status, new.transaction_id,
    coalesce(new.document_id, new.response_payload->>'document_id'),
    coalesce(new.request_payload,'{}'::jsonb), coalesce(new.response_payload,'{}'::jsonb), 1,
    new.error_code, new.error_message,
    case when normalized_status='retryable' then coalesce(new.retry_after, now() + interval '1 minute') else null end,
    coalesce(new.sent_at,new.created_at),
    case when normalized_status='accepted' then coalesce(new.received_at,new.created_at,now()) else null end,
    now()
  )
  on conflict (invoice_id) do update set
    device_id = coalesce(excluded.device_id, public.mev_transactions.device_id),
    environment = excluded.environment,
    status = excluded.status,
    transaction_id = coalesce(excluded.transaction_id, public.mev_transactions.transaction_id),
    document_id = coalesce(excluded.document_id, public.mev_transactions.document_id),
    request_payload = excluded.request_payload,
    response_payload = excluded.response_payload,
    attempt_count = greatest(public.mev_transactions.attempt_count + 1, new.attempt_no),
    last_error_code = excluded.last_error_code,
    last_error_message = excluded.last_error_message,
    retry_after = excluded.retry_after,
    sent_at = excluded.sent_at,
    accepted_at = coalesce(excluded.accepted_at, public.mev_transactions.accepted_at),
    updated_at = now()
  returning id into tx_id;

  if new.qr_payload is not null or normalized_status='accepted' then
    insert into public.mev_receipts (
      restaurant_id, invoice_id, mev_transaction_id, document_type,
      fiscal_document_id, qr_payload, receipt_payload, is_simulated
    ) values (
      new.restaurant_id, new.invoice_id, tx_id, 'closing_receipt',
      coalesce(new.document_id,new.response_payload->>'document_id',new.transaction_id),
      new.qr_payload,
      coalesce(new.response_payload->'receipt','{}'::jsonb),
      env <> 'production'
    )
    on conflict (invoice_id, document_type) do update set
      mev_transaction_id=excluded.mev_transaction_id,
      fiscal_document_id=excluded.fiscal_document_id,
      qr_payload=excluded.qr_payload,
      receipt_payload=excluded.receipt_payload,
      is_simulated=excluded.is_simulated;
  end if;

  update public.invoices
  set status = case normalized_status
    when 'accepted' then 'accepted'
    when 'retryable' then 'retryable'
    when 'rejected' then 'rejected'
    else 'failed'
  end,
  mev_transaction_id = coalesce(new.transaction_id, mev_transaction_id),
  mev_response = coalesce(new.response_payload, mev_response)
  where id=new.invoice_id;

  return new;
end;
$$;

revoke all on function public.mirror_mev_attempt_to_runtime() from public, anon, authenticated;

drop trigger if exists trg_mirror_mev_attempt_runtime on public.mev_attempts;
create trigger trg_mirror_mev_attempt_runtime
after insert on public.mev_attempts
for each row execute function public.mirror_mev_attempt_to_runtime();
