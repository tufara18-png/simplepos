# État des migrations de production — 17 août 2026

Les migrations suivantes ont été appliquées au projet Supabase SimplePOS (`okzniurqfhzhsnhifchj`) :

- `left_without_paying_and_user_reports`;
- `demo_mode`;
- `shared_order_items`;
- `seat_tracking_setting`;
- `sw76_fiscal_documents`;
- `sw76_event_types_and_crypto_path`.

Cette remise à niveau corrige aussi l’écart entre le dépôt et la base qui provoquait des erreurs sur `demo_mode`, `seat_tracking_enabled` et `share_group_id`.

Validation effectuée dans une transaction annulée :

- l’appel `record_fiscal_document` est idempotent;
- deux appels portant le même identifiant local retournent le même document et le même numéro;
- l’empreinte SHA-256 contient 64 caractères;
- le statut demeure `blocked_sw73` tant que le transport officiel n’est pas configuré;
- le type d’événement `item_shared` est conservé avec les nouveaux événements SW-76.
