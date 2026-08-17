-- Follow-up to the SW-76 document ledger.
-- Migration 25 introduced item_shared; keep it while adding the public-guide
-- events used by the new local document and archive layer.

alter table public.fiscal_events
  drop constraint if exists fiscal_events_event_type_check;

alter table public.fiscal_events
  add constraint fiscal_events_event_type_check check (event_type in (
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

-- pgcrypto is installed in the extensions schema on Supabase. The function uses
-- digest() to preserve the exact printed content, so include that schema in its
-- fixed SECURITY DEFINER search path.
alter function public.record_fiscal_document(
  uuid, uuid, text, text, uuid, uuid, uuid, text, boolean, text, jsonb
) set search_path = public, private, extensions;
