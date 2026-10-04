# Debian : bascule minimale (aucune migration effectuée par CB-41)

Le dépôt distant ne contenait que le README. CB-41 reprend les sources Windows dans son worktree ; ni le runtime Windows, ni ses secrets, ni ses dépendances n'ont été copiés. Relire le diff complet avant tout commit/push manuel. `npm run audit:publication` contrôle fichiers suivis **et** nouveaux fichiers non ignorés, y compris les fichiers sensibles accidentellement suivis. Ce contrôle détecte les formats courants ; il ne remplace pas la revue du diff. Aucun push automatique.

## À faire une seule fois sur Debian

1. Installer Node 24+ (`/usr/bin/node`), npm, Git, sudo, et le CLI Codex accessible au compte de service. Choisir le dépôt Git amont privé/autorisé et une ref publiée après validation locale. Depuis une copie revue du dépôt : `sh deploy/debian/install.sh` comme administrateur. L'installation crée le compte `codexbridge`, les dossiers, le wrapper root-owned et active le démarrage au boot ; elle ne démarre aucun service et ne remplace pas les configurations existantes.
2. Renseigner `/etc/codexbridge/update.json` (URL Git sans secret incorporé) et `/etc/codexbridge/environment` (clé runtime du tunnel ; éventuellement clé reviewer). Pour un dépôt privé, fournir au compte un accès Git **en lecture seule** et la vérification de l'hôte SSH. Construire la première release : `sudo -u codexbridge env HOME=/var/lib/codexbridge /usr/bin/node /usr/local/lib/codexbridge/initial-release.mjs <ref>`. Elle fait fetch, npm ci, build et tests avant de sélectionner la release ; elle refuse de remplacer une installation existante.
3. Préparer `/var/lib/codexbridge/config.json` par `setup` ou copie contrôlée, configurer `repositoryRoots` sous `/srv/codexbridge/repos`, garder le token, vérifier host/port. Authentifier Codex sous `HOME=/var/lib/codexbridge CODEX_HOME=/var/lib/codexbridge/codex`. Installer le tunnel avec les scripts existants et configurer son **ID réel** avec `node scripts/tunnel.mjs setup <tunnel_id>`, depuis `/opt/codexbridge/current`, sous le compte de service et avec `CODEXBRIDGE_HOME=/var/lib/codexbridge`. Aucune valeur de secret, d'ID ni d'accès serveur n'est inventée.
4. Si l'historique Windows doit être repris : arrêter proprement le service Windows, sauvegarder l'intégralité du runtime **et des dépôts Git communs**, puis transférer à froid DB, logs, threads et worktrees. Les jobs stockent des chemins absolus Windows : remapper `repository`, `worktree`, `dataDir`, `repositoryRoots`, `codexCommand`, les chemins du tunnel et les métadonnées Git des worktrees avant toute reprise (`git worktree repair` sur les dépôts Linux). Ne pas relancer les jobs anciens avant vérification de chaque worktree et des sessions Codex. Un simple copier-coller de SQLite n'est pas une migration portable ; garder la sauvegarde Windows intacte.
5. Vérifier sur Debian `visudo -cf /etc/sudoers.d/codexbridge` et `systemd-analyze verify /etc/systemd/system/codexbridge*.service`, puis démarrer via `/usr/local/sbin/codexbridge-control start`. Vérifier `server_doctor`, `jobs_overview` et la reconnexion ChatGPT. Faire un premier job fixture, un redémarrage, un reboot et une mise à jour/rollback contrôlée avant de confier des projets réels au serveur.

## Fonctionnement quotidien

Le doctor expose `orchestratorOk` (Node, SQLite, Git, authentification Codex, dépôts), `tunnel` (`ready`, `degraded`, `not_checked`) et `availability` (`ready`, `degraded`, `unhealthy`). Le champ historique `ok` reste global : il vaut faux si le tunnel échoue. Un orchestrateur sain avec tunnel indisponible est `degraded`, jamais déclaré prêt par un simple HTTP 2xx. Le statut est recalculé à chaque appel : le retour du tunnel rétablit `ready` sans modifier le journal ni redéployer.

La mise à jour et la récupération après reboot bloquent sur la santé **applicative**, le commit chargé et le service orchestrateur actif. Seul l'échec du check `tunnel` est non bloquant ; checks absents, incohérents, inconnus en échec ou identité incorrecte restent refusés. Les mêmes règles s'appliquent au rollback. Les états terminaux du journal incluent un instantané `health`, distinct du statut vivant du doctor. La maintenance est libérée uniquement après validation applicative, même en mode dégradé.

Le runner `/usr/local/lib/codexbridge/self-update.mjs` est installé root-owned hors releases : une mise à jour applicative seule ne change pas sa politique. L'administrateur doit installer la version revue du runner via l'installation existante avant la première mise à jour tolérant un tunnel dégradé. Le nouveau runner lit aussi les checks des anciens doctors, pour la migration et le rollback, sans accepter un simple booléen `ok`. Aucun changement d'infrastructure n'est exécuté par ce correctif.

- `server_doctor` : contrôles SQLite/Git/Codex/tunnel, commit actif, maintenance et dernier résultat de mise à jour. `server_logs` : 1–100 lignes du jour, lecture bornée et secrets masqués. `jobs_overview` : compteurs par projet et dix demandes d'attention récentes.
- `self_update({"ref":"refs/tags/<version>"})` ou `startRef` : requête persistante unique, traitée par une unité indépendante. Pas d'URL, commande, unité ou chemin libre dans l'outil. Consulter ensuite `server_doctor` ; le retour `accepted` n'annonce pas une activation réussie.
- Le runner root-owned s'exécute **sans root**. Il construit sous `/opt/codexbridge/releases`, avec environnement de validation séparé et sans secrets injectés. Seul le dépôt amont configuré par l'administrateur fournit le code exécuté. La maintenance bloque création et scheduling ; les jobs actifs font refuser la bascule, sans les interrompre. Les jobs queued reprennent après validation.
- Une intention persistante précède `rename` du lien `current`. La santé vérifie le commit réellement chargé, le doctor authentifié et les services. Échec : ancienne release restaurée et contrôlée. Échec du rollback : maintenance conservée, statut `rollback_failed` / `WAITING_FOR_HUMAN`, intervention admin requise. Au reboot, la récupération restaure une activation inachevée avant l'orchestrateur. Aucune release précédente n'est supprimée automatiquement.
- Le runtime, SQLite WAL, secrets, sessions Codex, logs et worktrees restent sous `/var/lib/codexbridge`. Les releases de ce protocole doivent conserver le schéma runtime 1 et la compatibilité des données ; une migration incompatible nécessite une procédure distincte, jamais un self-update. Ne pas modifier les unités/wrapper via une release : relancer l'installation revue pour une évolution de ces composants.
- `restart_service` est disponible uniquement en mode Debian géré et refuse les jobs actifs. L'unité du tunnel supervise le daemon du client existant (status/healthy/ready), avec relance automatique. Journaux système : `/usr/local/sbin/codexbridge-control logs`. Les processus Codex sont arrêtés avec le groupe systemd, puis les jobs actifs interrompus passent à `FAILED` avec diagnostic. Un worker interrompu en `CODEX_RUNNING` sans résultat enregistré bénéficie d’un retry automatique avec backoff si son budget runtime le permet ; son itération non revue est remboursée. Le thread enregistré, la branche, le worktree et l’historique sont conservés. Après épuisement, ou pour les autres passages actifs interrompus, une intervention explicite est nécessaire. Un enfant survivant bloque toute reprise tant qu’il est vivant, même si un retry est planifié. Voir [Vérifier la reprise](RECOVERY.md) pour les délais, événements et contrôles.

L'installation du tunnel au format ZIP sur Debian nécessite le paquet `unzip` (`sudo apt install unzip`). L'installateur vérifie le SHA-256 officiel avant le listing et l'extraction ; un outil absent ou une archive invalide arrête l'installation.

Le runtime Linux v0.0.15 expose uniquement `run`. `setup` enregistre l'ID localement ; `connect` reste au premier plan, avec `CONTROL_PLANE_API_KEY`, `CONTROL_PLANE_TUNNEL_ID` et `MCP_COMMAND` dans l'environnement. Le chemin standard utilise directement le control plane OpenAI et n'active pas le compagnon `cloudflared.managed`. Le superviseur systemd attend ce processus et transmet les signaux d'arrêt. `status` vérifie le PID et l'URL de base loopback enregistrés sous `CODEXBRIDGE_HOME` (`tunnel-runtime.pid`, `tunnel-health.url`), puis sonde les routes officielles `/healthz` et `/readyz`. `stop` vérifie l'exécutable et le chemin du fichier PID dans `/proc` avant SIGTERM. Pour arrêter durablement le service, utiliser son arrêt systemd : tuer le runtime seul déclenche le redémarrage prévu par l'unité. Windows conserve les commandes `runtimes` de son CLI.

La supervision Linux accorde 60 secondes de démarrage, puis vérifie la santé toutes les 10 secondes (sonde limitée à 5 secondes). Trois échecs consécutifs déclenchent SIGTERM, puis SIGKILL après 10 secondes sans sortie, et un code d'échec permettant le redémarrage systemd. `/healthz` doit répondre 200 pour la liveness et `/readyz` 200 pour la readiness ; un 503 sur `/readyz` garde le processus vivant mais non prêt.

Tests locaux : `npm run build`, `npm test`, `npm run audit:publication`. Sous la sandbox Windows : créer `.test-tmp`, définir `TEMP` et `TMP` sur son chemin absolu et utiliser `npm.cmd`. Tests réels Git/SQLite/HTTP/MCP/reprise ; contrôles statiques systemd/sudoers ; simulation des défaillances de transaction. Aucun test root/systemd ou tunnel distant n'a été exécuté sur Windows.

Après une restauration au boot, l'état `boot_pending_health` conserve la maintenance : aucun job ne démarre. L'unité `codexbridge-recovery-health.service`, ordonnée après l'orchestrateur et le tunnel, vérifie la release restaurée. Seul un contrôle réussi autorise la reprise. En cas d'échec, `rollback_failed` conserve la maintenance ; après correction, l'administrateur peut relancer cette unité de contrôle. Un nouveau reboot ne contourne pas cette vérification.

### Schema-v4 activation and restoration

The updater requires `release.json` to declare `runtimeSchema: 1`,
`sqliteSchema: 4`, and the exact checked-out Git commit. Both the on-disk and
committed `deploy/debian/release-policy.json` must declare those same schema
versions. Missing or contradictory metadata is rejected, including manifests
produced by earlier runners that omitted `sqliteSchema`. Do not fabricate a
rollback baseline by editing its metadata: provision and validate a compatible
release through a separately reviewed migration procedure.

Forward activation validates both the candidate and the installed rollback
baseline before switching `current`. Transaction validation precedes maintenance
acquisition. Rollback and boot restoration validate the restoration target only,
so a damaged outgoing manifest cannot prevent restoring a valid baseline.
Maintenance remains held until the restored service passes health checks.
Preparation failure only releases maintenance acquired by that transaction;
other operations' markers are preserved. Startup cleanup recognizes updater-owned
markers, including the older single-field updater reason format.
Maintenance acquisition publishes fully written, synced bytes with an atomic
no-replace hard link, then syncs the directory. A crash before publication may
leave an unused temporary file, but cannot expose a partial live marker or
overwrite another operation's marker.

This is a fail-closed migration policy, **not a v4-to-v1 rollback implementation**.
Cross-version rollout remains blocked until a separate migration/recovery
procedure has been validated. See [CB-92 rollback evidence](CB-92-ROLLBACK.md)
for the WAL, lifecycle and recovery-journal counterexamples behind this gate.
Worker edit/test compatibility also requires live
sandbox validation: protocol tests alone do not prove execution with network and
shared Git writes disabled. Native tunnel availability must be checked separately
from mocked tunnel contract tests.

### Updater compatibility contract

`deploy/debian/release-policy.json` declares `minimumUpdaterVersion`, a positive
integer copied into generated `release.json`. The invoking root-owned runner
has its own `UPDATER_VERSION` constant; candidate code cannot raise it. Version 1
covers schema-v4 validation, degraded-tunnel health, target-only restoration and
atomic maintenance publication. Increment the contract version when a release
needs new activation/recovery behavior, and raise that release's minimum.
Do not use the application version or database schema as the updater version.

Build rejects absent, malformed or newer requirements before running npm.
Activation checks the manifest, working policy and committed policy for the same
supported requirement before switching `current`; transaction validation happens
before maintenance. Restoration checks the target using the same contract.
Legacy schema-v4 rollback targets may omit the requirement only when all three
metadata sources omit it. New candidates must declare it. Runtime/SQLite schema
checks and cross-version rollback blocking still apply independently.

Older installed runners that predate this gate ignore the new field. They must
be replaced administratively **before requesting a release using this contract**;
a self-update cannot bootstrap enforcement. For a fresh installation, run the
reviewed `deploy/debian/install.sh` from the target release checkout, which installs
its matching runner and initialization script. For an existing installation,
use a separate reviewed administrator maintenance window with no update or
recovery process running and no pending update/recovery transaction. Keep the
runner compatible with both the current release and the rollback target; do not
downgrade it while either requires a newer contract.

From a clean, reviewed checkout pinned to the intended full commit, validate the
matching source runner locally before installation:

```sh
git diff --exit-code HEAD -- scripts/self-update.mjs deploy/debian/release-policy.json
node --input-type=module -e 'import { readFile } from "node:fs/promises"; import { validateUpdater } from "./scripts/self-update.mjs"; validateUpdater(JSON.parse(await readFile("deploy/debian/release-policy.json", "utf8")));'
```

Then, only during that separately authorized administrator operation, install
with an atomic replacement in the destination directory (do not overwrite a
runner in place or run the broad installer just to replace this file):

```sh
stage=$(sudo mktemp /usr/local/lib/codexbridge/self-update.XXXXXXXX)
sudo install -o root -g root -m 0644 scripts/self-update.mjs "$stage"
sudo mv -Tf -- "$stage" /usr/local/lib/codexbridge/self-update.mjs
cmp scripts/self-update.mjs /usr/local/lib/codexbridge/self-update.mjs
node --input-type=module -e 'import { readFile } from "node:fs/promises"; import { validateUpdater } from "/usr/local/lib/codexbridge/self-update.mjs"; validateUpdater(JSON.parse(await readFile("deploy/debian/release-policy.json", "utf8")));'
```

Use the same pinned commit for the subsequent release request. These instructions
are a future deployment procedure; CB-82 does not install a runner, invoke the
installer or change any production service.
