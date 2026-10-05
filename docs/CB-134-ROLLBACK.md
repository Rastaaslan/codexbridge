# Durable v1 → v4 rollback (updater contract 2)

Implemented from exact candidate `c19b3560df68a5983eba00b33e5b3c9040428434`.
This supersedes the refusal decision in CB-92. No production installation is
changed by this commit. Install the reviewed contract-2 runner **and legacy bootstrap shim, plus the service
unit with its ExecStartPre guard and Node --import hook** in a separate administrator maintenance window
before requesting this release. The application cannot update its installed
runner. Node 24 provides SQLite and hashing; Debian's `/usr/bin/flock` (util-linux)
serializes updater/recovery processes and releases its lock on process death.
The installer checks this dependency. No npm modules or SQLite CLI are needed by
snapshot/recovery code.

## Persistent state and exclusion

`src/cli.ts` opens `dataDir/codexbridge.db` before exposing health; `Store` enables
WAL and migrates in its constructor. The migration-owned persistent set is the
main database plus `codexbridge.db-wal` and `codexbridge.db-shm`. Capture records
both presence and absence, preserving exact bytes, including uncheckpointed WAL.
A disposable copy is opened with Node SQLite to check source schema and integrity;
the source and immutable snapshot are never opened by SQLite during capture.

Configuration, secrets, Codex home, logs, job worktrees, repository state and
release manifests are not migration-owned and are not overwritten. No worker or
integration may be active: the existing strict maintenance/quiescence gate still
runs before stop. The existing narrow control wrapper requests stop; the runner
then waits for **both** app and tunnel units to report inactive/failed with zero
MainPID and ControlPID. The unit uses KillMode=control-group. Snapshot and restore
assume the managed service is the sole database writer; manual DB writers or
administrator starts during a transaction are unsupported. The startup guard
rejects an incomplete capture/restoration or failed rollback before any Store
opener. Boot recovery checks exclusion without sudo or requesting a dependency
cycle. Live recovery stops services again.

## Exact deployed-source bootstrap

The deployed source is pinned to **3a99deafb510a893e607204f3add8805599c69e7**.
Its original policy is `{"runtimeSchema":1}`, its Store refuses `user_version > 1`,
and it has `jobs_overview` but no `operational_summary`. Those omissions are not
interpreted as compatibility for arbitrary releases. The installed updater derives
schema 1 only for this audited commit, verifies Git HEAD and the original manifest,
checks committed source/package/compiler-policy blobs without running Git filters,
and verifies SHA-256 of all 13 compiled JS modules. The hashes are the reproducible
TypeScript 5.9.3 output using the historical locked compiler and tsconfig. A stale
or modified build fails closed. Neither original policy nor release.json is edited.
The cold snapshot independently checks SQLite user_version and integrity.

Audit of ancestry: `3a99dea` has one parent, `316664ab48bb11c48aeccd060b83e9790f4b55bf`,
which follows merge `7a153e8010ff577f00a23b208222d444f265bac7` (parents `528a1a1`
and `1ce2887`). Both merge parents have the same Store/orchestrator/API source as
the merge. The two later hotfixes change `src/codex.ts`: trusted-worker approval,
network/cache/common-Git-dir access, then linked-worktree Git-dir access. They do
not add the missing quiescence API or migrate SQLite. Because these permissions
matter, no ancestry-wide or “missing schema means v1” exemption is allowed.
The parent commits, bb4c0d1 and e15141d are **not** authorized bootstrap targets.

`scripts/legacy-bootstrap.mjs` is installed root-owned beside the updater and
loaded with Node `--import` by the reviewed unit. For the pinned v1 release it
instruments the real historical Orchestrator/GitWorkspace promises; it does not
replace Store or forge a modern HTTP API. It tracks admitted HTTP requests and
async API/Git work, the live worker map, ticking/restarting/stopping state, active
statuses and persisted live child PIDs. While maintenance exists, it freezes new
HTTP admissions except the original authenticated doctor, and blocks direct new
create/action/report calls. Startup recovery remains allowed and counted.
The audited source has no integration subsystem. A private mode-0600 Unix socket
reports the strict quiescence shape, bound to the source commit and server.lock
PID. The updater also requires that PID to equal systemd MainPID and enumerates
the service's cgroup-v2 descendants: only the main process may remain. Persisted
job counts alone never authorize stopping/snapshotting. Modern releases retain
their own operational_summary path; a failed API never enables a legacy fallback.

### Separate administrator installation prerequisite (not performed here)

Before requesting this upgrade, use the existing reviewed installation window:
no pending updater/recovery transaction; stop new clients, drain active jobs and
verify that no worker descendants remain. Hold administrator-owned maintenance
while installing the reviewed runner, bootstrap shim, service startup guard and
`--import` wiring. Start **the same original v1 release** with the hook, not the
candidate; validate its original doctor and identity before releasing only the
administrator's own marker. If runtime hash verification fails, rebuild only the
exact historical checkout with its locked compiler in that separate reviewed
window; never bypass verification or patch its metadata. Existing quiescence,
maintenance ownership, updater-version and stop gates still apply when an update
is requested; resumed work makes the request fail safely.

The installed runner offers read-only `--bootstrap-preflight` (as the service
account): it verifies exact source/build identity, authenticated source doctor,
bridge PID and cgroup evidence. It reports `activationPermitted: false` because
transaction-owned maintenance, strict quiescence, stop and durable capture are
still required. Do not run the candidate CLI against v1 data merely to obtain a
preflight: its Store constructor would migrate. Missing shim/socket, wrong PID,
modified code, unsupported cgroups or unrelated maintenance remains a blocker.
The cold-stop gate verifies both loaded ExecStartPre and the ExecStart import hook.

## Durable boundaries

1. Build, validate source/candidate metadata and updater compatibility, publish
   transaction-owned maintenance, and prove quiescence.
2. Fsync journal `snapshotting` before stop. Create a transaction-named staging
   directory `rollback-snapshot.init-<UUID>` and fsync the parent. Write/fsync
   `owner.json` there, then rename to the single canonical snapshot slot and
   fsync the parent before copying/fsyncing SQLite files. Publish a synced
   manifest containing transaction UUID, source release path/commit/runtime and
   SQLite schema, candidate path, ordered file inventory and SHA-256 hashes.
3. Fsync journal `activating` with manifest SHA-256 before replacing `current`.
   Start candidate; its normal Store can migrate to v4. Maintenance remains held.
4. On failure, fsync `restoring`, stop/prove exclusion, verify the whole snapshot
   and source identity before any live write. Fsync temporary files, atomically
   replace each SQLite file (remove sidecars recorded absent), fsync parent after
   each change. Keep snapshot immutable. Switch to source release, fsync
   `boot_pending_health`, restart and check source-release identity and health.
5. Fsync terminal `completed` or `rolled_back` before releasing maintenance and
   retiring evidence. Rename the owned snapshot slot to a transaction-specific
   discard directory, fsync parent, remove discard and fsync again. Recovery
   finishes terminal cleanup; at most one snapshot can be captured. Unrelated or
   ambiguous evidence blocks capture/cleanup, never gets silently overwritten.

Process death during `snapshotting` means no activation was authorized: boot the
unchanged source under maintenance and validate it before cleanup. Death after
activation intent or during any file replacement repeats restoration from the
verified immutable set before startup. Multi-file replacement is not atomic;
startup exclusion plus durable intent makes it recoverable. Missing, corrupt or
wrong-transaction evidence blocks restoration/startup. An interrupted terminal
cleanup never triggers rollback. An initialization directory is reserved by the
already-durable journal UUID, so death before or during owner publication permits
cleanup of that exact staging path after source health succeeds. The canonical
slot is never published without a synced owner. Foreign staging paths are not
removed; an ownerless canonical slot still fails closed. Discard directories are
also named by the journal UUID, so partial recursive deletion (including loss of
owner.json) can be retried without confusing it with live rollback evidence.
Fsync ordering assumes a local filesystem and
storage that honor fsync and atomic rename; tests simulate process death at these
boundaries, not physical disk failure.

## Validation scope

Disposable tests create WAL-only committed v1 data, run the real v4 Store
migration, fail candidate health, verify byte-exact restoration before opening
with a v1-compatible SQLite reader, and validate original rows/schema. They cover
capture publication, activation intent/switch/migration, each restore file,
terminal commit, corruption, missing evidence, competing maintenance, stopped
service evidence and successful v4 activation. The historical test checks out and
builds **3a99deafb510a893e607204f3add8805599c69e7**, then runs its actual CLI,
HTTP routes, doctor and Store. Original metadata is left unchanged. A real
historical Store write is committed to WAL; the idle fixture service is killed
without checkpointing to prove DB/WAL/SHM preservation. Candidate migration is
performed with the real current Store; failed health restores bytes before the
original v1 CLI restarts and validates source health. Config, credential, job,
thread, feedback and worktree sentinels survive. Separate cases reject live
worker promises, surviving child PIDs and admitted operations even when original
jobs_overview reports zero running jobs. Only external Codex authentication and
systemd/cgroup service boundaries are test doubles; no production service is
executed. Existing worker/Git/recovery tests remain part of
the full suite. An actual installation still requires the documented reviewed
administrator wiring procedure and its existing health/quiescence gates.

## Local validation results

- `npm ci --ignore-scripts --no-audit --no-fund`: passed.
- `TMPDIR="$PWD/.test-tmp" npm run check`: TypeScript build and all 192 tests
  passed (zero failures/skips); this runs `npm run build` and `npm test`.
- `TMPDIR="$PWD/.test-tmp" npx tsx --test tests/update.test.ts tests/legacy-update.test.ts tests/recovery.test.ts tests/readiness.test.ts tests/deployment.test.ts tests/health-policy.test.ts`:
  all 80 focused tests passed.
- `npm run audit:publication`: passed, no findings.
- `npm audit --audit-level=high`: passed, zero vulnerabilities.
- Prettier checks on changed JS/TS/JSON/Markdown, shell syntax checks on installer
  and control wrapper, and `git diff --check`: passed.

Tests run entirely in disposable worktree-local directories; service operations
are injected test doubles. No live systemd, updater installation, sudo, release
activation, external publication or production-state mutation was performed.
