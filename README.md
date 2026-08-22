# Resto360

Application de restaurant Android : tables → commande → cuisine → addition → paiement → MEV → reçu de fermeture.

## État actuel

La branche `main` est connectée au projet Supabase **Resto360** (`ca-central-1`).

Fonctions actives :
- authentification Supabase;
- restaurant, sections et tables persistés;
- plan de salle simple par sections;
- menu administrable (nom, prix, catégorie, station);
- articles NEW/SENT et tickets cuisine;
- imprimantes réseau ESC/POS TCP port 9100, impression directe depuis l'appli Android (`PrinterBridgePlugin`);
- paiement externe par carte : saisie du total final du terminal et calcul du pourboire;
- comptant avec montant reçu, pourboire et monnaie;
- sélection d'articles et division 2/3/4/X;
- impression de l'**addition avant paiement**; si elle échoue, l'écran de paiement ne s'ouvre pas;
- factures, paiements et historique dans Supabase;
- pipeline MEV simulé avec appareil, transactions, tentatives, statuts, retry et reçus;
- impression automatique du **reçu de fermeture** après acceptation MEV simulée; les reçus non imprimés restent dans une file et sont réessayés;
- bannière d'alerte si une transaction MEV ou un reçu attend une action;
- RLS par restaurant avec helper de membership dans un schéma privé;
- chaîne fiscale en ajout seul (aucune modification/suppression possible par le staff une fois une facture, un paiement ou une tentative MEV écrits) avec numérotation séquentielle des factures par restaurant;
- coordonnées de l'entreprise (nom légal, adresse, téléphone, numéros TPS/TVQ) configurables dans Réglages par le ou la propriétaire du compte, reprises sur l'addition et le reçu de fermeture;
- mode de paiement **Parti sans payer**, duplicata interne depuis l'historique, rapport de l'utilisateur (sommaire annuel des ventes) imprimable depuis Réglages;
- **transmission réelle au MEV-WEB de Revenu Québec** (mode `live`) : enrôlement du certificat depuis l'appareil (Keystore Android, ECDSA P-256), requêtes certificats/transaction/utilisateur signées et envoyées en mTLS, file hors ligne avec chaînage de signature — vérifié en direct contre l'environnement DEV de Revenu Québec (voir `docs/certification-readiness.md`); reste optionnel par restaurant via `app_settings.mev_mode` (`simulator` par défaut, `live`, `disabled`);
- gestion par place à table (pivots), activable ou non dans Réglages : bouton **Client suivant** dans le ticket, séparateurs par place dans la liste, addition par place, impression de toutes les additions d'un coup, sélection de qui paie;
- **article partagé** : une bouteille partagée entre plusieurs places est fractionnée au cent près (la somme des parts redonne toujours le montant exact), chaque personne paie sa part;
- **mode démo** (Réglages) : simule l'impression à l'écran pour tester tout le flux sans imprimante physique. À ne jamais activer pendant un vrai service;
- **montants de vente calculés côté serveur** : `finalize_invoice()` recalcule sous-total, taxes et total depuis la commande réelle; le POS ne peut plus dicter le montant enregistré;
- **note de crédit** (remboursement depuis l'historique) et **annulation de commande** avec reçu;
- **verrouillage après inactivité** (5 min) : redemande le mot de passe de l'utilisateur en cours avant de continuer, sans perdre la commande active ni la session Supabase sous-jacente;
- **distinction carte crédit/débit** au paiement (affecte le code MEV transmis, CRE ou DEB) — nécessite la migration `20260822_000034_card_type_credit_debit.sql`, pas encore appliquée en production;
- **note de crédit et rapport de l'utilisateur transmis pour de vrai au MEV-WEB** en mode `live`, pas seulement imprimés localement;
- **mode Formation** (Réglages) : transactions fictives pour s'exercer, réellement transmises au MEV-WEB (`modTrans FOR`) mais exclues du rapport de l'utilisateur, bannière permanente à l'écran tant qu'actif — nécessite la migration `20260822_000035_formation_mode.sql`.
- **accès multi-utilisateur** : le ou la propriétaire du compte peut donner accès à d'autres comptes déjà créés (Réglages → Personnel, rôle staff ou gérant) — nécessite la migration `20260822_000036_staff_accounts.sql`, pas encore appliquée en production.
- **fermeture de session à la fermeture de l'appli** (SW-78 FO-102) : la session vit en `sessionStorage`, pas `localStorage` — elle ne survit plus à une fermeture complète de l'appli, seulement à une mise en veille normale.
- **suppression des données de l'exploitant** (SW-78 FO-121/FO-124, Réglages → Supprimer mes données) : supprime le menu, les tables, les imprimantes, les réservations, les clients, les dépenses et l'accès du personnel; conserve toujours factures, paiements et données MEV-WEB — nécessite la migration `20260822_000037_delete_operator_data.sql`, pas encore appliquée en production.
- **avertissement avant échéance du certificat MEV-WEB** (SW-78 FO-127) : bandeau à l'écran 30 jours avant l'expiration du certificat de l'appareil.

## Démarrer

Ouvrir le dossier `android/` dans Android Studio, laisser Gradle synchroniser, puis lancer sur un appareil ou un émulateur. En ligne de commande :

```bash
cd android
./gradlew installDebug
```

Toute modification d'un fichier web (`app-v2.js`, `mev-live.js`, etc.) demande de resynchroniser les assets avant de rebuilder :

```bash
npx cap copy android
```

## Imprimantes

Dans **Réglages → Imprimantes réseau** :

```text
Cuisine : 192.168.1.50
Reçu    : 192.168.1.51
Port    : 9100
```

Le bouton **Payer** imprime d'abord l'addition sur l'imprimante reçu. L'échec d'impression bloque le passage au paiement.

Après un paiement accepté par le pipeline MEV, `mev-runtime.js` imprime automatiquement le reçu de fermeture. Un échec d'impression ne supprime jamais le reçu : `mev_receipts.printed_at` reste vide et le runtime réessaie.

## Paiement externe / pourboire

Carte :

```text
Montant facture : 57,49 $
Total terminal  : 67,84 $
Pourboire       : 10,35 $
```

Le terminal reste indépendant du POS. Le client choisit son pourboire sur le terminal; Resto360 enregistre séparément le montant de la facture, le total terminal et le pourboire.

## MEV-WEB

Deux transports derrière la même interface (`submitMev()`), choisis par restaurant via `app_settings.mev_mode` :

```text
invoice
  ↓
submitMev()
  ↓
mev_mode ?
  ├─ simulator (défaut) → mev-runtime.js / mev-simulator
  ├─ live               → mev-live.js (réel, mTLS, signature native)
  └─ disabled           → aucune transmission
  ↓
mev_attempts
  ↓ trigger DB
mev_transactions
  ↓
mev_receipts
  ↓
impression / retry
```

Tables principales :
- `mev_devices`
- `mev_partner_config`
- `mev_transactions`
- `mev_attempts`
- `mev_receipts`

États gérés : `pending`, `sending`, `accepted`, `retryable`, `rejected`, `failed`.

Le simulateur supporte `accepted`, `rejected`, `retryable` et `timeout`. Son QR contient explicitement `SIMULATED-NOT-FISCAL` et ne prétend pas reproduire le format Revenu Québec.

Le mode `live` (`mev-live.js`) construit le vrai JSON SW-73 (`mev-protocol.js`), le signe avec la clé ECDSA P-256 non exportable de l'appareil (Android Keystore) et l'envoie en mTLS via `MevProtocolPlugin`. Vérifié en direct contre l'environnement DEV de Revenu Québec (certificat émis, reçu de fermeture, pourboire, annulation, note de crédit, lot hors ligne — voir `docs/certification-readiness.md` et `docs/mev-architecture.md` pour le détail et les angles morts restants). N'a pas encore été essayé contre `ESSAI`/`PROD`, et Resto360 n'est pas encore un SEV certifié : `live` ne doit être activé que dans le cadre de la démarche de certification elle-même, jamais en service réel avant l'accusé de réception de Revenu Québec.

## Runtime MEV

`mev-runtime.js` (mode `simulator`) :
- récupère les factures orphelines après une panne réseau;
- retransmet les transactions `pending/retryable`;
- applique un délai avant retry;
- limite le nombre de tentatives;
- garde les erreurs et réponses;
- imprime les reçus acceptés non encore imprimés;
- affiche l'état MEV dans Réglages et une alerte visible lorsqu'une intervention est nécessaire.

`mev-offline-queue.js` (mode `live`) : file IndexedDB de transactions déjà signées, chaînées entre elles (`signa.preced`) même hors ligne, envoyées en un lot `transLot` à la reconnexion. Non testée contre une vraie coupure réseau sur appareil Android — voir `docs/certification-readiness.md`.

## Tests

```bash
npm test
node --check config.js
node --check native-mev-bridge.js
node --check app-v2.js
node --check local-first.js
node --check local-cache-fallback.js
node --check business-suite.js
node --check fixed-expenses.js
node --check payment-hook.js
node --check mev-protocol.js
node --check mev-live.js
node --check mev-offline-queue.js
node --check mev-runtime.js
node --check mev-enrollment.js
node --check ui-shell.js
node --check pivots.js
node --check demo-mode.js
node --check sw76-readiness.js
node --check onboarding-wizard.js
node --check session-lock.js
```

GitHub Actions exécute les mêmes vérifications sur `main`.

## Limite réglementaire

Resto360 n'est **pas encore un SEV certifié**, même si le transport MEV-WEB réel (mode `live`) a été vérifié en direct contre le DEV de Revenu Québec. Ce qui manque n'est plus principalement technique : les cas d'essai SW-77 et la déclaration SW-78 doivent encore être exécutés et transmis officiellement via le dossier partenaire, puis suivis de la démonstration à Revenu Québec. Voir `docs/certification-readiness.md` pour le détail complet, y compris les angles morts techniques encore non vérifiés en direct.
