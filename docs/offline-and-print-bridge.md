# Resto360 PWA — offline + impression sans App Store

## Architecture

```text
iPad / PWA
  ├─ Cache Storage : application
  ├─ IndexedDB : snapshots + outbox persistante
  ├─ Supabase : synchronisation quand Internet fonctionne
  └─ HTTPS LAN : Resto360 Print Bridge
                   ├─ TCP 9100 -> cuisine
                   └─ TCP 9100 -> reçu
```

La PWA reste installable depuis Safari avec **Ajouter à l’écran d’accueil**. Aucun App Store n’est requis.

## Mode hors ligne

`local-first.js` s’exécute avant le POS et intercepte les appels REST Supabase :

- les lectures réussies sont conservées dans IndexedDB;
- si Internet tombe, les lectures utilisent le dernier snapshot local;
- les POST/PATCH/DELETE sont ajoutés à une outbox durable;
- les nouveaux objets reçoivent un UUID côté client avant synchronisation;
- l’interface continue avec une réponse locale optimiste;
- au retour du réseau, l’outbox est rejouée dans l’ordre;
- les écritures possédant déjà leur UUID peuvent être rejouées de façon déterministe;
- `navigator.storage.persist()` est demandé quand le navigateur le permet.

Le mode hors ligne n’autorise pas à inventer les règles fiscales MEV-WEB. Les transactions fiscales restent dans la file jusqu’à ce que le transport officiel puisse appliquer les règles Revenu Québec.

## Print Bridge

Le bridge est `server.mjs`. Il peut tourner sur Windows, macOS, Linux, Raspberry Pi ou mini-PC du restaurant.

Démarrage simple :

```bash
npm start
```

Par défaut il écoute sur `8787`.

Endpoints :

```text
GET  /health
POST /print
```

Le bridge refuse par défaut les IP d’imprimantes qui ne sont pas privées/locales.

### Jeton

```bash
BRIDGE_TOKEN="une-valeur-longue" npm start
```

Entrer la même valeur dans **Réglages -> Bridge local** sur l’iPad.

Sans `BRIDGE_TOKEN`, n'importe quel appareil sur le réseau local du restaurant peut envoyer des commandes d'impression au bridge. Le serveur démarre quand même sans jeton (pratique pour un test rapide) mais affiche un avertissement dans sa console. Toujours définir `BRIDGE_TOKEN` avant un déploiement réel en restaurant.

### HTTPS

Une PWA servie en HTTPS doit appeler un bridge HTTPS. Fournir un certificat et une clé :

```bash
TLS_CERT=/chemin/fullchain.pem \
TLS_KEY=/chemin/privkey.pem \
BRIDGE_TOKEN="..." \
npm start
```

Le certificat doit être reconnu par l’iPad. En déploiement restaurant, utiliser un nom DNS local stable pointant vers l’adresse LAN du bridge et un certificat approuvé par les appareils.

Exemple :

```text
https://bridge.restaurant.example:8787
```

Puis dans Resto360 :

```text
Réglages
 -> Bridge local
 -> Adresse HTTPS du bridge
 -> Tester
```

## Test d’acceptation restaurant

Avant utilisation réelle :

1. Charger Resto360 une fois avec Internet et vérifier `cache prêt`.
2. Configurer le bridge et les deux IP d’imprimantes.
3. Imprimer cuisine et reçu.
4. Couper Internet/WAN mais garder le Wi-Fi LAN.
5. Ouvrir une table, ajouter des articles et envoyer en cuisine.
6. Vérifier que l’impression cuisine fonctionne toujours.
7. Encaisser une transaction de test autorisée pour l’environnement utilisé.
8. Fermer complètement la PWA puis la rouvrir pendant la panne; vérifier que la commande locale est conservée.
9. Rétablir Internet; vérifier que l’outbox revient à `0 opération à synchroniser`.
10. Vérifier Supabase et la file MEV pour absence de doublons.

Ne pas déclarer le système prêt production avant un test réel prolongé avec les modèles exacts d’iPad et d’imprimantes du restaurant.
