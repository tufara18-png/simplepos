# SimplePOS PWA — prototype fonctionnel

Prototype volontairement minimal, basé sur la maquette existante.

## Ce qui fonctionne
- Tables libres/ouvertes, fermeture automatique quand le solde est payé.
- Ajout/suppression d'articles.
- État cuisine NEW/SENT et impression cuisine.
- Addition.
- Paiement complet ou sélection d'articles.
- Division du solde par 2/3/4 ou X, avec répartition exacte des cents.
- TPS/TVQ calculées séparément (valeurs par défaut Québec : 5 % et 9,975 %).
- Facture locale + historique persistant dans localStorage.
- PWA/service worker pour les assets en HTTPS/localhost.
- MEV en mode MOCK, volontairement isolé derrière `/api/mev/mock`.
- Impression : boîte système (AirPrint) OU bridge ESC/POS TCP 9100.

## Démarrer
```bash
npm start
```
Ouvrir http://localhost:8787

## Test rapide
```bash
npm test
```

## Bridge ESC/POS
Le même `server.mjs` expose `POST /print` et envoie les octets ESC/POS par TCP vers `ip:9100`.
Dans Réglages > Impression :
- Mode = Bridge ESC/POS
- URL du bridge = http://IP_DU_PC:8787
- IP cuisine / reçu = IP de l'imprimante

Pour une PWA hébergée en HTTPS, un bridge HTTP local peut être bloqué par le navigateur. En production iPad, options propres : wrapper Capacitor avec TCP natif, ou agent local sécurisé.

## MEV-WEB
Le connecteur réel n'est PAS implémenté sans SW-73/SW-77 et environnement/certificats officiels. La classe logique est remplacée par un mock pour que tout le reste du POS soit testable maintenant.

## Inspiration technique
Le bridge reste volontairement sans dépendance. Pour une version plus avancée, projets à regarder : `receiptline/receiptio`, `lsongdev/node-escpos`, et des plugins Capacitor TCP/thermal-printer. Aucun code tiers n'est copié ici.
