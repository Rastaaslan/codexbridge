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

### Projects, features and job dependencies (P1)

Legacy `create_job` payloads still queue immediately. Optionally create a project
with `create_project({name})`, then a feature with
`create_feature({projectId, name})`. Pass `projectId`, `featureId`, and/or
`dependencies: ["CB-1", "CB-2"]` to `create_job`. A feature implies its project;
a conflicting explicit project is rejected. Jobs may also belong directly to a
project, or remain ungrouped. Dependencies may cross features and projects.

`list_projects` and `list_features({projectId?})` expose the persisted hierarchy.
`get_job`, `list_jobs`, and `get_job_report` include dependency IDs, each
dependency's lifecycle status and state, aggregate `dependencyState`, and
derived `schedulingState`. `list_jobs` accepts `projectId`, `featureId`, and
`schedulingState` filters in addition to the existing status/pagination fields.
All these tools are available through MCP and authenticated
`POST /api/tools/<tool_name>`.

A queued job is `READY` when every dependency is `COMPLETED` (including an
empty dependency list). It is `BLOCKED` if any direct dependency is failed or
cancelled, otherwise `WAITING`. Non-queued jobs have scheduling state
`INACTIVE`. READY is derived, not a replacement lifecycle status or a promise
of an immediately available execution slot. Review acceptance alone does not
satisfy dependencies: human testing and `approve_job` must complete first.
The scheduler automatically dispatches READY jobs subject to concurrency and
worktree preparation locks. Retrying a failed dependency can unblock its
dependents without editing them.

`set_job_dependencies({id, dependencies})` replaces edges only while a job is
queued and has never begun work. Self-dependencies, unknown IDs, and cycles are
rejected atomically. Dependency lists are treated as sets. Create-job
idempotency compares hierarchy and dependencies as well as the existing fields.

SQLite schema v2 adds hierarchy and dependency tables transactionally on opening
a v1 database, preserving CB IDs, sequence, events, threads, reviews, and decisions.
Readiness is recomputed from persisted lifecycle state after restart. Existing
interrupted-worker recovery and the worker/reviewer/corrections/human-test loop
are unchanged. Dependencies express scheduling order; they do not merge upstream
worktrees or change a job's Git base. Integration remains an explicit manual action.

### Local reviewed integration (P2)

Reviewer acceptance never integrates a job. After a job reaches
`READY_FOR_HUMAN_TEST` or `COMPLETED`, explicitly call `integrate_job` with:

```json
{"id":"CB-12","target":"feature-chain","expectedBase":"<full source base commit>"}
```

The MCP tool and authenticated `POST /api/tools/integrate_job` endpoint share
strict schemas. The only ref advanced is
`refs/codexbridge/integration/feature-chain`. For an existing target,
`expectedBase` must match both that ref and the source job's pinned base.
Start each subsequent job with the preceding successful `resultCommit` (immutable)
or integration `ref` (resolved and pinned at job creation). This deliberately
rejects stale parallel changes instead of automatically merging them.

Configure administrator-owned verification commands in `config.json`:

```json
"integrationCommands": [
  {"command":"npm","args":["ci"],"timeoutMs":300000},
  {"command":"npm","args":["run","check"],"timeoutMs":300000}
]
```

At least one command is required. Commands execute as the service user without
shell interpolation in a detached candidate worktree. Use trusted local test
commands: this is not a sandbox for malicious scripts, and verification commands
must not publish or mutate other worktrees. Unignored candidate changes or a
changed candidate HEAD cause failure. Ignored build artifacts are allowed.

Review seals the full tracked/untracked Git tree, source HEAD, base, iteration,
and working status. Capture preserves staged additions, including force-added
ignored files, without changing the source index. Reviewer evidence is generated
from that exact immutable tree, including working changes hidden by
assume-unchanged flags. Snapshots captured before canonical review evidence was
introduced require another review before integration. Drift or unexpected repository dirt is refused. Existing
accepted jobs without a sealed snapshot need another review. Submodules are
currently refused. Source worktrees and their real indexes are preserved.
Integration creates a single commit with the reviewed tree and intended baseline
as its parent; source commit topology is not replayed. No push, deployment,
main/master update, or human approval is implied.

`get_job_integrations` and `get_job_report.integrations` expose independent
`VERIFYING`, `PUBLISHING`, `SUCCEEDED`, and `FAILED` attempts, including command
outputs, exit codes, timestamps, reviewed identity and resulting commit.
An empty history means integration was never requested. Failed attempts can be
retried explicitly; identical successful requests return the original result.
Conflicting concurrent attempts per repository and conflicting successful
requests fail clearly. The ref update uses compare-and-swap, so failed validation
cannot replace a successful baseline. On restart, an interrupted publication is
reconciled against its persisted candidate commit; other interrupted attempts
are failed and require an explicit retry. Interrupted candidate directories may
remain for diagnosis; retries use a fresh directory.
