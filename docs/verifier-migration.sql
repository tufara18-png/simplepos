-- Contrôle après application de docs/migration-complete-a-appliquer.sql.
-- Ne modifie rien, ne fait que lire. Tout doit afficher OK.
-- À coller dans le SQL Editor de Supabase.

with attendu(categorie, objet) as (values
  ('Fonction', 'finalize_invoice'),
  ('Fonction', 'create_credit_note'),
  ('Fonction', 'void_order'),
  ('Fonction', 'split_order_item'),
  ('Fonction', 'mev_transaction_mark_sending'),
  ('Fonction', 'mev_transaction_mark_exhausted'),
  ('Fonction', 'mev_receipt_mark_printed'),
  ('Fonction', 'mev_receipt_mark_print_failed'),
  ('Fonction', 'validate_invoice_item_integrity'),
  ('Fonction', 'validate_invoice_tax_consistency'),
  ('Fonction', 'assign_invoice_number')
),
fonctions as (
  select a.categorie, a.objet,
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                           where n.nspname='public' and p.proname=a.objet)
              then 'OK' else 'MANQUANT' end as etat
  from attendu a
),
tables_attendues(categorie, objet) as (values
  ('Table', 'fiscal_events'), ('Table', 'user_reports'), ('Table', 'invoice_counters')
),
tables_ as (
  select t.categorie, t.objet,
         case when exists (select 1 from pg_tables where schemaname='public' and tablename=t.objet)
              then 'OK' else 'MANQUANTE' end
  from tables_attendues t
),
colonnes_attendues(categorie, objet, tbl, col) as (values
  ('Colonne','invoices.invoice_number','invoices','invoice_number'),
  ('Colonne','invoices.replaces_invoice_id','invoices','replaces_invoice_id'),
  ('Colonne','invoices.produced_offline','invoices','produced_offline'),
  ('Colonne','orders.addition_print_count','orders','addition_print_count'),
  ('Colonne','order_items.seat_number','order_items','seat_number'),
  ('Colonne','order_items.share_group_id','order_items','share_group_id'),
  ('Colonne','payments.tendered_amount','payments','tendered_amount'),
  ('Colonne','payments.tip_source','payments','tip_source'),
  ('Colonne','restaurants.gst_number','restaurants','gst_number'),
  ('Colonne','app_settings.demo_mode','app_settings','demo_mode'),
  ('Colonne','app_settings.seat_tracking_enabled','app_settings','seat_tracking_enabled')
),
colonnes as (
  select c.categorie, c.objet,
         case when exists (select 1 from information_schema.columns
                           where table_schema='public' and table_name=c.tbl and column_name=c.col)
              then 'OK' else 'MANQUANTE' end
  from colonnes_attendues c
),
verrous as (
  -- La chaîne fiscale ne doit plus être modifiable par le rôle applicatif.
  select 'Verrou'::text, 'aucun UPDATE/DELETE sur '||t::text,
         case when has_table_privilege('authenticated', t, 'UPDATE')
                or has_table_privilege('authenticated', t, 'DELETE')
              then 'PROBLEME' else 'OK' end
  from unnest(array['public.invoices','public.invoice_items','public.payments',
                    'public.mev_attempts','public.fiscal_events','public.user_reports']) as t
),
lectures as (
  -- Mais l'application doit pouvoir les lire.
  select 'Lecture'::text, t::text,
         case when has_table_privilege('authenticated', t, 'SELECT') then 'OK' else 'PROBLEME' end
  from unnest(array['public.fiscal_events','public.user_reports','public.invoices']) as t
),
insertion as (
  -- Les ventes ne doivent plus pouvoir être créées directement.
  select 'Verrou'::text, 'aucun INSERT direct sur '||t::text,
         case when has_table_privilege('authenticated', t, 'INSERT') then 'PROBLEME' else 'OK' end
  from unnest(array['public.invoices','public.invoice_items','public.payments']) as t
)
select * from fonctions
union all select * from tables_
union all select * from colonnes
union all select * from verrous
union all select * from lectures
union all select * from insertion
order by 1, 2;
