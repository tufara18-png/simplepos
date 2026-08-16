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
- simulateur explicitement non fiscal.

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
