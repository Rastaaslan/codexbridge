# Sentinel V1.1 host wiring — CB-191 continuation

The existing application now supports constructor-injected Sentinel execution.
`sentinelExecutionEnabled` defaults to false and is separate from the planner
policy. The ordinary CLI construction supplies no protected host services:
setting the flag alone leaves execution disabled with a blocker in the existing
read-only `get_sentinel_dev_actions` tool. No public write endpoint, grant writer,
policy-derived authorization, additional scheduler, or timer was added.

A trusted application host can pass a sixth `Orchestrator` constructor argument
implementing `SentinelHost`: exact canonical repository allowlist, protected
`authorize(taskId)`, actual source/ref/provenance `verifySource`, and admission
check. The optional `now` is for deterministic fixture clocks. Observer, policy,
and execution must all be explicitly enabled; runtime retries must be zero.
Missing or malformed services fail closed during construction. The existing
executor still requires exact automatic-task grants, ticket/policy/source pins,
expiration, evidence and dependency gates. All nonempty runtime evidence
requirements still block until protected ingestion is implemented.

```ts
// Trusted host code only; these services are prerequisites, not supplied here.
const core = new Orchestrator(config, store, git, adapter, reviewer, {
  repositories: approvedExactPaths,
  authorize: protectedAuthorizations.readAutomaticTaskGrant,
  verifySource: protectedSourceService.verifyPinnedSource,
  schedulerAllows: protectedAdmission.allows,
});
```

The verifier/service must serialize source and authorization changes with
submission where strict freshness across asynchronous preparation is required.
Core's final insertion guard checks the actual canonical path/commit,
dependencies, expiration and disabled runtime retries. There is no claim that
SQLite atomically locks Git refs or an external authorization service. No
production service implementation, grants or evidence were invented.

## Bounded dispatch and lifecycle

The existing Orchestrator event handler sets one dirty bit for lifecycle events.
Token/message output does not wake execution. The existing scheduler tick starts
at most one asynchronous pass; concurrent passes coalesce, and scheduler work
does not wait for protected-service IO. Providers must bound their own IO.
One earliest unsubmitted policy task is considered, using fresh Mini/Dev
readiness. A known cooldown deadline wakes on the existing cadence without a
new event. Occupied lanes wake on lifecycle changes. Mini restart catch-up
retains pending dispatch only while the observer has bounded replay work;
there is no recursive drain or perpetual idle polling.

Durable reservation/idempotency behavior is unchanged. Crash-after-insert
reconciliation finds the matching existing job without replaying create;
ambiguous reservations and failed submissions halt. Cancellation and abnormal
lane states cannot advance another job. Stop disables the dispatch capability
and its in-flight insertion guards. A stopped instance does not rearm execution;
restart uses a fresh Orchestrator with the same Store and revalidates grants.
Unexpected dispatch errors become a sanitized blocker without escaping into the
normal scheduler. A provider that never returns cannot create a busy loop or
hold up normal stop, although its promise remains the provider's responsibility.

## Validation boundary

The tested end-to-end fixture uses a disposable SQLite file and synthetic
repository directory **inside CB-191**, the real Orchestrator constructor,
event handler, dispatch, `core.create`, canonical scheduler, Store transitions,
and durable restart. Git operations, model worker, reviewer and review artifacts
are injected synthetic adapters; no Codex subprocess or Minecraft runs. The
fixture advances READY_FOR_HUMAN_TEST to COMPLETED solely as synthetic lifecycle
input, never through a human-approval endpoint or production job update.

Coverage includes two sequential granted tasks, dependency and cooldown delay,
noise coalescing, default-off and missing/malformed host, wrong/expired grant,
source mismatch, required evidence, disabled WorldPrep sample, cancellation,
stop during verification, crash after insertion, unexpected exceptions, and
restart with a 13,000-token persisted backlog. Existing executor/Mini/Dev tests
also run. This is **in-process integration**, not HTTP/MCP transport validation.

The previous real-Git attempt failed with `spawnSync git EPERM`. It was not
retried or bypassed. Optional disposable real-Git dispatch coverage is retained
under `SENTINEL_DISPATCH_GIT_TEST=1`; the earlier executor Git smoke and HTTP
smoke remain opt-in too. None was enabled in this continuation. The new real-Git
smoke is unvalidated here and still injects the worker/reviewer. Full validation
with a real disposable Git repository remains an external sandbox limitation.

## Integration preflight and remaining steps

- CB-190's 13 source hashes must remain equal to the imported manifest; base HEAD
  remains `d9eb49dafce6d86eccc7457a80139a6d2b106f7e`. No release compatibility or
  production health claim is inferred from these local checks.
- Before integration/activation, supply and review protected grant/provenance
  storage, source/revocation coordination, admission and bounded provider IO.
- Run the optional disposable Git and HTTP fixtures only in a separately
  authorized environment that permits them. No further sandbox attempt was made.
- Resolve real WorldPrep source provenance and runtime evidence separately.
  Its sample remains disabled/source-null/evidence-blocked, with the historical
  CB-187/188/186 human and failure states unchanged.
- Integration, deployment, live config changes, restart and any WorldPrep job
  creation are not authorized by this handoff and were not performed.

Checks were serial at `nice -n 19 ionice -c 3`, without installs or network. The
user-authorized CB-189 node_modules symlink was temporary and read-only. Resource
samples were below the stop thresholds; the final suite's entry sample had CPU
and memory PSI avg10 0%, IO full avg10 0.37%, MemAvailable 7,604,824 KiB, load
1.01 / 0.58 / 0.49. No heavy suites or production endpoints were exercised.

## Final commands and results

```sh
TSX_DISABLE_CACHE=1 nice -n 19 ionice -c 3 node --import tsx --test --test-isolation=none --test-concurrency=1 --test-reporter=spec tests/sentinel-dispatch.test.ts tests/sentinel-executor.test.ts tests/sentinel-dev.test.ts tests/sentinel.test.ts tests/sentinel-http.test.ts
# exit 0: 50 passed, 0 failed, 3 optional skipped; 2621.54 ms
nice -n 19 ionice -c 3 node node_modules/typescript/bin/tsc --noEmit
# exit 0
nice -n 19 ionice -c 3 node node_modules/prettier/bin/prettier.cjs --check src/config.ts src/orchestrator.ts src/tools.ts src/sentinel-dispatch.ts src/sentinel-executor.ts tests/sentinel-dispatch.test.ts docs/sentinel-executor.md docs/sentinel-wiring.md
# exit 0
nice -n 19 ionice -c 3 git diff --check
# exit 0
```

Final pre-check sample: CPU/memory PSI avg10 0%, IO full avg10 1.12%,
MemAvailable 7,583,800 KiB, load 0.83 / 0.74 / 0.56. All tests run during this
continuation passed. The earlier EPERM described above belongs to the original
executor validation, not a new attempt.

Independent read-only review: **ACCEPT** for operator-host wiring after fixing a
restart replay stall and adding its persisted-backlog regression. Reviewer did
not execute tests. Real Git/HTTP and protected production services remain
unvalidated prerequisites. CB-190's 13 imported source hashes were rechecked
unchanged; local HEAD still equals the baseline. The temporary dependency link
was removed after validation. No commits, integration or deployment performed.

## Review iteration 4 — wake after durable reconciliation

A successful reserved-to-submitted reconciliation now sets one dirty follow-up
on the existing scheduler cadence. Reconciliation itself emits no lifecycle
event, so this explicitly allows the next task to be considered after restart.
The transition is matched by ledger key; halted/stopped paths cannot schedule
it. The following pass clears dirty normally, retaining only a genuine cooldown
deadline or new lifecycle event. No timer, creation retry or idle loop was added.

A durable restart regression completes task 1 before restart while its ledger
remains reserved. Without any new external lifecycle event, it proves task 2
is submitted once for both remaining and already-elapsed cooldown. Subsequent
ticks do not add jobs or authorization calls. Existing ambiguous-reservation,
failed-adapter and cancellation tests remain green.

The five-file focused test command above was rerun: exit 0, **53 passed, 0 failed,
3 optional skipped**, 2629.77 ms. TypeScript `--noEmit` and `git diff --check`
were rerun, both exit 0. Targeted formatting checks also exited 0:

```sh
nice -n 19 ionice -c 3 node node_modules/prettier/bin/prettier.cjs --check src/sentinel-dispatch.ts tests/sentinel-dispatch.test.ts
nice -n 19 ionice -c 3 node node_modules/prettier/bin/prettier.cjs --check docs/sentinel-wiring.md
```

Pre-test sample: CPU/memory PSI avg10 0%, IO full avg10 0.59%, MemAvailable
7,590,852 KiB, load 0.19 / 0.54 / 0.52. Independent read-only review: **ACCEPT**;
reviewer did not execute tests. Authorized read-only dependency link removed
after checks. Real-Git/HTTP skips and production prerequisites remain unchanged.

