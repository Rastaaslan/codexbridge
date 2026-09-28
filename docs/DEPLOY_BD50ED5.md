# Appliquer bd50ed5 via le runner installé et l'API locale

`dist/cli.js self_update` n'existe pas. `self_update` est un outil MCP également exposé par `POST /api/tools/self_update`. L'API crée `update-request.json` de façon exclusive et appelle le wrapper `codexbridge-control update`. L'unité systemd lance ensuite le runner root-owned comme **codexbridge**, pas comme root.

Exécuter le bloc unique ci-dessous depuis le clone Debian dont HEAD est bd50ed5, sans mise à jour concurrente. La première partie installe **uniquement le runner administratif**, avec les mêmes propriétaire et mode que `deploy/debian/install.sh`, par remplacement atomique. Elle ne copie pas de release ni ne refait l'installation des unités. Tous les appels sous codexbridge sont ensuite exécutés depuis `/`, accessible : aucun accès au clone privé n'est nécessaire.

La seconde partie demande le SHA complet à l'API locale et attend le résultat transactionnel. Pas de `npm ci`/build manuel, de lien `current` manuel ni de suppression de maintenance. Le runner fait lui-même fetch/build/tests, journalisation, activation, restart et contrôle applicatif. Le 404 du tunnel peut rester `degraded`. La clé d'authentification reste dans l'environnement ou le fichier local, jamais dans la ligne de commande.

```bash
(
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
test "$(git rev-parse HEAD)" = bd50ed579a08da74dc003d16ab10729f49369070
git diff --quiet HEAD -- scripts/self-update.mjs
printf '%s\n' '39f062e455b618ba99afa5f60649b6716f1182a1291054affcf05dc7795ddca9  scripts/self-update.mjs' | sha256sum -c -
for unit in codexbridge-update.service codexbridge-recover.service codexbridge-recovery-health.service; do
  test "$(systemctl show --property=MainPID --value "$unit")" = 0
  case "$(systemctl show --property=ActiveState --value "$unit")" in
    activating|deactivating|reloading) echo "Opération en cours : $unit" >&2; exit 1 ;;
  esac
done
sudo test ! -e /var/lib/codexbridge/update-request.json
stage=$(sudo mktemp /usr/local/lib/codexbridge/self-update.XXXXXXXX)
sudo install -o root -g root -m 0644 scripts/self-update.mjs "$stage"
sudo mv -Tf -- "$stage" /usr/local/lib/codexbridge/self-update.mjs
printf '%s\n' '39f062e455b618ba99afa5f60649b6716f1182a1291054affcf05dc7795ddca9  /usr/local/lib/codexbridge/self-update.mjs' | sha256sum -c -
cd / || exit 1
sudo -u codexbridge /usr/bin/env HOME=/var/lib/codexbridge CODEXBRIDGE_HOME=/var/lib/codexbridge CODEXBRIDGE_MANAGED=1 /usr/bin/node --env-file=/etc/codexbridge/environment --input-type=module <<'NODE'
import { readFile, realpath, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const ref = 'bd50ed579a08da74dc003d16ab10729f49369070';
const data = '/var/lib/codexbridge';
const root = '/opt/codexbridge';
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const requireState = (ok, message) => { if (!ok) throw Error(message); };
const systemctl = (...args) => execFileSync('/usr/bin/systemctl', args, { cwd: '/', encoding: 'utf8', timeout: 10000 });
async function run() {
  const { releaseHealth } = await import('file:///usr/local/lib/codexbridge/self-update.mjs');
  requireState(typeof releaseHealth === 'function', 'Installer le runner revu avant cette mise à jour');
  const config = await json(data + '/config.json');
  const api = async (name, body = {}) => {
    const response = await fetch(`http://127.0.0.1:${config.port ?? 3847}/api/tools/${name}`, {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.CODEXBRIDGE_TOKEN || config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
    requireState(response.ok, `API locale ${name}: HTTP ${response.status}`);
    return response.json();
  };
  const verify = async doctor => {
    const selected = await realpath(root + '/current');
    requireState(selected.startsWith(root + '/releases/'), 'current hors releases');
    const metadata = await json(selected + '/release.json');
    requireState(metadata.commit === ref && doctor.release === ref, 'Identité de release incorrecte');
    const health = releaseHealth(doctor, ref);
    requireState(!doctor.maintenance, 'Maintenance non terminée');
    systemctl('is-active', '--quiet', 'codexbridge.service');
    console.log(JSON.stringify({ selected, release: doctor.release, ...health, maintenance: doctor.maintenance, checks: doctor.checks.map(c => ({ name: c.name, ok: c.ok })) }));
  };
  systemctl('is-enabled', '--quiet', 'codexbridge.service');
  systemctl('is-enabled', '--quiet', 'codexbridge-tunnel.service');
  systemctl('is-enabled', '--quiet', 'codexbridge-recovery-health.service');
  requireState(systemctl('show', '--property=Requires', '--value', 'codexbridge.service').split(/\s+/).includes('codexbridge-recover.service'), 'Dépendance de récupération absente');
  requireState((await stat(data)).isDirectory(), 'Runtime persistant absent');
  requireState(await realpath(root + '/current') !== data, 'Runtime confondu avec release');
  const before = await api('server_doctor');
  console.log(JSON.stringify({ release: before.release, maintenance: before.maintenance, checks: before.checks.map(c => ({ name: c.name, ok: c.ok })) }));
  requireState(typeof before.release === 'string' && !before.maintenance, 'Précontrôle refusé : release/maintenance');
  releaseHealth(before, before.release);
  systemctl('is-active', '--quiet', 'codexbridge.service');
  if (before.release === ref) { await verify(before); return; }
  // A previous manually copied release may lack rollback identity metadata.
  const previous = await json(root + '/current/release.json');
  requireState(previous.commit === before.release && previous.runtimeSchema === 1, 'Release précédente sans métadonnées de rollback valides');
  requireState((await api('jobs_overview')).counts.running === 0, 'Jobs actifs : réessayer après leur fin');
  const started = Date.now();
  requireState((await api('self_update', { ref })).accepted === true, 'Requête non acceptée');
  for (const deadline = Date.now() + 3900000; Date.now() < deadline;) {
    await delay(5000);
    let state;
    try { state = await json(data + '/update-status.json'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (state.ref !== ref || Date.parse(state.time) < started) continue;
    if (['failed', 'rolled_back', 'rollback_failed'].includes(state.phase))
      throw Error(`Mise à jour ${state.phase} : conserver le journal et la maintenance, examiner le service codexbridge-update.`);
    if (state.phase === 'completed') {
      const after = await api('server_doctor');
      if (after.maintenance) continue;
      await verify(after);
      console.log('Transaction terminée ; runtime conservé sous /var/lib/codexbridge. Aucun reboot effectué.');
      return;
    }
  }
  throw Error('Délai de suivi dépassé : ne pas supprimer maintenance/journal ni relancer sans examiner leur état.');
}
run().catch(error => { console.error(error.message); process.exitCode = 1; });
NODE
)
```

Un échec avant l'appel API ne demande aucune release. Une panne applicative pendant la transaction provoque le rollback normal. Si une maintenance, une opération concurrente ou une release précédente sans métadonnées de rollback est détectée, le bloc s'arrête sans la contourner. En particulier une ancienne release copiée manuellement sans `release.json` doit être examinée avant d'engager un rollback géré ; ne pas inventer son identité.

Le `accepted` de l'API n'est pas une réussite de déploiement : seule la validation finale de la release sélectionnée, du doctor applicatif et de la maintenance libérée termine le bloc. Les vérifications systemd au boot sont des précontrôles ; aucun reboot n'est effectué. Si la release cible est déjà active et saine côté application, aucune nouvelle demande n'est envoyée. Le runner reste installé après un échec de précontrôle afin de pouvoir traiter la récupération avec la politique revue.

Cette procédure a été préparée et vérifiée syntaxiquement dans le worktree ; aucune commande de déploiement n'a été exécutée par l'agent.
