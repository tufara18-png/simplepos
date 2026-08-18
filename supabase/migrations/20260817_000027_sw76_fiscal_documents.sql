-- SW-76 groundwork that is independent from the private SW-73 wire format.
--
-- This migration does NOT invent a Revenu Quebec request, signature or QR format.
-- It creates an immutable internal ledger for every fiscal/customer document
-- produced by SimplePOS, gives each document a unique number per civil day,
-- preserves references, content and hashes, and makes retries idempotent.

create table if not exists public.fiscal_document_counters (
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  civil_date date not null,
  next_number bigint not null default 1 check (next_number >= 1),
  primary key (restaurant_id, civil_date)
);

alter table public.fiscal_document_counters enable row level security;
revoke all on public.fiscal_document_counters from public, anon, authenticated;

create table if not exists public.fiscal_documents (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  local_document_id uuid not null,
  local_reference text not null,
  civil_date date not null,
  transaction_number bigint not null check (transaction_number >= 1),
  document_type text not null check (document_type in (
    'addition_original',
    'addition_revised',
    'closing_receipt',
    'credit_note',
    'customer_reproduction',
    'merchant_duplicate',
    'order_cancellation',
    'user_report'
  )),
  request_type text not null check (request_type in ('transaction','document')),
  invoice_id uuid references public.invoices(id) on delete set null,
  order_id uuid references public.orders(id) on delete set null,
  replaces_document_id uuid references public.fiscal_documents(id) on delete set null,
  support text not null default 'paper' check (support in ('paper','electronic','screen')),
  produced_offline boolean not null default false,
  official_status text not null default 'blocked_sw73' check (official_status in (
    'blocked_sw73','queued_offline','ready_for_gateway','sent','accepted','retryable','rejected','failed'
  )),
  content_text text not null,
  content_sha256 text not null,
  payload jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (restaurant_id, local_document_id),
  unique (restaurant_id, local_reference),
  unique (restaurant_id, civil_date, transaction_number)
);

comment on table public.fiscal_documents is
  'Immutable local ledger of documents produced by SimplePOS. Official MEV-WEB fields remain blocked until SW-73 is available.';
comment on column public.fiscal_documents.transaction_number is
  'SimplePOS internal number unique per restaurant and Quebec civil day. It is not the number returned by Revenu Quebec.';
comment on column public.fiscal_documents.local_reference is
  'Device-local idempotency and paper trace reference, explicitly non-official.';

create index if not exists fiscal_documents_restaurant_created_idx
  on public.fiscal_documents (restaurant_id, created_at desc);
create index if not exists fiscal_documents_invoice_idx
  on public.fiscal_documents (invoice_id) where invoice_id is not null;
create index if not exists fiscal_documents_order_idx
  on public.fiscal_documents (order_id) where order_id is not null;
create index if not exists fiscal_documents_type_idx
  on public.fiscal_documents (restaurant_id, document_type, created_at desc);

alter table public.fiscal_documents enable row level security;
drop policy if exists "fiscal documents select" on public.fiscal_documents;
create policy "fiscal documents select"
  on public.fiscal_documents for select to authenticated
  using (private.is_restaurant_member(restaurant_id));

grant select on public.fiscal_documents to authenticated;
revoke insert, update, delete on public.fiscal_documents from public, anon, authenticated;

-- Add the public-guide events we can record now without knowing SW-73.
-- item_shared comes from migration 25 and must stay in the list: dropping it here
-- makes this file unreplayable as soon as one item has been shared, because the
-- new constraint would be violated by rows already in the journal.
alter table public.fiscal_events drop constraint if exists fiscal_events_event_type_check;
alter table public.fiscal_events add constraint fiscal_events_event_type_check check (event_type in (
  'item_added_after_invoice',
  'item_removed_after_invoice',
  'item_price_changed_after_invoice',
  'item_shared',
  'mev_error',
  'offline_mode_on',
  'offline_mode_off',
  'order_voided',
  'document_reprinted',
  'addition_revised',
  'print_error',
  'transmission_error',
  'customer_reproduction',
  'fiscal_archive_exported',
  'fiscal_document_recorded'
));

create or replace function public.record_fiscal_document(
  p_restaurant_id uuid,
  p_local_document_id uuid,
  p_local_reference text,
  p_document_type text,
  p_invoice_id uuid default null,
  p_order_id uuid default null,
  p_replaces_document_id uuid default null,
  p_support text default 'paper',
  p_produced_offline boolean default false,
  p_content_text text default '',
  p_payload jsonb default '{}'::jsonb
)
returns public.fiscal_documents
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_existing public.fiscal_documents;
  v_date date;
  v_number bigint;
  v_request_type text;
  v_row public.fiscal_documents;
begin
  if not private.is_restaurant_member(p_restaurant_id) then
    raise exception 'Document fiscal: acces refuse' using errcode = '42501';
  end if;

  if p_local_document_id is null or nullif(trim(p_local_reference), '') is null then
    raise exception 'Document fiscal: identifiant local manquant' using errcode = '23502';
  end if;

  if p_document_type not in (
    'addition_original','addition_revised','closing_receipt','credit_note',
    'customer_reproduction','merchant_duplicate','order_cancellation','user_report'
  ) then
    raise exception 'Document fiscal: type invalide (%)', p_document_type using errcode = '23514';
  end if;

  if p_support not in ('paper','electronic','screen') then
    raise exception 'Document fiscal: support invalide (%)', p_support using errcode = '23514';
  end if;

  select * into v_existing
  from public.fiscal_documents
  where restaurant_id = p_restaurant_id
    and local_document_id = p_local_document_id;
  if v_existing.id is not null then
    return v_existing;
  end if;

  if p_invoice_id is not null and not exists (
    select 1 from public.invoices
    where id = p_invoice_id and restaurant_id = p_restaurant_id
  ) then
    raise exception 'Document fiscal: facture hors restaurant' using errcode = '42501';
  end if;

  if p_order_id is not null and not exists (
    select 1 from public.orders
    where id = p_order_id and restaurant_id = p_restaurant_id
  ) then
    raise exception 'Document fiscal: commande hors restaurant' using errcode = '42501';
  end if;

  if p_replaces_document_id is not null and not exists (
    select 1 from public.fiscal_documents
    where id = p_replaces_document_id and restaurant_id = p_restaurant_id
  ) then
    raise exception 'Document fiscal: reference hors restaurant' using errcode = '42501';
  end if;

  v_date := (now() at time zone 'America/Toronto')::date;

  insert into public.fiscal_document_counters (restaurant_id, civil_date, next_number)
  values (p_restaurant_id, v_date, 2)
  on conflict (restaurant_id, civil_date)
  do update set next_number = public.fiscal_document_counters.next_number + 1
  returning next_number - 1 into v_number;

  v_request_type := case when p_document_type = 'user_report' then 'document' else 'transaction' end;

  insert into public.fiscal_documents (
    restaurant_id, local_document_id, local_reference, civil_date,
    transaction_number, document_type, request_type,
    invoice_id, order_id, replaces_document_id,
    support, produced_offline, official_status,
    content_text, content_sha256, payload, created_by
  ) values (
    p_restaurant_id, p_local_document_id, trim(p_local_reference), v_date,
    v_number, p_document_type, v_request_type,
    p_invoice_id, p_order_id, p_replaces_document_id,
    p_support, coalesce(p_produced_offline, false),
    case when p_produced_offline then 'queued_offline' else 'blocked_sw73' end,
    coalesce(p_content_text, ''),
    encode(digest(convert_to(coalesce(p_content_text, ''), 'UTF8'), 'sha256'), 'hex'),
    coalesce(p_payload, '{}'::jsonb), auth.uid()
  ) returning * into v_row;

  insert into public.fiscal_events (
    restaurant_id, event_type, invoice_id, order_id, payload, created_by
  ) values (
    p_restaurant_id, 'fiscal_document_recorded', p_invoice_id, p_order_id,
    jsonb_build_object(
      'fiscal_document_id', v_row.id,
      'document_type', p_document_type,
      'transaction_number', v_number,
      'local_reference', p_local_reference
    ), auth.uid()
  );

  return v_row;
exception
  when unique_violation then
    select * into v_existing
    from public.fiscal_documents
    where restaurant_id = p_restaurant_id
      and (local_document_id = p_local_document_id or local_reference = p_local_reference)
    order by created_at asc
    limit 1;
    if v_existing.id is not null then
      return v_existing;
    end if;
    raise;
end;
$$;

revoke all on function public.record_fiscal_document(
  uuid, uuid, text, text, uuid, uuid, uuid, text, boolean, text, jsonb
) from public, anon;
grant execute on function public.record_fiscal_document(
  uuid, uuid, text, text, uuid, uuid, uuid, text, boolean, text, jsonb
) to authenticated;
