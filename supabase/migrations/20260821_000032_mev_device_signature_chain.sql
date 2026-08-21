-- SW-73's signature chain requires each transaction's signa.preced to equal the immediately
-- preceding transaction's own signa.actu, on that same device -- confirmed live 2026-08-21
-- (a wrong preced would desynchronize the device from what Revenu Québec has on file). Nothing
-- in the existing schema persisted this across app restarts.

alter table public.mev_devices
  add column if not exists last_transaction_signature text;

comment on column public.mev_devices.last_transaction_signature is
  'Base64 IEEE P1363 signature (signa.actu) of the last transaction this device successfully transmitted. Feeds the next transaction''s signa.preced. Only advances on a confirmed accept -- never on a retryable/rejected attempt.';
