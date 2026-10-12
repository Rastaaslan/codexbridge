# Sentinel Dev V1.1 — guarded submission

The original isolated-slice handoff below is historical. The subsequent authorized
[host wiring and validation](sentinel-wiring.md) supersedes its statements that
no constructor/config/dispatch wiring exists. Production remains disabled and
requires protected services; no live activation occurred.

CB-191 imports the exact 13-file CB-190 uncommitted patch on base
`d9eb49dafce6d86eccc7457a80139a6d2b106f7e`. The SHA-256 import manifest is
[sentinel-executor-provenance.txt](sentinel-executor-provenance.txt). CB-190 and
CB-189 remain unchanged. V1 planning behavior is retained.

`SentinelExecutor` is an implemented, tested, dependency-injected action service,
not a new scheduler. **It is not instantiated or invoked by normal startup or
scheduler ticks.** There is no execution config flag or write endpoint. An absent
`enabled` option causes no Store, planner or adapter IO. `dryRun` also performs no
actions or writes; existing `get_sentinel_dev` supplies read-only decisions.
`get_sentinel_dev_actions` is the canonical read-only action status endpoint. It
returns disabled unless a trusted host explicitly attaches an executor. Reads
never reconcile, reserve or submit jobs.

## Gates and integration contract

A trusted host must separately enable execution and provide an authenticated,
operator-controlled `authorize(taskId)` provider. Its grant must specify
`permission: "automatic-code-fix"`, one nonempty task ID, whole-policy hash,
exact canonical repository path, Git source ref, 40-hex commit, source-provenance
SHA-256, ticket SHA-256, and future expiration. Manual permission, policy
`approvedBy`, event prose, reviewer acceptance and token events confer no
execution authority. The policy itself is limited to code-fix tasks. Approval
of the fixed ticket is the semantic code-only boundary; this service does not
infer safe intent from arbitrary ticket prose.

The grant is fetched twice, before reservation and before submission.
`gitSourceVerifier` uses the existing GitWorkspace repository/ref/commit
verification and compares protected provenance against the grant's digest. The
protected provenance document has exactly `repository`, `baseCommit`, and
`sourceRef`; compatibility approval and its secure storage belong to the trusted
operator service. Do not read provenance from worker-controlled files or build
a production verifier that merely echoes policy values. Providers must bound
their IO and reject missing/unavailable authorization. No credentials are stored
or returned in action reports; arbitrary provider errors are replaced by a
fixed stage-specific blocker.

Every dependency must currently be COMPLETED, and a freshly ticked V1 planner
must report the matching ready decision. Every nonempty runtime evidence
requirement **still blocks**: this slice has no trusted evidence ingestion and
never accepts manually fabricated evidence. In particular, the existing
WorldPrep fixture stays disabled, source-null and evidence-blocked. Ticket-
reported CB-187 human-test, CB-188 missing runtime proof and CB-186 failure are
not reinterpreted as approvals.

`coreCreatePort(core)` binds the existing `Orchestrator.create` API. It requires
`maxRuntimeRetries === 0` both before preparation and immediately before
insertion; it never changes configuration. The optional synchronous core-create
guard runs after asynchronous Git preparation and before Store.create. It checks
the actual resolved canonical repository and commit against the approved input,
then rechecks dependency state, admission and expiration. Default API calls do
not supply a guard and retain existing behavior. Created jobs pin `startRef` to
the approved SHA and use one code iteration, fixed ticket, dependencies and
existing unique idempotency keys. Scheduler execution remains canonical.

Git refs and operator revocation cannot be locked atomically with SQLite by this
isolated adapter. The host must serialize source/authorization changes with
submission if it requires strict freshness through the insertion boundary;
immutable commit pinning prevents a changed branch from silently selecting new
code. This host coordination and trusted authorization storage are **not
implemented or activated here**. Do not wire live execution until they are
reviewed. The disposable API test injects Git and suppresses worker scheduling;
no real worker execution is claimed.

## Durable attempts and conservative recovery

One settings row per canonical repository (not per editable policy ID) holds at
most ten attempts. Store's BEGIN IMMEDIATE transaction serializes reservation,
cap, concurrency-one and cooldown checks. The reservation commits before any
submission. An occupied, failed, human-blocked or ambiguous prior attempt blocks
new work. Successful prior jobs must complete, and the cooldown must elapse.
Policy edits cannot reset the lane budget; old-policy attempts conservatively
require investigation rather than silently becoming new grants.

The key matches the V1 policy/task decision hash. Repeated and overlapping calls
cannot create another job. Reconciliation uses the existing indexed unique
`jobs.idempotency_key`, with exact job-input checks. A crash after a durable job
insert reconciles the reservation without calling create again. A crash before
insert leaves an ambiguous reservation that is **never automatically retried**.
It requires operator investigation; no reset/delete endpoint is included.

Ordinary pre-reservation lane occupancy and cooldown return a deferral without
halting the instance. A later externally dispatched run revalidates all gates;
there are no timers or automatic retries. Failed/human-blocked jobs, unresolved
reservations, authorization failures and submission errors still halt the
instance and return a concrete safe blocker. Reserved
attempts survive restart and consume capacity. Reports show unresolved
reservations even after restart; transient error text itself is not a durable
journal. There are no event listeners, timers, retries, approval/integration
calls or worker invocations. The normal scheduler is not coupled to this
service's failures. Ledger checks are bounded by ten rows, with at most ten
dependencies per task. Read-only status after a storage failure also fails closed.

## Minimal future host workflow (not production activation)

1. Review code-only task tickets, dependencies, source compatibility and actual
   evidence through existing operator workflows. Keep required evidence gates;
   their ingestion remains a separate implementation prerequisite.
2. Supply authenticated, protected grant/provenance providers and admission
   checks. Require exact repository allowlisting, no automatic runtime retries,
   and serialized source/authorization updates. Do not derive grants from the
   policy or expose grant creation to an untrusted caller.
3. The trusted host can construct and attach an executor explicitly:

   ```ts
   core.sentinelExecutor = new SentinelExecutor(
     core.store,
     core.sentinelDev,
     validatedPolicy,
     {
       authorize: protectedAuthorizations.readAutomaticTaskGrant,
       verifySource: gitSourceVerifier(core.git, protectedProvenance.read),
       schedulerAllows: trustedAdmission.allows,
       create: coreCreatePort(core),
     },
     { enabled: true, repositories: approvedExactPaths },
   );
   // Trusted host dispatch, not an MCP write endpoint or a second scheduler:
   await core.sentinelExecutor.run(operatorApprovedTaskId);
   ```

4. Inspect `get_sentinel_dev_actions {}`. Never automatically clear a reservation
   or retry a failed action. Production host dispatch remains unwired in CB-191.

The example names protected host services that are intentionally not supplied by
this patch. Tests instead use entirely synthetic grants, repositories and
Stores. No live authorization, configuration, source, database, server process,
WorldPrep job or runtime evidence was created or changed.

## Validation and review

All commands run serially with `nice -n 19 ionice -c 3`. Before nontrivial work,
CPU/memory/IO PSI, MemAvailable and load were checked. Samples remained below the
required thresholds. Dependencies were reused read-only through a temporary
CB-191 node_modules symlink to CB-189, with explicit user authorization; no
install or network operation occurred. The link is removed before handoff.

Commands and final outcomes are recorded below after final validation. The first
test pass returned exit 1: 25 passed, one optional real-Git fixture failed at
`spawnSync git EPERM`, and HTTP was skipped. No workaround or retry was attempted.
That Git fixture is now explicit opt-in (`SENTINEL_EXECUTOR_GIT_TEST=1`) and also
skips if its initial Git spawn is prohibited. It was not enabled again here.
Injected Git verification tests cover canonical path/ref/commit/provenance
mismatches without spawning Git. The real core.create method is tested with an
injected Git adapter and disposable SQLite Store, including dependency/path
drift during asynchronous preparation, pinning and scheduler invocation.

Independent read-only review covered authorization, duplicate protection and
crash modes. Reviewer requested direct cap/verifier tests, runtime-retry gating,
and insertion-time dependency/source checks; these were implemented with
regressions. Reviewer did not execute tests. Real Git API integration, HTTP,
live execution, protected authorization/evidence ingestion and production host
coordination remain unvalidated or deliberately absent as described above.

Final commands and actual results:

```sh
TSX_DISABLE_CACHE=1 nice -n 19 ionice -c 3 node --import tsx --test --test-isolation=none --test-concurrency=1 --test-reporter=spec tests/sentinel-executor.test.ts tests/sentinel-dev.test.ts tests/sentinel.test.ts tests/sentinel-http.test.ts
# exit 0: 35 passed, 0 failed, 2 optional skipped; 1164.17 ms
nice -n 19 ionice -c 3 node node_modules/typescript/bin/tsc --noEmit
# exit 0
nice -n 19 ionice -c 3 node node_modules/prettier/bin/prettier.cjs --check src/config.ts src/orchestrator.ts src/tools.ts src/sentinel.ts src/sentinel-dev.ts src/sentinel-executor.ts tests/sentinel.test.ts tests/sentinel-dev.test.ts tests/sentinel-executor.test.ts tests/sentinel-http.test.ts docs/sentinel-mini.md docs/sentinel-dev.md docs/sentinel-executor.md docs/sentinel-integration-readiness.md fixtures/sentinel/worldprep-policy.json
# exit 0
nice -n 19 ionice -c 3 git diff --check
# exit 0
```

Final independent review: **ACCEPT for the isolated, unwired scope**, no remaining
blocking findings. This does not authorize production activation. Full heavy
suites were not run. Final pre-test sample: CPU/memory PSI avg10 0%, IO full
avg10 2.31%, MemAvailable 7,569,792 KiB, load 0.29 / 0.47 / 0.44.

## Review iteration 2 — resumable deferrals

Normal lane occupancy and cooldown now use a distinct pre-reservation deferral.
The same executor can revalidate on a later external dispatch without timers,
self-dispatch or service reconstruction. Unresolved reservations and failed or
human-blocked jobs remain fatal, as do adapter failures. A regression exercises
one instance through first submission, occupied-lane deferral, completion,
cooldown deferral, and exactly one second submission. Another proves failed jobs
do not gain this resumable behavior. Existing failed-adapter/no-retry tests pass.

The focused test command above was rerun: exit 0, **37 passed, 0 failed, 2
optional skipped**, 1644.18 ms. TypeScript `--noEmit` and `git diff --check` were
rerun unchanged, both exit 0. Formatting validation was:

```sh
nice -n 19 ionice -c 3 node node_modules/prettier/bin/prettier.cjs --check src/sentinel-executor.ts tests/sentinel-executor.test.ts docs/sentinel-executor.md
# exit 0
```

Pre-check resource sample: CPU/memory PSI avg10 0%, IO full avg10 3.88%,
MemAvailable 7,589,040 KiB, load 0.81 / 0.60 / 0.49. The authorized read-only
CB-189 dependency link was reused temporarily, without installation or network.

Independent read-only review of iteration 2: **ACCEPT**; no blocking findings.
Reviewer did not rerun tests. Temporary dependency link removed after checks.

