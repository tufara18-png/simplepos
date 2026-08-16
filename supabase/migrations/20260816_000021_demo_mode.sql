-- Lets an operator click through the entire flow (order, addition, payment, MEV
-- simulator, receipts, parti sans payer, duplicata, rapport de l'utilisateur)
-- without any physical printer. Purely a client-side display toggle: no fiscal
-- table, RLS policy, or trigger is affected.

alter table public.app_settings
  add column if not exists demo_mode boolean not null default false;
