# Resto360 — préparation certification MEV-WEB

Le SW-73 (guide technique, format JSON, algorithme de signature) est maintenant en main et le protocole réel a été vérifié en direct contre l'environnement DEV de Revenu Québec (voir `mev-architecture.md` et l'en-tête de `mev-protocol.js` pour le détail exact de ce qui a été confirmé). Ce document distingue donc maintenant trois états : ce qui est implémenté, ce qui est implémenté mais pas encore vérifié en direct, et ce qui reste réellement bloqué (démarche officielle de certification, pas technique).

## Déjà implémenté

- séparation POS / couche MEV;
- `mev-gateway` comme point d'entrée stable;
- transport simulateur remplaçable;
- appareil MEV (`mev_devices`);
- journal de transactions (`mev_transactions`);
- journal de tentatives (`mev_attempts`);
- statuts `pending`, `sending`, `accepted`, `retryable`, `rejected`, `failed`;
- retransmission automatique avec délai et limite de tentatives;
- reçu de fermeture (`mev_receipts`);
- suivi de l'impression et réimpression automatique;
- addition obligatoire avant l'écran de paiement dans le workflow actuel;
- carte externe, comptant, pourboire, paiement partiel et division;
- RLS par restaurant;
- simulateur explicitement non fiscal;
- chaîne fiscale (`invoices`, `invoice_items`, `payments`, `mev_attempts`, `mev_transactions`, `mev_receipts`) verrouillée en ajout seul: aucun rôle staff ne peut modifier ou supprimer une ligne une fois écrite, les transitions d'état passent par des fonctions RPC qui revérifient l'appartenance au restaurant;
- numérotation séquentielle sans trou des factures par restaurant (`invoices.invoice_number`);
- rejet en base des factures dont la TPS/TVQ/total déclarés ne correspondent pas au sous-total et aux taux configurés;
- coordonnées de l'entreprise (nom légal, adresse, téléphone, numéros d'inscription TPS/TVQ) saisissables dans Réglages par le ou la propriétaire du compte, et reprises sur l'addition, le reçu de fermeture et la réimpression;
- mentions obligatoires alignées sur le vocabulaire confirmé (« FACTURE ORIGINALE », « PAIEMENT REÇU »).

- journal fiscal en ajout seul (`fiscal_events`) : erreurs MEV avec code de retour, activation/désactivation du mode hors ligne, ajouts/retraits d'articles après impression de l'addition, additions révisées;
- référence de transaction (`invoices.replaces_invoice_id`) prête pour les notes de crédit et corrections;
- compteur de révisions d'addition (`orders.addition_print_count`) : « FACTURE ORIGINALE » au premier tirage, « FACTURE RÉVISÉE / Remplace N factures » ensuite;
- marquage « PROBLÈME DE COMMUNICATION » sur les documents produits hors ligne (`invoices.produced_offline`);
- contrôle d'intégrité des lignes de facture en base : `line_total` doit égaler quantité × prix unitaire, et le prix unitaire facturé doit correspondre à celui de l'article réellement commandé;
- validation des noms d'articles contre l'alphabet accepté par le MEV-WEB (2–128 caractères, pas d'apostrophe courbe, de ligature œ, de crochets ni d'emoji), couverte par des tests unitaires.

- **montants calculés par le serveur** : `finalize_invoice()` est le seul moyen de créer une vente. Elle dérive sous-total, TPS, TVQ et total de `order_items` et des taux configurés, et refuse un encaissement supérieur au solde réel de la commande. Les droits `INSERT` directs sur `invoices`, `invoice_items` et `payments` ont été retirés aux rôles clients, donc le montant enregistré ne peut plus être dicté par le poste;
- **note de crédit** (`create_credit_note()`) : facture négative référençant l'originale via `replaces_invoice_id`, une seule par facture, impossible sur une note de crédit;
- **annulation de commande** (`void_order()`) : annule les articles impayés restants, journalise le motif et la liste des articles dans `fiscal_events`, imprime un reçu « COMMANDE ANNULÉE ».

- **protocole MEV-WEB réel** (`mev-protocol.js`, `mev-live.js`) : requêtes `certificats`, `transaction` et `utilisateur` construites selon le SW-73/SW-73.C/SW-77, signées ECDSA P-256 par le Keystore Android natif (clé non exportable), envoyées en mTLS via `MevProtocolPlugin` — vérifié en direct contre le DEV de Revenu Québec (reçu de fermeture simple, avec pourboire, annulation en cours, note de crédit, lot hors ligne à deux transactions) : voir `mev-architecture.md` pour le détail exact et ce qui reste non vérifié (`docAdr` non standard, `clint`, versements, `ESTM`/`SOUM`/`ADDI`);
- **enrôlement du certificat** (`mev-enrollment.js`) : génère la paire de clés sur l'appareil, construit le CSR (ordre RDN CN/O/SN/OU/GN/L/S/C, corps base64 sur une seule ligne — deux détails non évidents à la lecture du guide, découverts en confrontant au DEV réel) et envoie la requête `certificats` directement depuis l'appareil Android, pas via une fonction Supabase (`mev-certificats` reste dans le dépôt comme référence « mode serveur », explicitement marquée à ne pas utiliser pour de vraies requêtes : elle perd l'en-tête IDVERSI en route vers Revenu Québec pour une raison encore inexpliquée);
- **requête « utilisateur »** (SW-77 §3.3) : envoyée à la création du compte propriétaire depuis l'assistant de démarrage; jamais vérifiée en direct contre le DEV (forme lue directement des exemples du SW-77, pas testée), contrairement à `certificats`/`transaction`;
- **file hors ligne pour le mode réel** (`mev-offline-queue.js`) : signe chaque transaction à la création, chaîne `signa.preced` localement même hors ligne, envoie un lot `transLot` à la reconnexion — jamais testée sur un appareil Android en coupure réseau réelle;
- **trois modes MEV par restaurant** (`app_settings.mev_mode`) : `simulator` (défaut, aucune transmission réelle), `live` (transmission réelle à l'environnement configuré dans `mev_partner_config`), `disabled` (aucune transmission, aucun document fiscal).

## Limites connues restantes

**Sous-déclaration par paiement partiel.** Un encaissement peut être inférieur au solde, c'est un paiement partiel légitime. La commande reste alors ouverte avec son solde impayé, elle ne disparaît pas. Pour l'escamoter il faut ensuite annuler le reste, ce qui écrit une entrée `order_voided` dans `fiscal_events` avec le motif et les articles. C'est donc traçable plutôt que bloqué, ce qui est le compromis normal : un vrai départ sans paiement doit rester possible.

**Noms des comptes employés.** La validation d'alphabet est appliquée aux articles du menu, pas encore aux noms d'utilisateurs (Resto360 n'a pas d'écran de gestion du personnel pour l'instant).

**Remboursement partiel.** `create_credit_note()` rembourse la facture au complet. Un remboursement partiel (un seul plat sur une facture de quatre) demanderait de choisir les lignes à créditer.

**Mention imprimée en mode `live` — corrigé.** `sw76-readiness.js` (`injectLocalReference`) ajoutait systématiquement « DOCUMENT NON CERTIFIÉ — TRANSPORT MEV OFFICIEL NON CONFIGURÉ » sur tout document fiscal imprimé, sans regarder si la transaction avait réellement été transmise à Revenu Québec en mode `live`. `printReceipt` (`app-v2.js`) et `printReceiptRow` (`mev-runtime.js`, le chemin de réimpression automatique) passent maintenant le statut réel (`fiscal.certified`/`mev_receipts.is_simulated`) via `window.__resto360SetPrintContext`, et le document imprimé dit « TRANSMIS AU MEV-WEB, ENVIRONNEMENT {DEV/ESSAI/PROD} » plutôt que « non configuré » une fois qu'une transmission réelle a eu lieu. Limite restante : le chemin `mev-runtime.js` se fie à `mev_receipts.is_simulated`, qui classe aussi les envois réels en environnement DEV/ESSAI comme « simulés » (voir `mirror_mev_attempt_to_runtime()`) — sous-estime donc encore une vraie transmission DEV sur ce chemin précis, jamais l'inverse.

## Ce que le SW-76 (guide public) exige concrètement

Le SW-76 (*Renseignements généraux sur l'adaptation des SEV*, version 2025-06) est public, contrairement au SW-73 (le guide technique détaillé avec le format JSON exact) qui est réservé aux partenaires inscrits. Points qui touchent directement le code de Resto360 :

- un « serveur distant » (notre `mev-gateway`) ne peut ni créer, ni modifier, ni supprimer de transactions, seulement les acheminer au MEV-WEB, notre architecture actuelle respecte déjà cette contrainte;
- numéro de transaction unique par jour civil (notre numérotation par restaurant, jamais réutilisée, satisfait déjà cette exigence);
- toute transaction qui en modifie une autre (note de crédit, correction, reçu de fermeture après addition) doit inclure une référence à la transaction d'origine : colonne `invoices.replaces_invoice_id` en place, reste à la remplir quand les notes de crédit existeront;
- signature numérique unique par requête : implémentée et vérifiée en direct (ECDSA P-256, voir plus bas);
- documents obligatoires : reçu de fermeture, note de crédit, reproduction. Facultatifs : soumission, estimation, addition. Le **duplicata**, le **rapport de l'utilisateur** et la **note de crédit** sont maintenant produits; reste la **reproduction** destinée à la clientèle;
- conservation 6 ans incluant toutes les modifications/annulations, pas seulement l'état final, c'est exactement ce que verrouille la chaîne fiscale en ajout seul;
- journalisation des modifications post-facture, des messages d'erreur MEV-WEB avec leur code de retour, et de l'activation/désactivation du mode hors ligne : couverte par `fiscal_events`.

## Confirmations de fournisseurs déjà certifiés

Ces deux sections datent d'avant l'obtention du SW-73 et restent comme trace de la recherche faite à l'aveugle; le SW-73 réel prime désormais partout où il contredit ces indices. Ces détails viennent de fournisseurs POS déjà certifiés WEB-SRM qui documentent publiquement leur implémentation (Lightspeed Restaurant K-Series en premier lieu). À prendre comme un signal fort, pas une garantie, puisque ce n'est pas Revenu Québec qui les publie.

- **Mode de paiement « Parti sans payer »** exigé de tout SEV : implémenté.
- **Flux d'annulation de commande obligatoire** : implémenté (`void_order()` plus reçu « COMMANDE ANNULÉE » listant les articles annulés).
- **Vocabulaire confirmé** sur les documents : addition non modifiée = « Facture originale », modifiée après impression = « Facture révisée » avec compteur (« Remplace N factures »), reçu de fermeture = « Paiement reçu », copie interne = « *** COPIE DU COMMERÇANT *** » / « NE PAS REMETTRE AU CLIENT », document produit hors ligne = « Problème de communication ». Tous appliqués. Reste « Reproduction » pour la réimpression destinée à la clientèle (distincte du duplicata interne).
- **Règles de validation des noms** : appliquées aux articles du menu, couvertes par tests unitaires. Pas encore aux comptes employés (pas d'écran de gestion du personnel).
- **Articles à 0 $ obligatoirement visibles** sur le reçu client : rien ne les filtre, donc déjà conforme.
- Pénalités en cas de non-conformité : jusqu'à 25 000 $ d'amende, combinable avec jusqu'à 6 mois de prison dans certains cas.

## Observations d'un SEV concurrent déjà certifié (à confirmer, pas une source officielle)

Ces points viennent de chaînes de caractères trouvées dans le binaire d'un SEV concurrent déjà certifié WEB-SRM (Metribook POS, fichier .ipa fourni par l'utilisateur), pas d'une documentation officielle. À traiter comme des indices à revérifier via le SW-73 une fois partenaire, pas comme une spécification fiable :

- domaines réels observés en production : `api.rq-fo.ca`, `certificats.api.rq-fo.ca/enrolement` (enrôlement du certificat), `qr.mev-web.ca` (base du lien contenu dans le QR);
- environnement de confirmation/certification identifié par le préfixe `cnfr.` sur les mêmes domaines (`cnfr.api.rq-fo.ca`, `certificats.cnfr.api.rq-fo.ca/enrolement`, `cnfr.qr.mev-web.ca`);
- le certificat doit être de type **ECDSA** (chaîne « Vous devez utiliser un certificat ECDSA » trouvée dans le binaire);
- ce concepteur dédie des écrans distincts à : la configuration établissement/code d'autorisation, la demande et la gestion du certificat, la gestion des comptes utilisateurs MEV, l'affichage des messages d'erreur, le rapport de l'utilisateur (« RUT » en interne chez eux), et même un écran de suivi des cas d'essai de certification un par un;
- types de documents observés au-delà de ceux confirmés par le SW-76 : facture, **contrat**, estimation, soumission — « contrat » n'apparaît pas dans le SW-76 public, à vérifier si ça s'applique à la restauration ou si c'est spécifique au transport rémunéré de personnes (l'autre secteur couvert par le même concepteur).

## Mode démo

Réglages → Mode démo : simule l'impression à l'écran (le contenu du reçu s'affiche dans une fenêtre au lieu d'être envoyé à une imprimante réseau) pour permettre de dérouler tout le flux (commande → addition → paiement → MEV simulé → reçu → parti sans payer → duplicata → rapport de l'utilisateur) sans aucun matériel physique. Purement un interrupteur d'affichage côté client, `app_settings.demo_mode`, aucune table ni politique RLS fiscale touchée. À ne jamais activer pendant un vrai service : une bannière reste affichée tant que le mode est actif pour éviter toute confusion.

## Dépendances officielles : où on en est

1. inscription comme partenaire et enregistrement du produit Resto360 — **fait** (`mev_partner_config`, numéro de dossier, IDPARTN/IDSEV/IDVERSI réels);
2. guide de démarche de certification SW-79 et documents techniques applicables — **reçus**;
3. caractéristiques/cas d'essai attribués au produit — reçus (SW-77); **pas encore exécutés officiellement** via le dossier partenaire Revenu Québec;
4. paramètres exacts du protocole MEV-WEB — **connus et vérifiés en direct** pour `certificats`/`transaction`/`utilisateur` (voir `mev-architecture.md`);
5. formats officiels des requêtes/réponses et documents fiscaux — **vérifiés en direct** pour reçu de fermeture (simple, pourboire, annulation, note de crédit) et lot hors ligne; non vérifiés : `docAdr` non standard, `clint`, versements, `ESTM`/`SOUM`/`ADDI`;
6. format officiel du QR — **toujours inconnu**, seul le domaine (`qr.mev-web.ca`) est confirmé par une source tierce non officielle;
7. règles exactes de signature — **confirmées** : ECDSA P-256, deux concaténations différentes pour l'en-tête (`SIGNATRANSM`, Tableau 22) et le corps (`signa.actu`), chaînage `signa.preced`, CSR à corps base64 non wrappé avec un ordre RDN spécifique (CN/O/SN/OU/GN/L/S/C);
8. environnement de certification — **DEV confirmé et utilisé**, `ESSAI`/`PROD` pas encore essayés;
9. code d'autorisation et certificat numérique du serveur distant — sans objet : Resto360 enrôle et signe depuis l'appareil Android lui-même, pas via un serveur distant;
10. exécution et réussite des cas d'essai puis démonstration à Revenu Québec — **reste à faire**, c'est la seule étape qui n'est pas technique : elle passe par le dossier partenaire Revenu Québec (voir « Historique des cas d'essai » dans le portail), pas par du code.

## Ce qui restait strictement bloqué sur le SW-73 — maintenant débloqué

Les quatre inconnues qui bloquaient tout progrès technique sont résolues :

1. **structure JSON exacte** des requêtes certificats / utilisateur / transaction / document, et les en-têtes attendus — connue (SW-73/SW-73.C), implémentée dans `mev-protocol.js`, vérifiée en direct pour certificats/transaction, non vérifiée en direct pour utilisateur;
2. **codes de retour** du MEV-WEB et leur signification — partiellement connus, seulement ceux rencontrés en pratique jusqu'ici (succès, rejets liés au CSR/en-têtes pendant la mise au point) sont confirmés; la liste complète « à retransmettre en lot » vs « rejeté » n'a pas été testée exhaustivement;
3. **algorithme et encodage exacts de la signature numérique** — confirmé ECDSA P-256, format IEEE P1363 (pas DER/ASN.1), CSR vérifié en direct;
4. **contenu exact du QR** — toujours inconnu, seule la base du lien (`qr.mev-web.ca`) est confirmée par une source tierce non officielle (voir « Observations d'un SEV concurrent » ci-dessus).

Ce qui reste donc à faire n'est plus « écrire le transport une fois les specs connues » (c'est fait, dans `mev-live.js`) mais : élargir la couverture vérifiée (types de transactions non testés, format du QR, codes de retour exhaustifs), tester la file hors ligne sur un vrai appareil, corriger la mention imprimée incorrecte en mode `live` (voir « Limites connues restantes »), puis compléter la démarche officielle SW-77/SW-78/SW-79 dans le dossier partenaire.

## Passage en production

Le transport réel existe déjà et n'a pas demandé de modifier le frontend au-delà de `submitMev()` :

```text
POS → submitMev() → Transport (app_settings.mev_mode)
                    ├─ simulator (défaut)
                    ├─ live (mev-live.js, réel, mTLS + signature native)
                    └─ disabled
```

`live` a été vérifié contre le DEV de Revenu Québec, pas contre `ESSAI` ni `PROD`. Passer un restaurant en `live` avant d'avoir terminé les cas d'essai officiels (SW-77) et reçu la certification transmettrait de vraies transactions à Revenu Québec sans que Resto360 soit un SEV certifié — à ne faire que dans le cadre de la démarche de certification elle-même, jamais en service réel avant l'accusé de réception de Revenu Québec.

## Sources

- [Certification des SEV conçus pour communiquer avec le MEV-WEB](https://www.revenuquebec.ca/fr/partenaires/concepteurs-de-produits/domaines-dactivite/concepteurs-facturation-obligatoire-solution-infonuagique/certification-des-sev-concus-pour-communiquer-avec-le-mev-web/)
- [Concepteurs – Restauration](https://www.revenuquebec.ca/fr/partenaires/concepteurs-de-produits/domaines-dactivite/concepteurs-facturation-obligatoire-solution-infonuagique/concepteurs-solution-infonuagique-restauration/)
- [Équipement requis – Facturation obligatoire](https://www.revenuquebec.ca/fr/entreprises/mesures-particulieres/facturation-obligatoire/equipement-requis-facturation-obligatoire/)
- [Renseignements généraux sur l'adaptation des SEV (SW-76, PDF public)](https://www.revenuquebec.ca/documents/fr/partenaires/infonuagique/restauration/SW-76%282025-06%29.pdf)
- [About WEB-SRM (Quebec) – Lightspeed Restaurant (K-Series)](https://k-series-support.lightspeedhq.com/hc/en-us/articles/19678535506331-About-WEB-SRM-Quebec)
- [Québec's Electronic Invoicing and Tax Reporting System – Fiscal Solutions](https://www.fiscal-requirements.com/news/4464)
- [QUÉBEC: What does WEB-SRM mean for operators? – JB Fiscal Consulting](https://jbfiscalconsulting.com/what-does-web-srm-means-for-operators/)
