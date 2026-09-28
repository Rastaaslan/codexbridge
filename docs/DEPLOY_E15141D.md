# Mise à jour e15141d par le mécanisme géré

La politique autorisée sépare désormais la santé applicative de la disponibilité du tunnel. Le runner exige le doctor authentifié, tous les contrôles applicatifs, l'identité exacte de release et `codexbridge.service` actif. Un tunnel indisponible reste explicitement `degraded`, sans rollback applicatif. Une panne applicative conserve le rollback et la maintenance en cas d'échec de récupération.

**Prérequis administratif : installer le runner revu contenant `releaseHealth` dans `/usr/local/lib/codexbridge/self-update.mjs`.** Il est root-owned et n'est pas remplacé par une release applicative. L'installation administrative existante `deploy/debian/install.sh` installe ce runner ; sa mise à jour reste une opération revue séparée, non exécutée ici. Le bloc refuse si le runner installé n'expose pas la nouvelle politique. Ne pas contourner le driver avec `activate`, un lien manuel ou une suppression de maintenance. Le SHA e15141d reste une cible historique ; pour déployer aussi les nouveaux champs du doctor, utiliser le SHA complet du commit contenant cette évolution après sa création. Le runner accepte les checks des anciens doctors pour la première migration et le rollback.

Après résolution de ce prérequis, exécuter sur dam-server depuis n'importe quel répertoire : le shell rejoint `/` avant de changer d'utilisateur. Le token reste local et n'est jamais placé dans les arguments ni affiché. Le bloc appelle uniquement l'API locale `self_update` qui écrit la requête exclusive, puis appelle le wrapper `codexbridge-control update`. L'unité root-owned exécute le runner comme codexbridge ; celui-ci fetch le SHA complet, construit et teste en environnement isolé, journalise la maintenance, bascule et redémarre. Aucun `cp`, build manuel ou changement d'unité.

```bash
(
cd / || exit 1
sudo -u codexbridge /usr/bin/env HOME=/var/lib/codexbridge CODEXBRIDGE_HOME=/var/lib/codexbridge CODEXBRIDGE_MANAGED=1 /usr/bin/node --env-file=/etc/codexbridge/environment --input-type=module <<'NODE'
import { readFile, realpath, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const ref = 'e15141d884a418e841634e23260b49f18622ec7a';
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

Idempotence : si le SHA voulu est déjà servi et sain, aucune requête n'est envoyée. Sinon le mécanisme existant verrouille la demande par création exclusive ; le bloc n'écrase ni demande ni journal. Après échec, il ne retire pas la maintenance. Les reprises passent par les unités de récupération existantes.

Les vérifications d'activation au boot et du répertoire persistant sont des précontrôles, pas une preuve de reboot réel. Aucun reboot, déploiement ou appel au service n'a été exécuté par l'agent. Un précédent déploiement manuel sans `release.json` peut aussi bloquer le rollback géré : le bloc le signale et ne fabrique pas de métadonnées.
