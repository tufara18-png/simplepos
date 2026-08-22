# Plan de test terrain de la fondation SW-76

## Avant de tester

- resynchroniser les assets Android après toute modification d'un fichier web (`npm run android:sync`) puis reconstruire l'app (`cd android && ./gradlew installDebug`);
- utiliser le mode démo (Réglages) pour l'interface ou une imprimante reçu configurée pour le flux réel;
- garder `app_settings.mev_mode` en `simulator` pour ces scénarios — ne passer en `live` que dans le cadre de la démarche de certification elle-même (voir `certification-readiness.md`), jamais pour du test terrain courant.

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
2. Couper la connexion Internet (l'impression réseau vers l'imprimante ESC/POS reste locale, indépendante de Supabase).
3. Imprimer un document.
4. Vérifier l’indicateur de document en attente dans **Gestion → Archives fiscales locales**.
5. Rétablir la connexion et cliquer **Synchroniser le registre**.

### Archives

1. Exporter le JSON.
2. Vérifier le manifeste, l’algorithme SHA-256 et les tables exportées.
3. Exporter le CSV et l’ouvrir dans un tableur.

## Résultat attendu

En mode `simulator`, aucun écran ne doit présenter la référence locale, le hash ou le QR simulé comme un identifiant officiel de Revenu Québec.

Ce plan ne couvre pas le mode `live` (transmission réelle) : cette exhaustivité-là reste à construire séparément, avec un harnais qui simule les réponses réelles de Revenu Québec plutôt que de risquer des envois non nécessaires en DEV.
