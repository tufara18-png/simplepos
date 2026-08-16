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

## Limite connue restante

Le sous-total lui-même reste calculé côté client à partir des prix du menu, puis simplement contrôlé par rapport aux taux de taxes en base (voir ci-dessus). Une reconstruction complète du sous-total à partir de `order_items` côté serveur (dans une fonction RPC `finalize_invoice` unique) fermerait aussi ce dernier vecteur, mais touche à la logique de paiement partagé/divisé et n'a pas été faite dans cette passe pour ne pas déstabiliser ce flux sans tests d'intégration réels contre le projet Supabase de production.

## Ce que le SW-76 (guide public) exige concrètement

Le SW-76 (*Renseignements généraux sur l'adaptation des SEV*, version 2025-06) est public, contrairement au SW-73 (le guide technique détaillé avec le format JSON exact) qui est réservé aux partenaires inscrits. Points qui touchent directement le code de SimplePOS :

- un « serveur distant » (notre `mev-gateway`) ne peut ni créer, ni modifier, ni supprimer de transactions, seulement les acheminer au MEV-WEB, notre architecture actuelle respecte déjà cette contrainte;
- numéro de transaction unique par jour civil (notre numérotation par restaurant, jamais réutilisée, satisfait déjà cette exigence);
- toute transaction qui en modifie une autre (note de crédit, correction, reçu de fermeture après addition) doit inclure une référence à la transaction d'origine, **pas encore implémenté**, aucune colonne de ce type dans `mev_attempts`/`invoices` actuellement;
- signature numérique unique par requête, bloqué sur les certificats Revenu Québec (déjà su);
- documents obligatoires : reçu de fermeture, note de crédit, reproduction. Facultatifs : soumission, estimation, addition. **Deux documents obligatoires manquent complètement** : le **duplicata** (copie interne marquée « *** COPIE DU COMMERÇANT *** » / « NE PAS REMETTRE AU CLIENT ») et le **rapport de l'utilisateur** (document envoyé à Revenu Québec à chaque affichage/impression, avec sommaire annuel des ventes);
- conservation 6 ans incluant toutes les modifications/annulations, pas seulement l'état final, c'est exactement ce que verrouille la chaîne fiscale en ajout seul;
- journalisation exigée des modifications post-facture, des messages d'erreur MEV-WEB avec leur code de retour, et de l'activation/désactivation du mode hors ligne. `mev_attempts` journalise déjà les réponses MEV, pas encore les deux autres.

## Confirmations de fournisseurs déjà certifiés

Le SW-73 étant verrouillé, ces détails viennent de fournisseurs POS déjà certifiés WEB-SRM qui documentent publiquement leur implémentation (Lightspeed Restaurant K-Series en premier lieu). À prendre comme un signal fort, pas une garantie, puisque ce n'est pas Revenu Québec qui les publie.

- **Mode de paiement obligatoire manquant** : Revenu Québec exige que tout SEV supporte « **Parti sans payer** » (client qui quitte sans payer). SimplePOS n'a que carte/comptant/autre.
- **Flux d'annulation de commande obligatoire** : le SEV doit permettre de vider une commande et imprimer un reçu documentant l'annulation avec la liste des articles annulés. On a l'annulation d'un article, pas celle d'une commande complète avec reçu dédié.
- **Vocabulaire confirmé** sur les documents (déjà appliqué sur l'addition et le reçu de fermeture) : addition non modifiée = « Facture originale », modifiée après impression = « Facture révisée » avec compteur (« Remplace 2 factures », pas encore fait), reçu de fermeture = « Paiement reçu », réimpression client = « Reproduction », copie interne = « *** COPIE DU COMMERÇANT *** » / « NE PAS REMETTRE AU CLIENT », document produit hors ligne = « Problème de communication » (pas encore fait).
- **Règles de validation des noms** : noms d'articles et de comptes employés limités à un alphabet précis (lettres accentuées françaises, chiffres, ponctuation courante), 2 à 128 caractères, pas d'espace en début/fin, pas d'emoji. Pas encore validé côté SimplePOS.
- **Articles à 0 $ obligatoirement visibles** sur le reçu client, impossible de masquer un item gratuit/comp.
- Pénalités en cas de non-conformité : jusqu'à 25 000 $ d'amende, combinable avec jusqu'à 6 mois de prison dans certains cas.

## Dépendances officielles encore nécessaires

Ces éléments ne doivent pas être inventés dans le code. Ils seront branchés dans `mev-gateway` lorsque Revenu Québec les fournira :

1. inscription comme partenaire et enregistrement du produit SimplePOS;
2. guide de démarche de certification SW-79 et documents techniques applicables;
3. caractéristiques/cas d'essai attribués au produit;
4. paramètres exacts du protocole MEV-WEB;
5. formats officiels des requêtes/réponses et documents fiscaux;
6. format officiel du QR;
7. règles exactes de signature, numérotation, corrections, annulations, notes de crédit et retransmission;
8. environnement de certification;
9. code d'autorisation et certificat numérique du serveur distant lorsque requis;
10. exécution et réussite des cas d'essai puis démonstration à Revenu Québec.

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
