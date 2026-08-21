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

La mention `RÉFÉRENCE LOCALE SP-...` est un identifiant Resto360 unique et traçable. Ce n'est ni le numéro retourné par Revenu Québec ni une preuve de certification. Le document indique explicitement que le transport MEV officiel n'est pas configuré.

## Éléments volontairement non inventés

Le mode production demeure verrouillé tant que les documents partenaires ne fournissent pas :

- les structures JSON et en-têtes exacts;
- les certificats, la CSR et la gestion des clés privées;
- l'algorithme et l'encodage exacts de signature;
- les codes de retour et règles de retransmission;
- le contenu officiel du QR;
- les modèles finaux du SW-73.B.

## Validation minimale

1. Imprimer une addition en mode démo ou avec une imprimante configurée.
2. Vérifier la présence d'une référence locale et de la mention non certifiée.
3. Ouvrir **Gestion → Historique → Documents fiscaux locaux**.
4. Imprimer **Reproduction client** depuis une facture.
5. Ouvrir **Gestion → Archives fiscales locales**, puis exporter JSON et CSV.
6. Couper temporairement la connexion, produire un document, rétablir la connexion et utiliser **Synchroniser le registre**.
