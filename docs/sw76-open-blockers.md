# Blocages restant après le SW-73 réel

Resto360 reste non certifié, mais la plupart des blocages techniques de ce document sont maintenant résolus grâce au vrai protocole MEV-WEB (`mev-protocol.js`/`mev-live.js`), vérifié en direct contre le DEV de Revenu Québec. Voir `certification-readiness.md` et `mev-architecture.md` pour le détail complet.

## Résolu

1. génération et cycle de vie des certificats Revenu Québec — enrôlement réel depuis l'appareil (`mev-enrollment.js`), certificat émis en direct par le DEV;
2. clé privée non exportable et CSR — clé ECDSA P-256 générée dans le Keystore Android natif, CSR vérifié en direct (ordre RDN et encodage base64 spécifiques, non évidents à la lecture du guide);
3. requête utilisateur pour chaque compte — `buildReqUtil`/`submitMevUserAccount` implémentés (SW-77 §3.3), envoyés au moins une fois (création du compte propriétaire), mais jamais vérifiés en direct contre le DEV contrairement à certificats/transaction;
4. structure JSON et en-têtes MEV-WEB exacts — connus et implémentés pour certificats/transaction/utilisateur;
5. canonicalisation et signature numérique exactes — ECDSA P-256, IEEE P1363, deux concaténations différentes (en-tête vs corps), vérifiées en direct.

## Partiellement résolu

6. codes de retour et règles de retransmission — seuls les codes rencontrés en pratique sont confirmés (succès, quelques rejets de mise au point); pas de liste exhaustive testée pour distinguer « à retransmettre en lot » d'un vrai rejet;
9. démarche complète SW-79 — le guide est en main, la démarche technique (protocole, certificat, transmission) est faite; il manque l'exécution officielle des cas d'essai dans le dossier partenaire Revenu Québec.

## Toujours bloqué

7. QR et hyperlien officiels — seul le domaine (`qr.mev-web.ca`) est confirmé, par une source tierce non officielle, pas par le SW-73;
8. modèles finaux des documents selon SW-73.B — la mécanique (mentions obligatoires, numérotation, révisions) est en place, mais la mise en page exacte attendue par SW-73.B n'a pas été confrontée document par document;
10. cas d'essai SW-77 et déclaration SW-78 — restent à exécuter et transmettre officiellement via le portail partenaire Revenu Québec; c'est une démarche administrative, pas un développement.

## Angles morts techniques (implémentés mais jamais exercés en direct)

- `docAdr` dans une forme non standard, `clint` (B2B), versements (`versActu`/`versAnt`/`sold`), types `ESTM`/`SOUM`/`ADDI` — voir l'en-tête de `mev-protocol.js`;
- la file hors ligne en mode `live` (`mev-offline-queue.js`) n'a pas été testée contre une vraie coupure réseau sur un appareil Android, ni contre le redémarrage/la réinstallation de l'app entre la mise en file et l'envoi;
- un lot rejeté (non « à réessayer ») par Revenu Québec reste actuellement en file indéfiniment sans alerte visible au-delà d'un toast au prochain essai de reconnexion.

## Bug corrigé

`sw76-readiness.js` marquait tout document imprimé « TRANSPORT MEV OFFICIEL NON CONFIGURÉ », y compris en mode `live` quand la transaction avait réellement été transmise. Corrigé — voir « Mention imprimée en mode `live` — corrigé » dans `certification-readiness.md` pour le détail et la limite restante sur le chemin de réimpression automatique.

Le registre ajouté (SW-76) conserve déjà les documents, références, empreintes, états hors ligne et erreurs de façon à pouvoir raccorder les points ci-dessus sans réécrire le POS.
