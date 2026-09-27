# Utiliser CodexBridge au quotidien

## Démarrer après un redémarrage du PC

Dans un terminal ouvert dans le dossier du projet :

```sh
npm start
```

Garder ce terminal ouvert. Dans un second terminal, au même endroit :

```sh
node scripts/tunnel.mjs connect
node scripts/tunnel.mjs status
npm run doctor
```

Le tunnel doit être disponible (`ready: true`) et doctor doit confirmer les onze outils MCP. La connexion déjà ajoutée à ChatGPT peut être réutilisée. Le PC doit rester allumé pour exécuter les jobs ; fermer ChatGPT n’arrête pas le backend.

## Confier un travail

Sélectionner CodexBridge dans une conversation et préciser le dépôt, le problème et le résultat attendu :

> Dans le dépôt C:/projets/mon-app, crée un ticket pour corriger [problème]. Le résultat attendu est [comportement]. Ajoute les tests nécessaires et lance le travail.

Le dépôt doit être autorisé dans `repositoryRoots` de `.codexbridge/config.json` et avoir au moins un commit. Après modification de la configuration, redémarrer le serveur. Les fichiers non commités du dépôt principal ne sont pas inclus dans le travail.

ChatGPT retourne un identifiant comme CB-3. Le worker, le reviewer et les corrections automatiques continuent dans le service.

## Suivre et corriger

- « Où en est CB-3 ? »
- « Montre-moi le rapport et le diff de CB-3. »
- « Rejette le résultat de CB-3 et demande de corriger [problème précis]. »
- « Pour la question de CB-3, je choisis [réponse]. Continue. »
- « Annule CB-3. »

Une demande de correction après review reprend le même thread Codex. Pour un job encore actif, l’annuler avant de lui envoyer une nouvelle instruction. Après un arrêt brutal, consulter le diagnostic, puis demander explicitement de reprendre le job existant.

## Tester le résultat

Le rapport fournit le chemin du worktree et les commandes de test. Tester ce dossier, puisque le dépôt principal reste intact. Quand le résultat convient :

> J’ai testé CB-3 et je valide le résultat. Marque ce job terminé.

Cette validation change le statut en `COMPLETED`. L’intégration des changements dans votre branche principale reste une action distincte : aucun commit, merge ou push n’est déclenché par l’approbation.

## Arrêter

```sh
node scripts/tunnel.mjs stop
node dist/cli.js stop
```

Les jobs, rapports et worktrees restent sur disque. Pour une interruption planifiée, attendre la fin des jobs actifs ou les annuler avant l’arrêt.

Le [guide de connexion](CHATGPT.md) décrit la première installation ; le [dépannage](../TROUBLESHOOTING.md) couvre les erreurs.
