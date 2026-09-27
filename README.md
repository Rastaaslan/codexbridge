# CodexBridge

`codexbridge` relie un ticket ChatGPT à un worker Codex, à un reviewer indépendant et à un rapport persistant. Le service local continue de travailler même si la conversation est fermée. Chaque job dispose d’une branche `codexbridge/CB-n`, d’un worktree isolé et d’un journal SQLite.

**Connexion ChatGPT validée : rapport et diff réels récupérés par les outils CodexBridge.** La fixture est corrigée, testée et acceptée par un reviewer réel via MCP. L’arrêt brutal puis la reprise dans le même thread sont également vérifiés. Voir [VALIDATION.md](docs/VALIDATION.md) et le [guide d’utilisation quotidienne](docs/UTILISATION.md).

## Installation Windows / Linux

Prérequis : Node.js 24+, Git et le CLI officiel Codex sur le PATH. Le binaire Windows doit être `codex.exe` (un shim `.cmd` ne peut pas être lancé sans shell). `codexCommand` accepte son chemin absolu. Le protocole a été inspecté avec Codex `0.155.0-alpha.16` ; exécuter le test réel après tout changement de version.

```sh
git clone <votre-url>/codexbridge.git
cd codexbridge
npm install
npm run setup
codex login
npm run doctor
npm run dev
```

`npm run setup` compile et crée `.codexbridge/config.json` avec un jeton aléatoire. Pour disposer de la commande globale, lancer `npm link`. Définir ensuite `CODEXBRIDGE_HOME` avec le chemin absolu du dossier `.codexbridge` pour retrouver la même configuration depuis n’importe quel dossier et depuis le plugin.

```text
codexbridge start
CodexBridge running
Dashboard: http://127.0.0.1:3847
MCP: http://127.0.0.1:3847/mcp
```

`start` reste au premier plan ; le faire tourner dans un terminal ou un gestionnaire de service. `stop` demande un arrêt propre. Pour déverrouiller le dashboard, copier localement la sortie de `codexbridge token`. Ne pas partager ce jeton : il donne accès aux dépôts autorisés.

## Ajouter un dépôt

Modifier `repositoryRoots` dans `.codexbridge/config.json`, puis redémarrer. Utiliser des chemins absolus de dépôts ou de dossiers parents autorisés. Le dépôt doit avoir au moins un commit. Les modifications locales non commitées du dépôt principal ne sont pas copiées : la base est son `HEAD` au début du job.

```json
{
  "dataDir": "C:/codexbridge/.codexbridge",
  "repositoryRoots": ["C:/projets/mon-app"],
  "token": "<jeton-genere-par-setup>",
  "reviewer": "codex"
}
```

Conserver les autres champs existants. Le reviewer par défaut utilise un thread Codex distinct en sandbox lecture seule. Pour l’API Responses, choisir `reviewer: "openai"`, renseigner `reviewerModel` et définir `OPENAI_API_KEY` dans l’environnement ou `.env`. Ne jamais mettre une clé dans un ticket.

## Utilisation

Créer un ticket dans le dashboard ou via `create_job` depuis le plugin connecté. Le job traverse worker → review → corrections jusqu’à acceptation, décision humaine ou budget épuisé. Le service traite un job à la fois ; les autres attendent dans la file persistante.

```text
Utilisateur : Envoie un ticket pour corriger add(2,2), qui renvoie 5.
ChatGPT : CB-42 est créé et lancé.
Utilisateur : Où en est-il ?
ChatGPT : [get_job, puis get_job_report] Le reviewer a accepté.
          Le worktree est prêt pour vos tests fonctionnels.
```

Après les tests fonctionnels, « Valider les tests » ou `approve_job` marque le job `COMPLETED`. Cela n’effectue aucun merge, commit, push ou déploiement. Une correction est renvoyée au **même thread Codex**. Les jobs actifs doivent être annulés avant d’ajouter une instruction.

Commandes : `setup`, `start`, `stop`, `doctor`, `status`, `jobs`, `job CB-42`, `report CB-42`, `token`, `mcp-stdio`.

## Connecter ChatGPT

Voir [le guide de connexion](docs/CHATGPT.md) : Secure MCP Tunnel pour le local, HTTPS + OAuth pour une exposition distante. Le package de plugin est dans `plugins/codexbridge`. Le service doit être lancé avant le plugin. L’accès ChatGPT dépend des droits du compte et du workspace ; une URL localhost seule n’est pas une connexion cloud.

## Vérifications

```sh
npm run check       # TypeScript + tests unitaires/intégration, SQLite, Git, MCP
npm run test:live   # vrai Codex + vrai reviewer sur une fixture isolée
npm run test:live-recovery # arrêt brutal réel, reprise et correction dans le même thread
codexbridge doctor
```

Le test réel écrit ses preuves dans `.codexbridge/live-e2e/<timestamp>/report.json`, vérifie aussi les tests directement dans le worktree, l’isolation du dépôt et la persistance après réouverture. Il consomme l’usage Codex/API configuré. Il échoue explicitement si l’authentification manque.

Voir [architecture](ARCHITECTURE.md), [sécurité](SECURITY.md), [dépannage](TROUBLESHOOTING.md), [Docker](docs/DOCKER.md) et [recovery](docs/RECOVERY.md).

## Serveur sans ?cran

Voir [la migration Debian](docs/MIGRATION.md). `create_job` accepte `startRef` (branche, tag, ref ou SHA local) et fige son commit. Les onze outils historiques restent disponibles ; `server_doctor`, `server_logs`, `jobs_overview`, `restart_service` et `self_update` compl?tent le pilotage vocal.
