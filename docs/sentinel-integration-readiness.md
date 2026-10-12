# CB-189 integration readiness — isolated handoff only

Review iteration 3 found no implementation issues and explicitly accepted HTTP
validation as deferred after sandbox EPERM. The isolated implementation is
complete and ready for reviewer/operator handoff; transport validation remains
a future preflight item, not an implementation failure. No HTTP success is
claimed, and no denied socket operation was retried.

Final confirmation after that review used serial nice 19 / idle-class ionice
execution. Before tests: load 1.18, 8454 MiB available, CPU/memory pressure
avg10/avg60 zero. The base remained
`d9eb49dafce6d86eccc7457a80139a6d2b106f7e`. No implementation code changed.

```sh
TSX_DISABLE_CACHE=1 nice -n 19 ionice -c 3 node --import tsx --test --test-isolation=none --test-concurrency=1 --test-reporter=spec tests/sentinel.test.ts
TIMEFORMAT='elapsed=%3R s'; time nice -n 19 ionice -c 3 node node_modules/typescript/bin/tsc --noEmit
```

Both exited 0: all nine core tests passed in 588.06 ms, including the disk-backed
restart test; TypeScript validation took 1.976 seconds. The 20,000-token fixture
seed took 40.44 ms and its first bounded observation took 1.08 ms. Both query
plans still used bounded INTEGER PRIMARY KEY searches. The earlier failed HTTP
attempt and its exact command remain recorded below as deferred evidence.

The accepted Sentinel implementation is unchanged by this final validation pass.
The added HTTP smoke fixture is ready for an environment that permits loopback
sockets, but genuine HTTP acceptance remains **unverified** here: the sandbox
denied the first bind. No permission escalation or alternate transport was tried.
The nine deterministic core tests and TypeScript validation still pass.

## Candidate identity and production boundary

- [x] Worktree HEAD/base verified with `git rev-parse HEAD`:
      `d9eb49dafce6d86eccc7457a80139a6d2b106f7e`.
- [x] Candidate is the uncommitted patch in this same CB-189 worktree. There is
      no candidate commit SHA yet; the trusted integrator must assign and verify it.
- [x] No commit, merge, push, install, self-update, release activation, service
      restart, approval action, or production configuration/database access occurred.
      The supplied loaded-release identity is the same SHA as the base. It was not
      re-probed during this pass, so this report does not assert a fresh runtime SHA
      measurement. This task made no change to the loaded production release.
- [x] No WorldPrep, Director, Crafty, MapDev or Minecraft runtime was touched.

Implementation SHA-256 fingerprints at handoff:

```text
792c305d068c4242dd2d5bbca86c4c6bcd9ff6208e3761fda962cfbb9b86ed64  src/config.ts
606fcd28c3bf826ae6daf86512335ddcf8b12ff99a92a72ce32c53468b41f68b  src/orchestrator.ts
a882026442a053351a92d4f5c130ad5b455b9837cfd15fa7d75e60aa9e7fd2fd  src/tools.ts
fe648cd95b839e4b17c181663ba4c2ccaf5732b024bca15516f89699af6d2442  src/sentinel.ts
```

## Evidence from this pass

Before any tests, load was 0.54, available memory 8507 MiB, and CPU/memory
pressure avg10/avg60 were zero. All shell operations ran serially under
`nice -n 19 ionice -c 3`. Snapshots do not establish that WorldPrep is idle.
No install, emitted build, broad suite, browser, worker, or external request ran.

The first command below was run once, before the HTTP test was made opt-in:

```sh
TSX_DISABLE_CACHE=1 nice -n 19 ionice -c 3 node --import tsx --test --test-isolation=none --test-concurrency=1 --test-reporter=spec tests/sentinel-http.test.ts
```

Exit 1, 470.82 ms total; bind failed in the fixture after 24.37 ms:

```text
Error: listen EPERM: operation not permitted 127.0.0.1
code: EPERM; errno: -1; syscall: listen; address: 127.0.0.1
```

This was an attempted real HTTP test, **not** a successful end-to-end test and
not an in-process authenticated-handler test. No HTTP assertion ran: 401,
authenticated 200, enabled capture, stable reads, and HTTP restart behavior
remain unverified through the transport. Cleanup stopped the disposable core,
closed its SQLite connection and removed its worktree-local directory. The
embedded Express auth middleware has no readily available standalone handler;
no production-code refactor or private-router emulation was introduced.

The fixture now requires `CODEXBRIDGE_TEST_SENTINEL_HTTP=1` so an ordinary test
run cannot implicitly request socket access. It was not retried after denial.
The exact command for an operator in an authorized isolated environment is:

```sh
CODEXBRIDGE_TEST_SENTINEL_HTTP=1 TSX_DISABLE_CACHE=1 nice -n 19 ionice -c 3 node --import tsx --test --test-isolation=none --test-concurrency=1 --test-reporter=spec tests/sentinel-http.test.ts
```

It binds only `127.0.0.1`, requests port 0, generates synthetic random tokens,
and creates tiny fixture databases beneath its working directory. It uses
`createApp`, `Orchestrator.stop`, Store and Sentinel; it never starts the
scheduler or workers. Assertions cover absent/invalid [REDACTED],
default-off/no checkpoint, sanitized enabled observation using the real debounce,
stable repeated reads, and cursor/summary/job/event preservation on normal
fixture shutdown and reopening. A denied bind is fatal without any retry.

Concise regression check (run once in this pass):

```sh
TSX_DISABLE_CACHE=1 nice -n 19 ionice -c 3 node --import tsx --test --test-isolation=none --test-concurrency=1 --test-reporter=spec tests/sentinel.test.ts
TIMEFORMAT='elapsed=%3R s'; time nice -n 19 ionice -c 3 node node_modules/typescript/bin/tsc --noEmit
```

Both exited 0: core tests 9/9 in 655.38 ms; TypeScript in 1.969 seconds.
The synthetic 20,000-token seed took 40.14 ms and its first observation 0.98 ms.
Core tests exercise the canonical read-only tool directly, not HTTP auth.

## Operator checklist — future actions, not executed or authorized here

- [ ] Review this patch and the [Sentinel behavior/limits](sentinel-mini.md).
      Close the HTTP evidence gap with the opt-in fixture in a permitted environment.
      Reconfirm WorldPrep priority and host pressure before any discretionary work.
- [ ] Trusted integrator records the exact integrated candidate SHA and obtains
      required review/integration approval. Any deployment and subsequent enabling
      require separate explicit human/operator authorization.
- [ ] Operator re-verifies the actual loaded release, schema-v4 compatibility,
      installed updater/startup-guard requirements, healthy rollback baseline and
      quiescence through the existing [operations preflight](operations.md) and
      [recovery procedure](MIGRATION.md). Preflight success is not activation approval.
      Do not change other workloads to make room for this optional feature.
- [ ] Before authorized activation, retain the current release and a verified
      restorable backup of configuration and SQLite state using the established
      operator procedure. A live WAL database requires SQLite's consistent backup
      mechanism or a coordinated cold snapshot including required WAL state; copying
      only the active main DB file is insufficient. Record backup location, checksums
      and restoration ownership without exposing credentials in this worktree.
- [ ] Use the existing transactional release/rollback workflow, not a new Sentinel
      deployment path. On failed health validation restore the compatible prior
      release and configuration; retain maintenance on failed rollback. Restore a
      database snapshot only under the established operator recovery procedure,
      accounting for any jobs/events created after the snapshot.
- [ ] Deploy with Sentinel disabled first and validate normal operation. Only
      after deployment and separate enablement approval, set `sentinelEnabled: true`
      through the normal operator configuration/restart workflow. First enablement
      starts durably at the current journal tip and excludes earlier history. Verify
      authenticated `get_sentinel` and a separately authorized fixture transition.
- [ ] To disable later, use the normal authorized configuration/restart workflow;
      retain the checkpoint. Before rollback to the old strict config parser, remove
      `sentinelEnabled` from its configuration. There is no SQLite schema migration;
      old release code ignores the namespaced settings row. The previous unshipped
      Sentinel implementation cannot read the new checkpoint fields and fails closed.

The observer retains only the newest 100 summaries. It scans bounded replay and
recent-tail windows; an event buried beneath more than 4096 later entries can
await ordered replay. `replayPending` exposes that gap, which is preserved across
restart. Neither this checklist nor a successful local fixture is authorization
to deploy, enable, approve jobs, or perform autonomous actions.

