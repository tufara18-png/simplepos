# Resto360 — viabilité PWA pour le MEV-WEB

## Décision

Une PWA peut rester l'interface principale de Resto360 et peut fonctionner sans publication dans l'App Store.

En revanche, une **PWA Safari seule** ne doit pas encore être considérée comme l'ensemble du SEV fiscal. Les trois points qui empêchent cette conclusion sont :

1. le SW-73 n'est pas encore disponible dans le dépôt, donc le cycle exact du certificat, du CSR et de la signature n'est pas connu;
2. Safari ne fournit pas de socket TCP brut à une page Web pour imprimer directement sur une imprimante ESC/POS port 9100;
3. une clé WebCrypto non exportable peut être conservée dans IndexedDB, mais le stockage de l'origine reste supprimable par l'utilisateur et doit être surveillé, sauvegardé par un processus de réenrôlement et testé sur chaque version d'iPadOS.

## Architecture recommandée

```text
PWA installée sur iPad
  - tables, commandes, paiements, réservations
  - cache opérationnel local
  - diagnostic appareil et stockage persistant
  - aucune clé privée transmise à Supabase
          |
          v
Composant SEV/fiscal à confirmer avec Revenu Québec
  - création du document canonique
  - certificat et signature
  - file hors ligne durable
  - communication MEV-WEB
          |
          +--> bridge HTTPS local --> imprimantes ESC/POS
          +--> Supabase --> registre, sauvegardes et gestion
```

Le composant fiscal peut éventuellement être la PWA elle-même si le SW-73 et les essais de Revenu Québec confirment que le stockage WebCrypto/IndexedDB et le cycle de remplacement du certificat satisfont leurs exigences. Tant que ce point n'est pas confirmé, l'architecture la moins risquée est :

- PWA = terminal et interface;
- agent local ou service fiscal contrôlé = SEV principal;
- Supabase = données d'arrière-boutique, registre et synchronisation;
- bridge HTTPS local = impression réseau.

Cette architecture ne nécessite pas l'App Store.

## Diagnostic ajouté dans Resto360

Dans **Gestion → Appareil PWA et clé locale**, chaque iPad peut maintenant vérifier :

- installation en mode autonome;
- disponibilité d'IndexedDB et du Service Worker;
- persistance du stockage;
- génération d'une clé privée de test non exportable;
- signature et vérification locales;
- empreinte de la clé publique;
- accès au bridge HTTPS d'impression;
- enregistrement des capacités dans `mev_devices`.

La clé créée par ce diagnostic est une **clé de test de capacité uniquement**. Elle n'est pas utilisée pour le MEV-WEB et ne remplace pas le certificat officiel.

## Conditions minimales pour envisager une PWA comme SEV complet

- le SW-73 confirme l'algorithme et autorise la clé dans le stockage du navigateur;
- le certificat peut être ajouté, remplacé et supprimé depuis chaque appareil;
- la clé privée officielle est réellement non exportable;
- la perte ou l'effacement du stockage déclenche un réenrôlement contrôlé;
- chaque appareil possède un identifiant stable et une numérotation sans collision;
- une transaction peut être finalisée hors ligne sans dépendre d'une RPC distante;
- la file hors ligne survit à une fermeture, un redémarrage et une mise à jour;
- l'impression fonctionne par HTTPS sans dépendre d'une API Web non disponible dans Safari;
- les versions PWA sont figées et traçables pendant les essais et en production;
- tous les cas SW-77/SW-78 passent sur les iPad et imprimantes déclarés.

## Éléments encore bloqués par le SW-73

- endpoints et en-têtes officiels;
- schémas JSON et cardinalités;
- algorithme, encodage et canonicalisation de la signature;
- format du CSR et cycle du certificat;
- codes de retour et règles de retransmission;
- contenu du QR et chiffrement de l'hyperlien;
- format final de chaque document;
- règles exactes de chaînage et de numérotation multiappareil.
