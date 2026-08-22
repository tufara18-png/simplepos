# Cas d'essai MEV-WEB — SW-78 puis SW-77

Sources complètes dans `docs/rq-source/`. Ce document mappe chaque cas déclaré sur le dossier
partenaire de Resto360 (secteur Restaurant, modes d'opération **Serveur** et **SEV**) à l'état
réel du code, pour prioriser le travail restant.

**Ordre obligatoire** : le SW-78 dit explicitement de compléter ses cas *avant* de commencer ceux
du SW-77 — mêmes certificats et comptes pour les deux. Donc SW-78 d'abord.

## Décision prise : mode SEV seulement, mode Serveur retiré

Le dossier partenaire déclarait Resto360 pour **deux** modes d'opération : « Serveur » et « SEV ».
Le SW-77 teste chaque cas fonctionnel séparément sous les deux (numéros `0XX` = SEV, `5XX` =
Serveur). Le code (`mev-live.js`) n'implémente que le mode **SEV** : chaque appareil Android a sa
propre clé Keystore non exportable et signe/transmet directement — et ça restera comme ça.

Le mode Serveur (Cas 500) aurait exigé un composant serveur séparé avec sa propre clé
**exportable**, un vrai second système (garde de clé privée en environnement serveur, signature
centralisée, cycle de vie de certificat côté serveur) — hors de portée pour l'instant, d'autant
qu'une tentative précédente de faire signer/transmettre depuis une Edge Function Supabase
(`mev-certificats`, gardée dans le repo comme référence) s'est heurtée à un vrai bug confirmé :
le runtime Deno déforme l'en-tête IDVERSI en sortie, même en forçant HTTP/1.1.

**Décidé (2026-08-22)** : rester en mode SEV seul pour l'instant — une tablette/caisse par
restaurant pour l'instant. **Action restante côté utilisateur, pas côté code** : retirer le mode
« Serveur » de l'inscription du produit dans Mon dossier pour les partenaires, pour que
l'inscription corresponde à ce qui est réellement construit avant de commencer les cas d'essai.
Tous les cas `5XX`/Cas 500 ci-dessous sont donc **hors de portée** tant que ce choix ne change pas ;
si un jour plusieurs appareils actifs en même temps sont nécessaires, le mode Serveur s'ajoute en
parallèle du mode SEV existant sans réécrire ce qui est déjà fait (voir `mev-architecture.md`
sur la façon dont les transports sont déjà pluggables derrière `submitMev()`).

## SW-78 — cas complémentaires (FO-101 à FO-132)

Auto-déclaratif : chaque cas demande une procédure écrite + captures d'écran, parfois un ZIP de
données. Beaucoup sont conditionnels (« seulement si votre SEV permet... », sinon on l'indique
dans la déclaration plutôt que de construire la fonctionnalité).

| Cas | Objet | Statut |
|---|---|---|
| FO-101 | Identification utilisateur, fermeture de session manuelle | Couvert (connexion Supabase par utilisateur, `logout()`) |
| FO-102 | Fermer indirectement une session (fermeture de l'appli/de l'appareil) | **Gap encore ouvert** : la session survit indéfiniment dans `localStorage`. La corriger proprement demanderait de changer le mécanisme de stockage de session dans les 13 fichiers qui le lisent/l'écrivent directement (`resto360-session`) — pas fait ici pour éviter une migration risquée non testable sans appareil réel; à traiter en changeant le stockage vers `sessionStorage` (survit une mise en veille normale, se vide au vrai redémarrage du processus de l'appli) une fois vérifiable sur un appareil |
| FO-103 | Identifier l'utilisateur en mode Veille | **Fait** (`session-lock.js`) : verrouillage après 5 min d'inactivité, redemande le mot de passe de l'utilisateur en cours sans toucher à la commande active ni à la session Supabase sous-jacente |
| FO-104/105/106 | Transmission d'une facture produite hors ligne (à la fermeture de session, manuellement, sur demande + transactions en attente) | Partiel : `mev-offline-queue.js` existe mais jamais testé sur un vrai appareil ; pas de déclencheur manuel explicite « transmettre maintenant » distinct de la reconnexion automatique |
| FO-107 | Afficher les messages d'erreur du MEV-WEB | Probablement couvert : `interpretCodRetour`/`listErr` existent dans `mev-protocol.js`/`mev-live.js` — à vérifier que le message réel de Revenu Québec (pas juste un code interne) atteint l'écran |
| FO-108 | Créer des comptes utilisateurs (spécifique RBC : TPS/TVQ invalides ne bloque pas l'opération, contrairement au secteur TRP) | Partiel : `submitMevUserAccount` existe mais jamais vérifié en direct ; le comportement « continuer à opérer si TPS/TVQ invalide » n'est pas explicitement géré |
| FO-109 | Conserver et **supprimer** un certificat | **Fait** : bouton « Supprimer le certificat » (SUP) dans `mev-enrollment.js`, supprime aussi la clé locale Android Keystore. En le construisant, correction d'un vrai bug latent : le remplacement (REM) n'a jamais inclus `noSerie` (numéro de série du certificat à remplacer), obligatoire selon le Cas 500 — ajout de `parseCertificateSerialHex()` dans `mev-protocol.js` pour l'extraire du certificat stocké |
| FO-110 | Produire des rapports | Le rapport local existe (`generateUserReport`/`printUserReport`) mais n'est jamais transmis au MEV-WEB comme requête « document » (voir aussi Cas 103/603 plus bas) |
| FO-111 | Problème d'imprimante après transmission réussie | À vérifier : la transaction MEV ne doit jamais être perdue/dupliquée si l'impression échoue après coup — `mev_receipts.printed_at` existe déjà pour ce découplage, comportement à confirmer |
| FO-112/113 | Copie conforme invisible / erreurs lors de l'envoi de factures électroniques | **Sans objet** : conditionnel à « si votre SEV permet d'envoyer les factures électroniquement » — Resto360 ne le fait pas, se déclare simplement non applicable |
| FO-114 | Ajouter et retirer des items | Couvert (addition révisée, compteur de révisions) |
| FO-115 | Annuler une transaction | Couvert au niveau DB (`void_order`) mais pas encore transmis comme vraie transaction MEV annulée (typTrans SOB) — actuellement local seulement |
| FO-116 | Note de crédit relative à une facture | Idem : `create_credit_note()` existe mais n'est pas encore câblé à une vraie transmission MEV |
| FO-117 | Facture en mode Formation | **Gap**, lié à Cas 008/508 plus bas — aucun mode Formation MEV réel |
| FO-118 | Accéder aux données du SEV (cloisonnement entre exploitants) | Couvert par RLS par restaurant ; l'étape « entre employés » est sautable pour RBC sans « gérer plusieurs mandataires » (Resto360 n'a pas cette caractéristique) |
| FO-119 | Empêcher la suppression avant copie | À vérifier explicitement, sinon petit ajout de garde-fou |
| FO-120 | Copier les données de l'exploitant | Probablement déjà largement couvert par l'export JSON/CSV existant (`Gestion → Archives fiscales locales`) — reste à empaqueter en ZIP et confirmer la couverture exacte demandée (FO-105, FO-106, FO-117, FO-104, FO-108, FO-114, FO-115, FO-116) |
| FO-121 | Supprimer les données de l'exploitant | Conditionnel — à confirmer si une suppression de compte/données existe déjà ou doit être ajoutée |
| FO-122/123 | Copier/supprimer les données des employés | Sautable pour RBC sans « gérer plusieurs mandataires » — probablement sans objet pour Resto360 |
| FO-124 | Supprimer des données avec transactions hors ligne en attente | À construire si FO-121 l'est |
| FO-125 | Transmettre après une mise à jour du SEV | Devrait déjà fonctionner (la file hors ligne ne dépend pas de la version de l'appli), à vérifier explicitement |
| FO-126 | Récupérer les données après retrait des droits | À construire si applicable |
| FO-127 | Avertir avant l'échéance du certificat | **Gap** : aucun suivi de date d'expiration de certificat |
| FO-128 | Rapport de l'utilisateur à la fin d'un abonnement | Lié à FO-110 |
| FO-129 | Présence du fuseau horaire | Probablement couvert (`utc` obligatoire déjà confirmé en direct, commit a90f125) |
| FO-130 | Pourboires | Couvert |
| FO-131 | Gestion des redevances | **Sans objet** — le document le dit explicitement : secteur Transport rémunéré de personnes seulement |
| FO-132 | Taille maximale d'un lot (256 ko) | **Fait** : `mev-offline-queue.js` scinde maintenant un lot trop volumineux en groupes consécutifs (plus ancien en premier), envoyés un par un, en s'arrêtant au premier échec |

## SW-77 — cas numérotés (001–037, 103, 500–512, 999.999)

| Cas | Objet | Statut |
|---|---|---|
| 500 | Gérer les certificats numériques du **serveur** | **Bloqué** sur la décision mode Serveur ci-dessus |
| 001/501 | Gérer les certificats numériques du SEV | Fait et vérifié en direct (variante 501/Serveur bloquée pareil) |
| 570 | Valider les numéros de taxes | Lié à FO-108 |
| 002/502 | Gérer les comptes utilisateurs | Implémenté, jamais vérifié en direct |
| 003/503 | Reproduire une facture (reproduction/duplicata) | Couvert |
| 004/504 | Annuler une transaction | DB fait, transmission MEV réelle manquante (voir FO-115) |
| 005/505 | Corriger un reçu de fermeture | À vérifier |
| 006/506 | Produire une note de crédit | DB fait, transmission MEV réelle manquante (voir FO-116) |
| 007/507 | Parti sans payer | Couvert |
| 008/508 | Utiliser le mode Formation | **Gap**, lié à FO-117 |
| 009/509 | Factures en mode Hors ligne | Partiel, jamais testé sur appareil réel |
| 010/510 | Produire une addition | Couvert |
| 011/511 | Pourboire / frais de service | Couvert |
| 013/513 | Paiements par versements | **Gap** (`versActu`/`versAnt`/`sold` jamais construits) |
| 014/514, 015/515 | Estimation, soumission | **Gap** (typTrans ESTM/SOUM jamais construits) |
| 016/516 | Vente en commerce électronique | À vérifier (champ `commerElectr` existe dans le protocole) |
| 017/517, 032–036/532–536 | Secteur Transport rémunéré de personnes uniquement | **Sans objet** (Resto360 = Restaurant) |
| 018/518 | Item non visé par la loi | À vérifier |
| 019/519 | Répartir une facture (une addition → une facture par client) | Probablement déjà couvert par l'addition par place (pivots) — à confirmer que ça produit bien des factures séparées, pas juste des parts |
| 020/520 | Grouper des factures | **Gap** — aucun code pour fusionner deux additions/factures |
| 021/521 | Répartir un item | Couvert (partage d'item entre places) |
| 022/522 | Transférer un item (entre tables/additions) | **Gap** — aucun code pour déplacer un item vers une autre table |
| 024/524 | Modifier le numéro de table | À vérifier (changer la table d'une commande en cours) |
| 025/525 | Déterminer le montant dû | Couvert |
| 026/526 | Indiquer le numéro de table | Couvert |
| 027/527 | SEV d'arrière-boutique | Sans objet pour Resto360 |
| 029/529 | Afficher le prix unitaire | Couvert |
| 030/530 | Précisions pour un item (prix 0 $ ou absent) | **Gap** — pas de notion de « précision » distincte du nom d'article |
| 031/531 | Sous-secteur d'activité | Couvert (Restaurant, statique) |
| 037/537 | Transmettre une commande | À examiner (probablement lié à l'envoi cuisine, pas encore relié au MEV) |
| 103/603 | Rapport de l'utilisateur transmis au MEV-WEB (typDoc RUT) | **Gap** — actuellement impression locale seulement, aucune requête « document » construite (nouveau type de requête à ajouter dans `mev-protocol.js`/`mev-live.js`) |
| 105/605 | Déclaration pour un tiers habituel | Sans objet (tiers/TRP) |
| 999.999 | Cas de clôture | À examiner en dernier |

## Prochaine étape suggérée

1. ~~Trancher la question du mode Serveur~~ — fait, mode SEV seul. Reste une action utilisateur :
   retirer « Serveur » de l'inscription du produit dans Mon dossier pour les partenaires.
2. SW-78 (FO-1xx) : fait dans cette passe — FO-109 (suppression de certificat, + correction du
   bug REM sans `noSerie`), FO-132 (limite de taille de lot), FO-103 (verrouillage après
   inactivité). Encore ouverts : FO-102 (fermeture de session à la fermeture de l'appli — demande
   de changer le stockage de session dans 13 fichiers, à faire avec un appareil réel pour vérifier),
   FO-127 (avertir avant échéance du certificat), FO-107/108/110/111/120 à vérifier plutôt qu'à
   construire (voir tableau ci-dessus).
3. Puis fermer les gaps SW-77 confirmés : rapport utilisateur transmis en vrai (103/603), mode
   Formation (008/508), transférer un item (022/522), grouper des factures (020/520), précisions
   d'item (030/530), distinction carte crédit/débit, annulation et note de crédit réellement
   transmises au MEV (004/504, 006/506).
