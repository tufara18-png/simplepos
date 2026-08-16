# SimplePOS — préparation certification MEV-WEB

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

## Limites connues restantes

**Sous-total des paiements par montant (division).** Le contrôle d'intégrité ci-dessus couvre le chemin normal (paiement d'articles sélectionnés, qui insère des `invoice_items`). Le chemin « division par montant » n'insère aucune ligne de facture, donc rien n'y valide le sous-total côté serveur. Fermer ça demanderait une RPC `finalize_invoice` unique qui recalcule tout depuis `order_items`, ce qui touche la logique de paiement partagé et n'a pas été fait sans tests d'intégration réels contre le projet Supabase de production.

**Noms des comptes employés.** La validation d'alphabet est appliquée aux articles du menu, pas encore aux noms d'utilisateurs (SimplePOS n'a pas d'écran de gestion du personnel pour l'instant).

**Annulation de commande complète.** L'annulation d'un article est journalisée, mais il n'existe pas encore de flux « vider la commande » avec reçu d'annulation dédié.

## Ce que le SW-76 (guide public) exige concrètement

Le SW-76 (*Renseignements généraux sur l'adaptation des SEV*, version 2025-06) est public, contrairement au SW-73 (le guide technique détaillé avec le format JSON exact) qui est réservé aux partenaires inscrits. Points qui touchent directement le code de SimplePOS :

- un « serveur distant » (notre `mev-gateway`) ne peut ni créer, ni modifier, ni supprimer de transactions, seulement les acheminer au MEV-WEB, notre architecture actuelle respecte déjà cette contrainte;
- numéro de transaction unique par jour civil (notre numérotation par restaurant, jamais réutilisée, satisfait déjà cette exigence);
- toute transaction qui en modifie une autre (note de crédit, correction, reçu de fermeture après addition) doit inclure une référence à la transaction d'origine : colonne `invoices.replaces_invoice_id` en place, reste à la remplir quand les notes de crédit existeront;
- signature numérique unique par requête, bloqué sur les certificats Revenu Québec (déjà su);
- documents obligatoires : reçu de fermeture, note de crédit, reproduction. Facultatifs : soumission, estimation, addition. Le **duplicata** et le **rapport de l'utilisateur** sont maintenant produits; la **note de crédit** (remboursement) reste à faire;
- conservation 6 ans incluant toutes les modifications/annulations, pas seulement l'état final, c'est exactement ce que verrouille la chaîne fiscale en ajout seul;
- journalisation des modifications post-facture, des messages d'erreur MEV-WEB avec leur code de retour, et de l'activation/désactivation du mode hors ligne : couverte par `fiscal_events`.

## Confirmations de fournisseurs déjà certifiés

Le SW-73 étant verrouillé, ces détails viennent de fournisseurs POS déjà certifiés WEB-SRM qui documentent publiquement leur implémentation (Lightspeed Restaurant K-Series en premier lieu). À prendre comme un signal fort, pas une garantie, puisque ce n'est pas Revenu Québec qui les publie.

- **Mode de paiement « Parti sans payer »** exigé de tout SEV : implémenté.
- **Flux d'annulation de commande obligatoire** : le SEV doit permettre de vider une commande et imprimer un reçu documentant l'annulation avec la liste des articles annulés. On a l'annulation d'un article (journalisée), pas encore celle d'une commande complète avec reçu dédié.
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

## Dépendances officielles encore nécessaires

Ces éléments ne doivent pas être inventés dans le code. Ils seront branchés dans `mev-gateway` lorsque Revenu Québec les fournira :

1. inscription comme partenaire et enregistrement du produit SimplePOS;
2. guide de démarche de certification SW-79 et documents techniques applicables;
3. caractéristiques/cas d'essai attribués au produit;
4. paramètres exacts du protocole MEV-WEB;
5. formats officiels des requêtes/réponses et documents fiscaux;
6. format officiel du QR;
7. règles exactes de signature (probablement ECDSA, voir observations ci-dessus, à confirmer), numérotation, corrections, annulations, notes de crédit et retransmission;
8. environnement de certification;
9. code d'autorisation et certificat numérique du serveur distant lorsque requis;
10. exécution et réussite des cas d'essai puis démonstration à Revenu Québec.

## Ce qui reste strictement bloqué sur le SW-73

Tout le reste est préparable sans être partenaire. Ces quatre points ne le sont pas, parce qu'inventer un format ici serait pire que de ne rien faire :

1. **structure JSON exacte** des requêtes de type certificats / utilisateur / transaction / document, et les en-têtes attendus;
2. **codes de retour** du MEV-WEB et leur signification (lesquels signifient « à retransmettre en lot » plutôt que « rejeté »);
3. **algorithme et encodage exacts de la signature numérique** (les indices pointent vers ECDSA, à confirmer) et le format du CSR d'enrôlement;
4. **contenu exact du QR** au-delà du fait qu'il pointe vers `qr.mev-web.ca`.

Quand ces quatre points seront connus, le travail restant se limite à écrire `RevenuQuebecTransport` derrière `mev-gateway` : le POS, la file de retransmission, le journal, les documents et les mentions n'auront pas à changer.

## Passage en production

Le frontend ne doit pas être modifié pour passer du simulateur au transport officiel. Le point stable est :

```text
POS → mev-gateway → Transport
                    ├─ simulator (actuel)
                    └─ revenu-quebec (à brancher avec les spécifications officielles)
```

Le mode production doit rester verrouillé tant que le transport officiel n'est pas configuré et validé.

## Sources

- [Certification des SEV conçus pour communiquer avec le MEV-WEB](https://www.revenuquebec.ca/fr/partenaires/concepteurs-de-produits/domaines-dactivite/concepteurs-facturation-obligatoire-solution-infonuagique/certification-des-sev-concus-pour-communiquer-avec-le-mev-web/)
- [Concepteurs – Restauration](https://www.revenuquebec.ca/fr/partenaires/concepteurs-de-produits/domaines-dactivite/concepteurs-facturation-obligatoire-solution-infonuagique/concepteurs-solution-infonuagique-restauration/)
- [Équipement requis – Facturation obligatoire](https://www.revenuquebec.ca/fr/entreprises/mesures-particulieres/facturation-obligatoire/equipement-requis-facturation-obligatoire/)
- [Renseignements généraux sur l'adaptation des SEV (SW-76, PDF public)](https://www.revenuquebec.ca/documents/fr/partenaires/infonuagique/restauration/SW-76%282025-06%29.pdf)
- [About WEB-SRM (Quebec) – Lightspeed Restaurant (K-Series)](https://k-series-support.lightspeedhq.com/hc/en-us/articles/19678535506331-About-WEB-SRM-Quebec)
- [Québec's Electronic Invoicing and Tax Reporting System – Fiscal Solutions](https://www.fiscal-requirements.com/news/4464)
- [QUÉBEC: What does WEB-SRM mean for operators? – JB Fiscal Consulting](https://jbfiscalconsulting.com/what-does-web-srm-means-for-operators/)
