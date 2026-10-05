# CB-92 cross-schema rollback decision

Historical decision, superseded by [CB-134 contract 2](CB-134-ROLLBACK.md).

Reviewed base: `9058f0c4498a8fff118c83265e260d9834cdad74`.

**Keep v1 → v4 self-update forbidden.** Updater contract 1 cannot establish
safe cross-schema rollback within its existing lifecycle and journal contract.
This change makes the rejection explicit and adds executable counterexamples
and regression coverage. It does not implement snapshots or authorize rollout.
The release policy and `UPDATER_VERSION` remain 1; same-schema v4 behavior is
unchanged.

## Concrete evidence

- `src/config.ts` derives `dataDir` from `CODEXBRIDGE_HOME`.
  `src/cli.ts` opens `dataDir/codexbridge.db` using `Store` before startup
  recovery and before exposing health endpoints. `src/database.ts` enables WAL
  and commits migrations through `user_version=4` in its constructor.
  Maintenance does not guard that constructor. A failed first health check can
  therefore occur after migration has already committed.
- `scripts/self-update.mjs` obtains scheduling quiescence from
  `operational_summary`, but never closes SQLite or stops the old service before
  activation. The focused WAL test keeps an actual SQLite connection open,
  checkpoints a schema-v1 fixture, then commits a row to WAL. Copying just the
  main database yields zero rows while the source has one. It also runs the real
  candidate `Store` constructor under maintenance and observes schema 4. The
  fixture models the v1 tables needed by these migrations; it is not a claim to
  have executed a historical v1 binary.
- `deploy/debian/codexbridge-control` accepts `stop`, but uses
  `systemctl --no-block`: successful command completion is not evidence of an
  exited service or closed database. Normal rollback switches the symlink and
  requests restart; it has no stop-and-prove-exclusion phase. Copying a main DB,
  WAL and SHM sequentially while a writer/checkpointer remains open cannot
  establish one atomic database generation. Renaming a database beneath an open
  SQLite connection also leaves the old inode accessible to that connection.
- The boot recovery unit is ordered before the orchestrator, but live recovery
  uses the same restore operation without that ordering. Boot recovery has
  `NoNewPrivileges=true`, unlike the updating unit; adding a privileged stop
  command to the shared restore path is not a valid lifecycle solution for both.
  The current boot ordering protects code selection, not a partially restored
  multi-file database. A later health failure retains maintenance but cannot
  reconstruct pre-migration bytes.
- The durable journal records release paths, phase, ref, time and health/reason.
  It contains no snapshot identity, source database/schema binding, integrity
  evidence, completed snapshot publication, restore intent or restore progress.
  `restore()` only validates the target and atomically replaces `current`.
  No pre-activation bytes can be reconstructed from that journal after migration.
  Accepting legacy restore targets without a snapshot would therefore run old
  code on migrated data. Interrupted restoration cannot be made idempotent by
  reusing the existing release-only journal semantics.

These are limits of the **existing contract**, not a claim that SQLite backup
is intrinsically impossible. A safe implementation requires a new reviewed
lifecycle/recovery contract: prove and maintain writer exclusion before capture
and throughout restoration, publish a synced SQLite-consistent snapshot bound
to the transaction, durably journal its identity and integrity, preserve it
through every retry, and recover partial restoration before permitting any DB
opener. The installed root-owned runner is outside application releases;
application self-update cannot install this contract. That change needs a new
updater version and a separately validated administrative installation procedure.
No units, wrappers, infrastructure or installed runner were changed here.

## Fail-closed coverage

`tests/update.test.ts` now additionally verifies:

- A fully consistent schema-v1 release policy/manifest is rejected before
  quiescence or service commands, both through transaction and direct activation.
  Repeated attempts preserve main DB, WAL, SHM, config and job-worktree bytes.
- Inherited `activating`, `rollback_failed` and `boot_pending_health` journals
  targeting v1 fail repeatedly in boot and live recovery. The current symlink,
  DB and journal remain unchanged, and updater maintenance remains held.
- Restore failure records `rollback_failed` without restarting or releasing
  scheduling. Failed post-boot application health retains maintenance.

Existing tests cover same-schema successful activation, failed-health rollback,
boot restoration, damaged outgoing metadata, unrelated maintenance ownership,
updater-version rejection, and process interruption before/after atomic
maintenance publication. Snapshot/restore interruption tests are not claimed:
there is no snapshot/restore implementation and cross-schema activation cannot
reach such a phase. The safe outcome is refusal before any migration.

All experiments use disposable fixtures and stub service operations. No
production database, credentials, services, remote refs or infrastructure were
accessed or changed.

## Local validation

- `npm ci --ignore-scripts --no-audit --no-fund`: passed.
- Initial `npx tsx --test tests/update.test.ts`: could not start because this
  environment has no usable `/tmp` (`ENOENT` creating `/tmp/tsx-997`). Retried
  with a disposable worktree-local temporary directory.
- `TMPDIR="$PWD/.test-tmp" npx tsx --test tests/update.test.ts`: 36 passed,
  zero failed or skipped.
- `TMPDIR="$PWD/.test-tmp" npm run check`: TypeScript build passed; all 162
  tests passed, zero failed or skipped. This includes the full `npm test` suite.
- Prettier checks on changed files and `git diff --check`: passed.
