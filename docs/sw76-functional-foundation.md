# Fondation fonctionnelle SW-76

Cette couche met en œuvre uniquement les éléments qui peuvent être construits à partir du guide public SW-76 sans inventer les formats privés du SW-73.

## Fonctionnalités actives

- registre immuable `fiscal_documents` pour chaque document imprimé reconnu;
- numéro interne unique par restaurant et par jour civil du Québec;
- référence locale unique par appareil, visible sur le document;
- empreinte SHA-256 du contenu exact envoyé à l'imprimante;
- file locale idempotente lorsque le registre Supabase est temporairement inaccessible;
- reprise automatique de la synchronisation;
- journalisation des erreurs d'impression et des exports;
- reproduction destinée à la clientèle, distincte du duplicata marchand;
- affichage du registre dans **Gestion → Historique**;
- export JSON complet avec manifeste et empreinte SHA-256;
- export CSV des documents fiscaux locaux;
- écran de préparation SW-76 dans **Gestion**.

## Documents détectés et conservés

- addition originale;
- addition révisée;
- reçu de fermeture;
- note de crédit;
- reproduction destinée au client;
- duplicata marchand;
- annulation de commande;
- rapport de l'utilisateur.

Les tickets cuisine sont exclus du registre fiscal.

## Statut du numéro imprimé

La mention `RÉFÉRENCE LOCALE SP-...` est un identifiant Resto360 unique et traçable. Ce n'est ni le numéro retourné par Revenu Québec ni une preuve de certification.

**Corrigé** : le document imprimé portait toujours la mention « TRANSPORT MEV OFFICIEL NON CONFIGURÉ » (`sw76-readiness.js`, `injectLocalReference`), même en mode `live` avec une transaction réellement transmise. `injectLocalReference` accepte maintenant le statut réel (`certified`/`environment`), transmis par `app-v2.js`/`mev-runtime.js` via `window.__resto360SetPrintContext` juste avant l'impression — voir `certification-readiness.md` pour le détail et la limite restante sur le chemin de réimpression automatique.

## État des dépendances SW-73

Le SW-73 et sa famille (SW-73.A à SW-73.D) sont maintenant en main, et le protocole réel a été vérifié en direct contre le DEV de Revenu Québec — voir `mev-architecture.md` et `certification-readiness.md` pour le détail. Ce qui reste réellement non résolu :

- le contenu officiel du QR (seul le domaine `qr.mev-web.ca` est confirmé, par une source non officielle);
- la mise en page exacte attendue par SW-73.B, document par document (la mécanique — mentions, numérotation, révisions — est en place, mais n'a pas été confrontée modèle par modèle);
- la liste exhaustive des codes de retour et règles de retransmission (seuls ceux rencontrés en pratique sont confirmés);
- l'exécution officielle des cas d'essai SW-77 et la déclaration SW-78 dans le dossier partenaire, qui est une démarche administrative et non un développement.

Le mode `live` reste un choix explicite par restaurant (`app_settings.mev_mode`), pas encore le défaut, tant que ces points et les cas d'essai officiels ne sont pas complétés.

## Validation minimale

1. Imprimer une addition en mode démo ou avec une imprimante configurée.
2. Vérifier la présence d'une référence locale et de la mention non certifiée.
3. Ouvrir **Gestion → Historique → Documents fiscaux locaux**.
4. Imprimer **Reproduction client** depuis une facture.
5. Ouvrir **Gestion → Archives fiscales locales**, puis exporter JSON et CSV.
6. Couper temporairement la connexion, produire un document, rétablir la connexion et utiliser **Synchroniser le registre**.
