-- PWA/device capability groundwork that is independent from the private SW-73 wire format.
--
-- This migration stores only public metadata about a browser capability probe. It never
-- receives or stores a private key and it does not claim that the probe key is a MEV-WEB
-- certificate key. The official algorithm, CSR and certificate lifecycle remain blocked
-- until the partner documentation is available.

alter table public.mev_devices
  add column if not exists browser_device_id text,
  add column if not exists crypto_probe_public_key_spki text,
  add column if not exists crypto_probe_sha256 text,
  add column if not exists crypto_probe_algorithm text,
  add column if not exists crypto_probe_created_at timestamptz,
  add column if not exists storage_persistent boolean not null default false,
  add column if not exists capabilities jsonb not null default '{}'::jsonb,
  add column if not exists last_crypto_self_test_at timestamptz;

create unique index if not exists mev_devices_browser_device_idx
  on public.mev_devices (restaurant_id, browser_device_id)
  where browser_device_id is not null;

comment on column public.mev_devices.crypto_probe_public_key_spki is
  'Public key from a browser capability probe only. Not an official MEV-WEB certificate key.';
comment on column public.mev_devices.crypto_probe_sha256 is
  'SHA-256 fingerprint of the capability-probe public key.';
comment on column public.mev_devices.capabilities is
  'Observed browser, storage, cryptography and print-bridge capabilities. Never contains private key material.';

create or replace function public.register_pwa_device_capabilities(
  p_restaurant_id uuid,
  p_browser_device_id text,
  p_crypto_probe_public_key_spki text default null,
  p_crypto_probe_sha256 text default null,
  p_crypto_probe_algorithm text default null,
  p_storage_persistent boolean default false,
  p_capabilities jsonb default '{}'::jsonb,
  p_crypto_verified boolean default false
)
returns public.mev_devices
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_row public.mev_devices;
  v_device_key text;
begin
  if not private.is_restaurant_member(p_restaurant_id) then
    raise exception 'Appareil PWA: acces refuse' using errcode = '42501';
  end if;

  if nullif(trim(p_browser_device_id), '') is null or char_length(trim(p_browser_device_id)) > 160 then
    raise exception 'Appareil PWA: identifiant local invalide' using errcode = '23514';
  end if;

  if p_crypto_probe_sha256 is not null and p_crypto_probe_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'Appareil PWA: empreinte SHA-256 invalide' using errcode = '23514';
  end if;

  v_device_key := 'pwa:' || trim(p_browser_device_id);

  insert into public.mev_devices (
    restaurant_id,
    device_key,
    environment,
    status,
    certificate_status,
    browser_device_id,
    crypto_probe_public_key_spki,
    crypto_probe_sha256,
    crypto_probe_algorithm,
    crypto_probe_created_at,
    storage_persistent,
    capabilities,
    last_crypto_self_test_at,
    last_seen_at,
    metadata
  ) values (
    p_restaurant_id,
    v_device_key,
    'simulator',
    case when coalesce(p_crypto_verified, false) then 'pending' else 'unregistered' end,
    'missing',
    trim(p_browser_device_id),
    p_crypto_probe_public_key_spki,
    p_crypto_probe_sha256,
    p_crypto_probe_algorithm,
    case when p_crypto_probe_public_key_spki is not null then now() else null end,
    coalesce(p_storage_persistent, false),
    coalesce(p_capabilities, '{}'::jsonb),
    case when coalesce(p_crypto_verified, false) then now() else null end,
    now(),
    jsonb_build_object(
      'probe_only', true,
      'official_certificate_configured', false,
      'private_key_received_by_server', false
    )
  )
  on conflict (restaurant_id, device_key) do update set
    browser_device_id = excluded.browser_device_id,
    crypto_probe_public_key_spki = coalesce(excluded.crypto_probe_public_key_spki, public.mev_devices.crypto_probe_public_key_spki),
    crypto_probe_sha256 = coalesce(excluded.crypto_probe_sha256, public.mev_devices.crypto_probe_sha256),
    crypto_probe_algorithm = coalesce(excluded.crypto_probe_algorithm, public.mev_devices.crypto_probe_algorithm),
    crypto_probe_created_at = case
      when excluded.crypto_probe_public_key_spki is not null then coalesce(public.mev_devices.crypto_probe_created_at, now())
      else public.mev_devices.crypto_probe_created_at
    end,
    storage_persistent = excluded.storage_persistent,
    capabilities = excluded.capabilities,
    last_crypto_self_test_at = case
      when coalesce(p_crypto_verified, false) then now()
      else public.mev_devices.last_crypto_self_test_at
    end,
    last_seen_at = now(),
    updated_at = now(),
    status = case
      when public.mev_devices.status = 'active' then 'active'
      when coalesce(p_crypto_verified, false) then 'pending'
      else public.mev_devices.status
    end,
    metadata = coalesce(public.mev_devices.metadata, '{}'::jsonb) || jsonb_build_object(
      'probe_only', true,
      'official_certificate_configured', public.mev_devices.certificate_status = 'active',
      'private_key_received_by_server', false
    )
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.register_pwa_device_capabilities(
  uuid, text, text, text, text, boolean, jsonb, boolean
) from public, anon;
grant execute on function public.register_pwa_device_capabilities(
  uuid, text, text, text, text, boolean, jsonb, boolean
) to authenticated;
