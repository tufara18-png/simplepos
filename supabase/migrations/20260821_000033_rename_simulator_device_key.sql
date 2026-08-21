-- The app was renamed from SimplePOS to Resto360; mev-runtime.js now looks up and creates the
-- simulator device under device_key='resto360-simulator', but the migration that seeded it
-- (20260816_000008) used the old 'simplepos-simulator' key and mirror_mev_attempt_to_runtime()
-- still matches on that literal. Left as-is, ensureSimulatorDevice() would never find the old
-- row, insert a duplicate one under the new key, and the trigger's tie-break would keep
-- preferring the orphaned old row. Rename in place instead of inserting a duplicate.

update public.mev_devices
set device_key = 'resto360-simulator'
where device_key = 'simplepos-simulator';

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
    and ((env='simulator' and device_key='resto360-simulator') or environment=env)
  order by case when device_key='resto360-simulator' then 0 else 1 end, created_at
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
