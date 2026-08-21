-- Real MEV-WEB protocol fields, now that SW-73 (and annexes A/B/C/D) are available. Nothing
-- here talks to api.rq-fo.ca yet -- that still needs a real authorization code from Revenu
-- Québec, which is an administrative step, not a code one. This migration only gives the
-- schema a place to hold the real identifiers/artifacts once that code exists, instead of
-- inventing another simulator-shaped placeholder.

-- 1. The header's ENVIRN field uses "DEV" | "ESSAI" | "PROD" verbatim (SW-73 3.7.2.1). The
--    existing check constraints only knew SimplePOS's own simulator-era vocabulary. Add the
--    real values rather than rename the existing ones, so historical rows keep their meaning.
alter table public.mev_devices drop constraint if exists mev_devices_environment_check;
alter table public.mev_devices add constraint mev_devices_environment_check
  check (environment in ('simulator','certification','production','DEV','ESSAI','PROD'));

alter table public.mev_transactions drop constraint if exists mev_transactions_environment_check;
alter table public.mev_transactions add constraint mev_transactions_environment_check
  check (environment in ('simulator','certification','production','DEV','ESSAI','PROD'));

-- 2. Per-device certificate lifecycle (SW-73 3.7.5, 4.3.1.1). idApprl is issued by the
--    MEV-WEB on the device's first "certificats" request; the certificate and its thumbprint
--    only exist after that request succeeds. csr_pem is kept only long enough to be resent if
--    a request needs retrying -- it contains no private key material (AndroidKeyStore never
--    exports one), just the public key and subject fields.
alter table public.mev_devices
  add column if not exists id_apprl text,
  add column if not exists csr_pem text,
  add column if not exists certificate_pem text,
  add column if not exists certificate_thumbprint_sha1 text,
  add column if not exists certificate_issued_at timestamptz,
  add column if not exists certificate_expires_at timestamptz;

alter table public.mev_devices drop constraint if exists mev_devices_thumbprint_format_check;
alter table public.mev_devices add constraint mev_devices_thumbprint_format_check
  check (certificate_thumbprint_sha1 is null or certificate_thumbprint_sha1 ~ '^[0-9A-Fa-f]{40}$');

create unique index if not exists mev_devices_id_apprl_idx
  on public.mev_devices (id_apprl) where id_apprl is not null;

-- 3. Partner/SEV-registration constants (SW-73 4.2, SW-79 3.1). These are account-level, not
--    per-device: Revenu Québec issues one idSEV/idVersi/idPartn/codCertif per registered
--    product version, after partner enrolment in Mon dossier pour les partenaires. Nothing
--    populates this table automatically -- it exists so Réglages has somewhere to save what
--    the owner receives back from Revenu Québec instead of hardcoding it in JS.
create table if not exists public.mev_partner_config (
  restaurant_id uuid primary key references public.restaurants(id) on delete cascade,
  environment text not null default 'DEV' check (environment in ('DEV','ESSAI','PROD')),
  -- Numéro de dossier relatif à la facturation obligatoire (format AA9999).
  dossier_number text,
  -- Code d'autorisation reçu par la poste. Valid only ~90 minutes after Revenu Québec sends
  -- it (SW-73 4.3.1), so this is closer to a one-time enrolment token than a long-lived
  -- secret -- still locked down like one below.
  authorization_code text,
  id_partn text,
  id_sev text,
  id_versi text,
  cod_certif text,
  -- versi/versi_parn are assigned by SimplePOS itself (the designer), not by Revenu Québec.
  versi text,
  versi_parn text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.mev_partner_config enable row level security;

drop policy if exists "mev partner config owner only" on public.mev_partner_config;
create policy "mev partner config owner only" on public.mev_partner_config
  for all to authenticated
  using (exists (select 1 from public.restaurants r where r.id = mev_partner_config.restaurant_id and r.owner_id = (select auth.uid())))
  with check (exists (select 1 from public.restaurants r where r.id = mev_partner_config.restaurant_id and r.owner_id = (select auth.uid())));

-- 4. Raw request/response log for the three request types "transaction" doesn't already
--    cover (mev_attempts/mev_transactions/mev_receipts are transaction-only). Same audit-log
--    shape and access pattern as mev_attempts: members can write their own restaurant's rows
--    directly, nothing here is more sensitive than what mev_attempts already stores.
create table if not exists public.mev_partner_requests (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  device_id uuid references public.mev_devices(id) on delete set null,
  request_type text not null check (request_type in ('certificats','utilisateur','document')),
  environment text not null check (environment in ('DEV','ESSAI','PROD')),
  case_essai text,
  request_headers jsonb not null default '{}'::jsonb,
  request_body jsonb not null default '{}'::jsonb,
  response_status integer,
  response_body jsonb not null default '{}'::jsonb,
  error_code text,
  error_message text,
  created_at timestamptz not null default now()
);
alter table public.mev_partner_requests enable row level security;

drop policy if exists "mev partner requests member access" on public.mev_partner_requests;
create policy "mev partner requests member access" on public.mev_partner_requests
  for all to authenticated
  using (private.is_restaurant_member(restaurant_id))
  with check (private.is_restaurant_member(restaurant_id));

create index if not exists mev_partner_requests_restaurant_idx
  on public.mev_partner_requests (restaurant_id, request_type, created_at desc);
