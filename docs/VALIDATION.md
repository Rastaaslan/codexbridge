# Rapport de livraison — 23 septembre 2026

## Statut

**V1 implémentée, workflow réel validé via le connecteur MCP.** Les captures fournies par l’utilisateur montrent les appels réels « Get job report » et « Get job diff » depuis ChatGPT pour CB-1. Un second job a été créé et suivi via les outils du connecteur dans cette session, jusqu’au rapport du reviewer. Les jobs de démonstration restent soumis à la validation fonctionnelle humaine ; leur statut n’a pas été changé en COMPLETED à la place de l’utilisateur.

## Validation finale par le connecteur

Le 23 septembre 2026, `create_job` a créé **CB-2** dans la fixture existante via le connecteur CodexBridge. Le worker réel a corrigé l’addition et ajouté les tests dans son worktree. Le reviewer indépendant a accepté à la première itération ; `get_job_report` a retourné le rapport et le diff par le même connecteur. État final : `READY_FOR_HUMAN_TEST`.

- Cinq tests réussis, également réexécutés directement dans le worktree pendant cette vérification.
- Thread : `01a0cdaf-2d19-7302-9fa8-67ec9669afbc` ; branche : `codexbridge/CB-2`.
- Preuve locale exclue de Git : `.codexbridge/evidence/connected-mcp-CB-2.json`.
- Suite complète relancée : 24 tests réussis ; compilation stricte réussie ; `doctor` confirme auth Codex, SQLite et handshake MCP à onze outils.
- Contrôle des secrets : le script ignore désormais `GIT_CONFIG_KEY_n`, qui contient un nom de réglage Git, pas un secret. Le diagnostic indique le nom de variable concerné sans afficher sa valeur.

Le parcours de connexion constaté est documenté dans [CHATGPT.md](CHATGPT.md). Le démarrage quotidien, les demandes en langage naturel et la validation sont décrits dans [UTILISATION.md](UTILISATION.md).

## Architecture et périmètre

Node.js 24 / TypeScript, SQLite avec migrations et WAL, Git worktrees, app-server Codex officiel, reviewer indépendant Codex read-only (Responses API en option), scheduler persistant, HTTP + MCP Streamable HTTP et proxy stdio, SSE, dashboard local, CLI, plugin/skill, Docker et CI Windows/Linux.

Les onze outils demandés existent : création, lecture, liste, événements, rapport, diff, instruction, validation, rejet, annulation, reprise. Les décisions humaines sont journalisées. Les retours continuent le thread worker d’origine. Aucun push, merge ni déploiement automatique.

Modules : `src/domain.ts`, `database.ts`, `git.ts`, `codex.ts`, `reviewer.ts`, `orchestrator.ts`, `tools.ts`, `server.ts`, `stdio.ts`, `cli.ts`. UI dans `public/`, plugin dans `plugins/codexbridge`.

## Preuves obtenues

| Vérification                    | Résultat                                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Compilation TypeScript stricte  | Réussie                                                                                                                                    |
| Suite automatisée               | 24 tests réussis : états, SQLite, Git, corrections, humain, annulation, budgets, erreurs, recovery, HTTP/MCP, OAuth et reviewer API simulé |
| MCP réel                        | Initialisation, catalogue de 11 outils, appels structurés, erreurs et reconnexion validés avec le SDK client                               |
| E2E réel via MCP                | `create_job` → worktree → Codex → tests → reviewer → READY_FOR_HUMAN_TEST → `get_job_report` réussi                                        |
| Fixture réelle                  | `add(2,2)` passe de 5 à 4 ; quatre tests réussis, dépôt principal intact                                                                   |
| Arrêt brutal réel               | Serveur tué pendant un turn ; état récupéré, aucun second worktree ; reprise explicite du même thread                                      |
| Correction réelle après reprise | Rejet via MCP, ajout du cas `add(-0.5,0.25)`, cinq tests réussis, même thread, passage 3                                                   |
| SQLite après redémarrage        | Historique, reviews, thread et résultat conservés                                                                                          |
| Dashboard navigateur            | Login, formulaire, refus d’un dépôt invalide, état réel, résultat/tests et événements SSE vérifiés ; aucune erreur console observée        |
| Doctor                          | Node, Git, SQLite, Codex, auth ChatGPT, roots, permissions et handshake MCP : OK                                                           |
| Plugin et skill                 | Validateurs officiels réussis                                                                                                              |
| Secrets                         | Tests de redaction et préservation JSON ; tokens absents des URLs et du dépôt ; stderr Codex brut non journalisé                           |

Preuves locales privées :

- `.codexbridge/live-e2e/1790154721793/report.json` — chaîne réelle déclenchée par MCP, quatre tests.
- `.codexbridge/live-recovery/1790154679772/report.json` — arrêt brutal et correction, cinq tests ; thread `01a0cd88-acd7-7c51-a18f-7861992465ce` conservé.

Les rapports locaux sont exclus de Git ; ils peuvent contenir les chemins privés de la machine. Le script E2E indépendant réexécute réellement les tests au lieu de seulement croire le résumé du worker.

## Limites restant à vérifier

- Connexion ChatGPT : lecture du rapport et du diff CB-1 confirmée par les captures utilisateur du 23 septembre 2026. Aucun résultat n’a été copié manuellement depuis Codex pour cette récupération.
- Déploiement HTTPS/OAuth avec un fournisseur réel : implémenté, non déployé sur cette machine.
- Docker et Linux : fichiers fournis et CI configurée ; Docker non installé ici, donc build et sandbox Linux non vérifiés dans cette session.
- Reviewer Responses API : schéma et erreurs testés par simulation, mais aucun appel API payant faute de clé ; le reviewer Codex réel est validé.
- Une seule exécution simultanée ; après crash, reprise explicite conservatrice. Les demandes d’élévation sont refusées, sans bouton accordant un accès système illimité.
- La boucle automatique REQUEST_CHANGES est testée avec adapter/reviewer simulés. La correction réelle et la reprise du même thread ont été vérifiées via rejet MCP ; les reviewers réels ont accepté les fixtures sans réclamer de correction spontanée.

## Lancement et commandes

`npm install`, `npm run setup`, `codex login`, `npm run doctor`, `npm run dev`. Après `npm link` : `codexbridge start`, `stop`, `doctor`, `status`, `jobs`, `job <id>`, `report <id>`, `token`, `mcp-stdio`.

Le serveur de cette session écoute `http://127.0.0.1:3847`. Le jeton local se récupère avec `node dist/cli.js token`. La connexion ChatGPT est décrite dans [CHATGPT.md](CHATGPT.md), l’architecture dans [ARCHITECTURE.md](../ARCHITECTURE.md).
