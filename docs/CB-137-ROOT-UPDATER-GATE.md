# CB-137: compatibility installation gate

**Decision: installation procedure reviewed; candidate activation remains STOP.**
No production files, ownership, services, database, or release links were changed.
No production sudo, installer, updater CLI, restart, push or deployment was performed.
The minimal packaging defect fix and regression evidence are committed locally.
Only the dry-run copy of the installer ran, with privileged operations replaced.

## Evidence (2026-10-05)

- Exact original candidate inspected: `5f3ff316ce57d413068f8d0a9245b9a3ad57f0bc`.
  Original policy: runtime 1, SQLite 4, minimum updater 2; runner exports version 2.
  **Do not activate this original candidate.** The CB-137 revision changes only
  the release compatibility contract to runtimeSchema 2 (SQLite stays 4), with
  matching runner/readiness support and regression tests. Review the local
  CB-137 fix commit as the replacement candidate; do not reuse the original SHA
  for a later activation request.
- Actual `current`: `/opt/codexbridge/releases/3a99deafb510a893e607204f3add8805599c69e7-1790617049303`.
  Original manifest contains only commit and runtime 1. Candidate
  `historicalIdentity('/opt/codexbridge/current')` passed: pinned Git/source,
  original metadata and all 13 compiled module hashes match.
- systemd reports application PID 1652829 and tunnel PID 1652830, both active
  since 2026-09-28 19:37:36 CEST. Loaded application command has no bootstrap.
  These values were unchanged after validation. Host PIDs are not visible in this
  sandbox's `/proc`; no direct process-memory attestation is claimed.
- Updater inactive/dead; recover active/exited; recovery-health inactive/dead.
  Last journal phase completed. No pending request, maintenance marker or
  published rollback snapshot was observed. Recheck immediately before installation.
- Installed runner SHA-256:
  `3ea3502d7d6588f725c49037c2261b5da90f3e51503050a4eac7d3070fd2011e`.
  It predates the contract: build checks only runtimeSchema; activation checks
  release-directory containment, then changes the link. An isolated invocation of
  its exported `makeDriver(...).activate(...)` accepted a temporary candidate
  manifest requiring updater 2. Direct invocation of that old low-level method
  remains unsafe and is never an approved activation procedure. The supported
  old transaction's **fetch/build flow now rejects the revised runtimeSchema 2
  policy before npm, maintenance or activation**, using its existing runtimeSchema
  gate. The regression reconstructs the installed artifact byte-for-byte (SHA-256
  above), performs real local Git fetch/clone/checkout and asserts rejection plus
  unchanged current and DB/WAL/SHM sentinels. It also compares reconstructed bytes
  to the actual installed runner when `CB_TEST_INSTALLED_UPDATER` is set.
  This fixes the candidate packaging defect without modifying the deployed runner.
- Candidate versus historical deployment changes: installer adds flock dependency
  and bootstrap payload; main unit adds startup guard and Node import hook.
  The other four installed units, control wrapper and initial-release script are
  byte-identical to the candidate. Existing boot enablement is already correct.
- UID/GID on installed files appears as 65534:65534 in this sandbox. This does
  not establish host root ownership. Host verification below is mandatory.

## Operator checklist: future administrator operation only

1. Reserve an exclusive administrator window: no update requests, recovery,
   service restart/reboot, or concurrent configuration management during the
   multi-file replacement. Keep the existing application running. If that
   exclusion cannot be guaranteed, **STOP**. This ticket does not authorize a
   maintenance restart or application activation.
2. Run the read-only checks below as an ordinary user in a reviewed checkout of
   the reviewed CB-137 replacement candidate. Stop on any mismatch. Do not run the broad `install.sh`:
   it also changes application-directory ownership, installs sudoers/configuration
   and enables boot units. Do not run `initial-release.mjs` on this installation.
3. Administrator: verify host ownership, paths, sudoers and unit syntax; back up
   and atomically replace **only** runner, bootstrap and main unit as below.
   Reload definitions without starting, stopping, enabling or restarting services.
4. Verify hashes, modes, loaded wiring and unchanged current/PIDs/timestamps.
   Any failure leaves activation blocked. Retain the backup and diagnose; do not
   restart to “test” the installation or restore the old runner and activate.
5. **STOP after installation.** A daemon reload does not add instrumentation to
   the running v1 process. A separate approved maintenance window must boot the
   same unchanged `3a99dea` release with the hook and obtain successful read-only
   `--bootstrap-preflight` before an activation can even be considered.

### Checks requiring no sudo

```sh
set -eu
cd /var/lib/codexbridge/worktrees/CB-137
git merge-base --is-ancestor 5f3ff316ce57d413068f8d0a9245b9a3ad57f0bc HEAD
# Record this reviewed replacement SHA for the separate activation window.
git rev-parse HEAD
/usr/bin/node -e 'const p=require("./deploy/debian/release-policy.json"); if(p.runtimeSchema!==2 || p.sqliteSchema!==4 || p.minimumUpdaterVersion!==2) process.exit(1)'
git diff --exit-code HEAD -- scripts deploy/debian
/usr/bin/node --input-type=module -e 'import {readFile} from "node:fs/promises"; import {UPDATER_VERSION,validateUpdater,historicalIdentity} from "./scripts/self-update.mjs"; if(UPDATER_VERSION!==2) throw Error("version"); validateUpdater(JSON.parse(await readFile("deploy/debian/release-policy.json"))); console.log(await historicalIdentity("/opt/codexbridge/current"));'
test -x /usr/bin/flock
/usr/bin/node -e 'if (+process.versions.node.split(".")[0] < 24) process.exit(1)'
sh -n deploy/debian/install.sh
for unit in codexbridge-tunnel codexbridge-update codexbridge-recover codexbridge-recovery-health; do
  cmp "deploy/debian/$unit.service" "/etc/systemd/system/$unit.service"
done
cmp deploy/debian/codexbridge-control /usr/local/sbin/codexbridge-control
cmp scripts/initial-release.mjs /usr/local/lib/codexbridge/initial-release.mjs
systemctl is-enabled codexbridge.service codexbridge-tunnel.service codexbridge-recovery-health.service
systemctl show codexbridge.service codexbridge-tunnel.service -p MainPID -p ActiveState -p ActiveEnterTimestamp
systemctl show codexbridge-update.service codexbridge-recover.service codexbridge-recovery-health.service -p ActiveState -p SubState
readlink -f /opt/codexbridge/current
```

Require all three boot units enabled, application/tunnel active, updater and
health inactive (not activating), recover exited, and original current target.
`systemd-analyze verify deploy/debian/*.service` is also read-only, but could not
run inside this sandbox (`Failed to setup working directory: Read-only file
system`, exit 1, including retry with workspace TMPDIR). Run it on the host;
resolve all candidate-unit errors before installation.

### Administrator commands (NOT executed here)

Every command in this block runs under sudo/root. The source checkout must remain
exclusive and unchanged throughout; compare its three payloads to the reviewed
CB-137 replacement commit immediately before proceeding (not the original 5f3ff316). The block refuses symlink destinations,
active updater/recovery work, pending requests/maintenance and snapshot remnants.
The pre-existing completed journal must also have been reviewed. Never display
configuration secrets as part of these checks.

```sh
sudo /bin/sh -eu <<'ADMIN'
cd /var/lib/codexbridge/worktrees/CB-137
visudo -cf /etc/sudoers.d/codexbridge
cmp deploy/debian/sudoers /etc/sudoers.d/codexbridge
systemd-analyze verify deploy/debian/*.service
for src in scripts/self-update.mjs scripts/legacy-bootstrap.mjs deploy/debian/codexbridge.service; do
  test -f "$src"
  test ! -L "$src"
done
for unit in codexbridge-tunnel codexbridge-update codexbridge-recover codexbridge-recovery-health; do
  cmp "deploy/debian/$unit.service" "/etc/systemd/system/$unit.service"
done
for unit in codexbridge codexbridge-tunnel; do
  test "$(systemctl show "$unit.service" -p ActiveState --value)" = active
done
node -e 'const fs=require("node:fs"); if(JSON.parse(fs.readFileSync("/var/lib/codexbridge/update-status.json")).phase!=="completed") process.exit(1)'
for unit in codexbridge-update codexbridge-recovery-health; do
  test "$(systemctl show "$unit.service" -p ActiveState --value)" = inactive
done
test "$(systemctl show codexbridge-recover.service -p SubState --value)" = exited
for file in update-request.json maintenance.json; do
  test ! -e "/var/lib/codexbridge/$file"
  test ! -L "/var/lib/codexbridge/$file"
done
for file in /var/lib/codexbridge/rollback-snapshot*; do
  test ! -e "$file"
  test ! -L "$file"
done
test "$(readlink -f /opt/codexbridge/current)" = /opt/codexbridge/releases/3a99deafb510a893e607204f3add8805599c69e7-1790617049303
# All parents must be real root-owned directories, without group/other write.
# STOP and investigate any unexpected host ownership or writable parent.
for dir in /usr /usr/local /usr/local/lib /usr/local/lib/codexbridge /etc /etc/systemd /etc/systemd/system; do
  test ! -L "$dir"
  test "$(stat -c '%u:%g' "$dir")" = 0:0
  test -z "$(find "$dir" -maxdepth 0 -perm /022 -print)"
done
backup=$(mktemp -d /var/backups/codexbridge-CB-137.XXXXXXXX)
printf 'Retain backup: %s\n' "$backup"
readlink -f /opt/codexbridge/current > "$backup/current.before"
systemctl show codexbridge.service codexbridge-tunnel.service -p MainPID -p ActiveState -p ActiveEnterTimestamp > "$backup/processes.before"
# Save all originals before replacing any file; absent bootstrap is recorded.
for dst in /usr/local/lib/codexbridge/self-update.mjs /usr/local/lib/codexbridge/legacy-bootstrap.mjs /etc/systemd/system/codexbridge.service; do
  test ! -L "$dst"
  if test -e "$dst"; then
    test -f "$dst"
    cp -a --parents "$dst" "$backup/"
  else
    test "$dst" = /usr/local/lib/codexbridge/legacy-bootstrap.mjs
    touch "$backup/bootstrap-was-absent"
  fi
done
replace() {
  src=$1; dst=$2
  stage=$(mktemp "${dst}.CB-137.XXXXXXXX")
  install -o root -g root -m 0644 "$src" "$stage"
  cmp "$src" "$stage"
  mv -Tf -- "$stage" "$dst"
  test "$(stat -c '%u:%g:%a' "$dst")" = 0:0:644
  cmp "$src" "$dst"
}
replace scripts/self-update.mjs /usr/local/lib/codexbridge/self-update.mjs
replace scripts/legacy-bootstrap.mjs /usr/local/lib/codexbridge/legacy-bootstrap.mjs
replace deploy/debian/codexbridge.service /etc/systemd/system/codexbridge.service
systemd-analyze verify /etc/systemd/system/codexbridge*.service
systemctl daemon-reload
readlink -f /opt/codexbridge/current > "$backup/current.after"
systemctl show codexbridge.service codexbridge-tunnel.service -p MainPID -p ActiveState -p ActiveEnterTimestamp > "$backup/processes.after"
cmp "$backup/current.before" "$backup/current.after"
cmp "$backup/processes.before" "$backup/processes.after"
systemctl show codexbridge.service -p ExecStartPre -p ExecStart -p Requires -p After
ADMIN
```

Loaded `ExecStartPre` must contain the installed runner's `--guard-start`;
`ExecStart` must contain `--import /usr/local/lib/codexbridge/legacy-bootstrap.mjs`
and the unchanged `/opt/codexbridge/current/dist/cli.js start`. Main Requires/After
recover; recover Before main; health Wants/After main and tunnel. Updater has no
PartOf/BindsTo/main Requires relationship. No unit executes the updater as root.

Then as an ordinary user, verify the installed contract by **import only**:

```sh
/usr/bin/node --input-type=module -e 'import {readFile} from "node:fs/promises"; import {UPDATER_VERSION,validateUpdater} from "/usr/local/lib/codexbridge/self-update.mjs"; if(UPDATER_VERSION!==2) throw Error("wrong installed runner"); validateUpdater(JSON.parse(await readFile("deploy/debian/release-policy.json")));'
```

Do not invoke the runner without a read-only flag. After the separately authorized
same-release bootstrap restart, the service account can run
`/usr/bin/node /usr/local/lib/codexbridge/self-update.mjs --bootstrap-preflight`.
Running it now cannot certify readiness: the current process lacks the socket.
Even success returns `activationPermitted: false`; it is not an activation permit.

## Snapshot and rollback stop conditions

Require the pinned historical identity, bootstrap socket mode 0600 and source/PID
binding, authenticated original doctor, matching systemd MainPID and cgroup with
no surviving workers. Maintenance must be transaction-owned; all admitted
operations/jobs must drain. Stop both app and tunnel with zero MainPID/ControlPID
before capture. No other database writers or manual starts may exist.

The version-2 transaction captures presence/absence and exact bytes of
`codexbridge.db`, `-wal`, and `-shm`; it checks integrity/schema on a disposable
copy, binds hashes to transaction/source/candidate, and persists evidence before
link activation. Never substitute a live DB-only copy, edit legacy metadata,
open the candidate Store against production for preflight, or delete an orphan
snapshot/maintenance marker to bypass a refusal. Bad/ambiguous journal, insufficient
space, failed health, corrupt snapshot, incompatible metadata or missing guard
means STOP. Retain snapshot and maintenance on failed rollback; boot recovery
restores before Store startup and post-boot health controls resumption.

## Validation results and reproducible installer dry-run

- `npm ci --ignore-scripts --no-audit --no-fund`: passed (111 packages).
- `TMPDIR="$PWD/.test-tmp" npm run check`: build passed; **194/194 tests passed** (revision validation).
  Includes actual historical CLI/Store/bootstrap, cold WAL rollback, crash recovery,
  unsupported version gates, missing guard/hook and systemd relationship checks.
- `sh -n deploy/debian/install.sh`: passed.
- Installer harness below: passed after fixing an initial harness-only path
  substitution bug. Ten payloads byte-identical, real destination modes correct,
  requested root:root ownership asserted, existing configuration preserved,
  systemctl limited to mocked reload/enable, no application release installed.
  Ownership is simulated, not a proof of real chown. Native systemd verify remains
  blocked by the sandbox as described above.
- `python3 tests/admin-install-dry-run.py`: passed. Extracted the exact administrator
  shell block above, relocated all system paths, simulated host ownership and
  systemctl/visudo/systemd-analyze, and executed file operations in a disposable
  tree. Confirmed three mode-0644 payload replacements, backup/absent-bootstrap
  record, unchanged current, and only a mocked daemon-reload. The committed harness
  requires exactly the three intended payload changes (backup files excepted),
  asserts requested root:root 0644 and actual modes, and tests 17 unsafe conditions
  aborting before any replacement/reload. It reads no host deployment files.
  Simulated process output does not prove live process behavior.
- `CB_TEST_INSTALLED_UPDATER=/usr/local/lib/codexbridge/self-update.mjs TMPDIR="$PWD/.test-tmp" npx tsx --test tests/legacy-candidate-gate.test.ts`:
  passed. Exact installed old updater rejects revised policy in its full transaction;
  revised runner accepts it and preserves contract 2 in generated metadata.
- Actual historical CLI/Store bootstrap and rollback tests now use runtimeSchema 2
  candidates, preserving the unchanged runtimeSchema 1 historical source.
- Native `systemd-analyze verify` is still a host prerequisite, not a passed test.
  Activation remains STOP pending the administrator operation and separate same-v1
  bootstrap restart/preflight. Passing these dry-runs does not authorize deployment.

Run this Python appendix from the candidate checkout after creating `.test-tmp`.
It executes only a relocated installer; id/getent/install/chown/sudo/systemctl/
visudo are test doubles. Real install receives only workspace destinations and
has its ownership arguments removed. It does not validate sudoers grammar;
that remains the administrator's `visudo` prerequisite.

```python
import json, os, pathlib, re, shutil, subprocess, tempfile
repo = pathlib.Path.cwd()
with tempfile.TemporaryDirectory(prefix='install-', dir=repo/'.test-tmp') as tmp:
    base = pathlib.Path(tmp)
    tree = base/'checkout'
    shutil.copytree(repo/'deploy', tree/'deploy')
    shutil.copytree(repo/'scripts', tree/'scripts')
    root = base/'root'
    for p in ['etc/systemd/system', 'etc/sudoers.d', 'usr/local/sbin', 'etc/codexbridge']:
        (root/p).mkdir(parents=True, exist_ok=True)
    for name in ['environment', 'update.json']:
        (root/'etc/codexbridge'/name).write_text('preserved sentinel')
    installer = tree/'deploy/debian/install.sh'
    text = installer.read_text()
    prefixes = ['/opt/codexbridge', '/usr/local', '/var/lib/codexbridge', '/srv/codexbridge', '/etc/codexbridge', '/etc/sudoers.d', '/etc/systemd/system']
    text = re.sub('|'.join(map(re.escape, prefixes)), lambda m: str(root)+m[0], text)
    installer.write_text(text)
    bin = base/'bin'; bin.mkdir()
    log = base/'calls.jsonl'
    shim = bin/'shim'
    shim.write_text('''#!/usr/bin/python3
import os, sys, json, subprocess
name = os.path.basename(sys.argv[0]); args = sys.argv[1:]
with open(os.environ['DRY_LOG'], 'a') as f: f.write(json.dumps([name, *args])+'\\n')
if name == 'id' and args == ['-u']: print('0')
if name == 'install':
    assert args[-1].startswith(os.environ['DRY_ROOT']+'/')
    clean=[]; i=0
    while i < len(args):
        if args[i] in ['-o','-g']: i+=2
        else: clean.append(args[i]); i+=1
    subprocess.run(['/usr/bin/install', *clean], check=True)
''')
    shim.chmod(0o755)
    for name in ['id','getent','groupadd','useradd','install','chown','sudo','systemctl','visudo']:
        (bin/name).symlink_to(shim)
    env = dict(os.environ, PATH=str(bin)+':'+os.environ['PATH'], DRY_LOG=str(log), DRY_ROOT=str(root))
    subprocess.run(['sh', str(installer)], env=env, check=True)
    calls = [json.loads(line) for line in log.read_text().splitlines()]
    files = [c for c in calls if c[0]=='install' and '-d' not in c]
    assert len(files)==10, files
    for c in files:
        assert c[c.index('-o')+1]=='root' and c[c.index('-g')+1]=='root'
        dest=pathlib.Path(c[-1]); mode=int(c[c.index('-m')+1],8)
        assert dest.stat().st_mode & 0o777 == mode
        assert dest.read_bytes()==(tree/c[-2]).read_bytes()
    for name in ['environment','update.json']:
        assert (root/'etc/codexbridge'/name).read_text()=='preserved sentinel'
    assert [c for c in calls if c[0]=='systemctl']==[
        ['systemctl','daemon-reload'],
        ['systemctl','enable','codexbridge.service','codexbridge-tunnel.service','codexbridge-recovery-health.service']]
    assert not (root/'opt/codexbridge/current').exists()
    assert not list((root/'opt/codexbridge/releases').iterdir())
    print('PASS: 10 installed payloads byte-identical, requested root:root ownership, actual modes, existing config preservation, no application activation; systemctl mocked.')
    print('Ownership is asserted as install arguments only; no privileged ownership change was attempted.')

```
