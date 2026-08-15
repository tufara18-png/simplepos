# SimplePOS

PWA restaurant minimale : tables → commande → cuisine → paiement → facture.

## État actuel

La version `main` est branchée sur le projet Supabase **SimplePOS** (`ca-central-1`). Les données ne vivent plus seulement dans le navigateur.

Fonctions :
- authentification Supabase par courriel/mot de passe;
- création automatique du premier restaurant, de 8 tables et des pourboires 15/18/20 %;
- tables et commandes persistées en PostgreSQL;
- menu administrable dans Réglages (nom, prix, catégorie, station cuisine);
- articles NEW/SENT et tickets cuisine;
- IP imprimante cuisine + reçu enregistrées par restaurant;
- impression ESC/POS TCP sur port 9100 via `server.mjs`;
- sélection d'articles pour payer;
- division par 2/3/4/X;
- pourboire en % ou montant, configurable avant/après taxes;
- factures, paiements et historique persistés;
- journal `mev_attempts`;
- Edge Function `mev-simulator` produisant un cycle fiscal réaliste mais **non certifié**;
- RLS activé pour isoler les données par restaurant.

## Démarrer

```bash
npm start
```

Puis ouvrir `http://localhost:8787`.

Le premier utilisateur peut créer son compte depuis l'écran de connexion. Si la confirmation par courriel est activée dans Supabase Auth, confirmer le courriel avant la première connexion.

## Imprimantes

Dans Réglages, entrer seulement les IP LAN :

```text
Cuisine : 192.168.1.50
Reçu    : 192.168.1.51
Port    : 9100
```

Le navigateur ne peut pas ouvrir un socket TCP brut vers une imprimante. `server.mjs` sert donc de bridge local et envoie les octets ESC/POS sur le réseau du restaurant.

## MEV-WEB

Le flux de données est déjà structuré comme la future intégration :

```text
paiement
→ invoice pending_mev
→ appel service MEV
→ accepted / failed
→ transaction_id + réponse + payload QR
→ mev_attempts
→ reçu
```

Aujourd'hui, le service est `supabase/functions/mev-simulator`. Il est explicitement marqué `SIMULATOR` et `certified: false`. Le mode `live` reste verrouillé jusqu'à l'obtention des spécifications, certificats et paramètres officiels de Revenu Québec.

## Tests

```bash
npm test
node --check app.js
node --check server.mjs
```

Un workflow GitHub Actions `.github/workflows/check.yml` exécute ces contrôles sur `main`.
