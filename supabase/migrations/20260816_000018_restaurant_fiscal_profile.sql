-- Business identity fields required on every facture/note de credit per SW-76 (4.4):
-- legal/trade name, address, phone, GST and QST registration numbers. These are plain
-- identification data (not secrets), so no RLS change is needed: the existing
-- "restaurant owner read" policy already lets any member SELECT them for receipts, and
-- the existing "restaurant owner update" policy already restricts UPDATE to the owner.

alter table public.restaurants
  add column if not exists legal_name text,
  add column if not exists address text,
  add column if not exists city text,
  add column if not exists postal_code text,
  add column if not exists phone text,
  add column if not exists gst_number text,
  add column if not exists qst_number text;
