# Resto360

PWA restaurant : tables → commande → cuisine → addition → paiement → MEV → reçu de fermeture.

## État actuel

La branche `main` est connectée au projet Supabase **Resto360** (`ca-central-1`).

Fonctions actives :
- authentification Supabase;
- restaurant, sections et tables persistés;
- plan de salle simple par sections;
- menu administrable (nom, prix, catégorie, station);
- articles NEW/SENT et tickets cuisine;
- imprimantes réseau ESC/POS TCP port 9100 via `server.mjs`;
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
- gestion par place à table (pivots), activable ou non dans Réglages : bouton **Client suivant** dans le ticket, séparateurs par place dans la liste, addition par place, impression de toutes les additions d'un coup, sélection de qui paie;
- **article partagé** : une bouteille partagée entre plusieurs places est fractionnée au cent près (la somme des parts redonne toujours le montant exact), chaque personne paie sa part;
- **mode démo** (Réglages) : simule l'impression à l'écran pour tester tout le flux sans imprimante physique. À ne jamais activer pendant un vrai service;
- **montants de vente calculés côté serveur** : `finalize_invoice()` recalcule sous-total, taxes et total depuis la commande réelle; le POS ne peut plus dicter le montant enregistré;
- **note de crédit** (remboursement depuis l'historique) et **annulation de commande** avec reçu.

## Démarrer

```bash
npm start
```

Puis ouvrir `http://localhost:8787`.

Le serveur Node sert la PWA et agit comme bridge d'impression local. Une PWA Safari pure ne peut pas ouvrir directement un socket TCP vers une imprimante ESC/POS.

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

Architecture actuelle :

```text
invoice
  ↓
MevEnvelopeFactory
  ↓
MevController
  ↓
SimulatorTransport
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
- `mev_transactions`
- `mev_attempts`
- `mev_receipts`

États gérés : `pending`, `sending`, `accepted`, `retryable`, `rejected`, `failed`.

Le simulateur supporte `accepted`, `rejected`, `retryable` et `timeout`. Le QR généré contient explicitement `SIMULATED-NOT-FISCAL` et ne prétend pas reproduire le format Revenu Québec.

Le mode production reste verrouillé. Pour rendre MEV réellement fiscal, il faudra remplacer `SimulatorTransport` par le transport officiel à partir des documents techniques, identifiants et certificats fournis par Revenu Québec. Aucun format privé ou certificat n'est inventé dans le dépôt.

## Runtime MEV

`mev-runtime.js` :
- récupère les factures orphelines après une panne réseau;
- retransmet les transactions `pending/retryable`;
- applique un délai avant retry;
- limite le nombre de tentatives;
- garde les erreurs et réponses;
- imprime les reçus acceptés non encore imprimés;
- affiche l'état MEV dans Réglages et une alerte visible lorsqu'une intervention est nécessaire.

## Tests

```bash
npm test
node --check app-v2.js
node --check local-first.js
node --check local-cache-fallback.js
node --check bridge-ui.js
node --check business-suite.js
node --check fixed-expenses.js
node --check payment-hook.js
node --check mev-runtime.js
node --check ui-shell.js
node --check pivots.js
node --check demo-mode.js
node --check server.mjs
```

GitHub Actions exécute les mêmes vérifications sur `main`.

## Limite réglementaire

Resto360 n'est **pas encore un SEV certifié**. Le simulateur et ses reçus servent à valider le workflow applicatif. La certification réelle dépend des spécifications privées et de l'environnement de certification MEV-WEB fournis par Revenu Québec.
