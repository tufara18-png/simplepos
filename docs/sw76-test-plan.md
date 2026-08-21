# Plan de test terrain de la fondation SW-76

## Avant de tester

- forcer le rechargement de la PWA après le déploiement du cache `resto360-v18`;
- utiliser le mode démo pour l’interface ou une imprimante reçu configurée pour le flux réel;
- garder le mode MEV en simulation.

## Scénarios

### Addition originale

1. Ouvrir une table et ajouter des articles.
2. Imprimer l’addition.
3. Vérifier `FACTURE ORIGINALE`, la référence locale `SP-...` et la mention non certifiée.
4. Vérifier l’apparition du document dans **Gestion → Historique → Documents fiscaux locaux**.

### Addition révisée

1. Après l’addition originale, ajouter ou retirer un article.
2. Réimprimer.
3. Vérifier `FACTURE RÉVISÉE` et une nouvelle référence locale.

### Reproduction client

1. Fermer une facture de test.
2. Ouvrir l’historique.
3. Cliquer **Reproduction client**.
4. Vérifier qu’elle est distincte du duplicata marchand et qu’elle apparaît dans le registre.

### Erreur d’impression

1. Configurer volontairement une mauvaise adresse d’imprimante.
2. Essayer d’imprimer.
3. Vérifier que le paiement reste bloqué selon le flux existant et qu’un événement `print_error` est écrit.

### File locale

1. Ouvrir l’application en ligne pour amorcer les données.
2. Couper la connexion Supabase ou Internet tout en gardant le bridge local disponible.
3. Imprimer un document.
4. Vérifier l’indicateur de document en attente dans **Gestion → Archives fiscales locales**.
5. Rétablir la connexion et cliquer **Synchroniser le registre**.

### Archives

1. Exporter le JSON.
2. Vérifier le manifeste, l’algorithme SHA-256 et les tables exportées.
3. Exporter le CSV et l’ouvrir dans un tableur.

## Résultat attendu

Aucun écran ne doit présenter la référence locale, le hash ou le QR simulé comme un identifiant officiel de Revenu Québec. Le transport officiel reste `blocked_sw73`.
