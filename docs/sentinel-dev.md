# Sentinel Dev V1 — isolated planning slice

Default off. This adds a validated `sentinelDevPolicy` config field and the
read-only `get_sentinel_dev {}` tool. No executor, approval writer, worker, shell,
LLM call or automatic job creation is connected. Existing scheduler ticks invoke
the planner; Mini remains the only journal observer. Reads do not process work.
The scheduler and CodexBridge workflow remain authoritative.

## Provenance and boundary

The eight CB-189 files were read and copied exactly from the accessible sibling
worktree. Both HEADs were `d9eb49dafce6d86eccc7457a80139a6d2b106f7e`, source branch
`codexbridge/CB-189`. Its patch was uncommitted; the four implementation hashes
matched its accepted handoff document. All eight hashes are in
[sentinel-dev-provenance.txt](sentinel-dev-provenance.txt). V1 then added wiring
only to config/orchestrator/tools. Mini, both existing tests and both existing
documents remain byte-identical. The ticket reports a later user-run HTTP smoke
pass on 2026-10-12; preserved CB-189 documents predate that evidence. No fresh
HTTP success or loaded-release inspection is claimed here. No live config,
database, release, service or WorldPrep sources were changed. Dependencies are
read through a temporary local symlink to CB-189 node_modules, removed after
validation; no install ran.

## Governed WorldPrep lane

`fixtures/sentinel/worldprep-policy.json` is an optional, disabled template.
Repository is explicitly unverified and source is null. It cannot become ready
merely by toggling enabled. Context is supplied by this ticket, not newly queried
runtime evidence:

- CB-187: ready for HUMAN TEST, benchmark-only; no canonical runtime integration.
- CB-188: WAITING_FOR_HUMAN; runtime evidence absent; 13/13 targeted tests are
  reported, candidate speedup unproven.
- CB-186 Director: FAILED, iteration budget exhausted, runtime evidence absent.
- Canonical WorldPrep sources span CB-175/177/188; historic main/startRef
  `9d895ec` is stale. No base or attestation is inferred, and no worktrees combined.

The single conservative follow-up depends on all three jobs completing through
existing workflows, verified compatible source, and explicit runtime evidence.
Reports show each current dependency status separately even when source is absent.
No performance gain is claimed. Synthetic tests map these three reported states
to local fixture job IDs and run actual Store transitions without workers.

## Persistence and limits

A policy has at most ten code-fix tasks, ten dependencies and evidence requirements
per task, a fixed ticket with validated SHA-256, repository, nullable approved
40-hex base/provenance hash, budget, concurrency one and cooldown. Unknown keys,
duplicate task IDs and altered ticket hashes are rejected. Operator configuration
is the trust boundary; strings such as approvedBy are declarations, not verified
signatures. Event text cannot authorize anything.

Each scheduler pass consumes only Mini's newest 100 summaries and does at most
100 primary-key job reads. No event SQL, history scan, extra timers or listeners.
A ready candidate requires both observed completion and current workflow
completion; replay lag, unavailable observer, missing source, failed/human states
or required evidence block it. No attestation ingestion exists in this slice:
nonempty evidence requirements remain blocked. If a completion ages out of Mini's
bounded retention, the candidate conservatively blocks again. This is a planning
snapshot, not a complete historical development graph.

One namespaced settings row per policy fingerprint atomically stores cursor and
at most ten decisions. Unchanged snapshots do not write; stable policy/task keys
dedupe across restarts. Startup rechecks current state before exposing readiness.
Policy changes produce new fingerprints; retired policy rows require future
operator housekeeping. Database errors fail closed without interrupting jobs.
The cursor records Mini's replay progress, not a claim of consuming every event.

## From dry-run to future actions

After ordinary review/integration authorization, an operator may configure both
`sentinelEnabled: true` and an explicit enabled lane policy for **planning only**.
First Mini enablement starts at the current journal tip. This ticket does not
activate either setting. Obtain source repository/commit compatibility and hash
provenance from the canonical work before replacing the template's null source.
Resolve human tests and runtime evidence through their existing authorized flows.
Do not turn evidence requirements off to make this template advance.

`actionEligible` is a pure future adapter preflight: exact signed-off policy ID
and whole-policy hash, repository/base/provenance/ticket pins, fresh state and
approval checks, scheduler allowance, bounded budget/concurrency, cooldown and
existing idempotency all must pass. The mock test proves missing preapproval
cannot call its fake executor. These checks accept trusted service facts; they
are neither signature verification nor an execution lock.

Actual execution is deliberately deferred. A future trusted adapter must verify
signoff and source evidence, atomically reserve persistent budget/cooldown and
idempotency, recheck state/approvals/admission, and use existing create-job and
scheduler APIs. It must reconcile ambiguous submissions after crashes before
retrying. No current API/config can enable execution. Only code fixes/debug may
use Codex; mechanical checks belong to the service without LLM. Human approval,
integration/merge/push/deploy/self-update/restart, MapDev/Crafty access and arbitrary
ticket shell remain outside this adapter's authority.

## CB-190 validation and review

Entry sample: CPU PSI avg10 0%, IO full 1.61%, memory PSI 0%, available RAM
8,706,512 KiB, load 0.44. Before final tests: CPU/memory PSI 0%, IO full 0.60%,
RAM 8,699,600 KiB, load 0.68. Before final compilation: CPU/memory PSI 0%, IO
full 1.22%, RAM 8,710,536 KiB, load 0.56. All measured samples were under the
resource gates. No visible WorldPrep/APPLY/Gradle process was found; that is
not authoritative runtime-idle evidence. Only small serial tests ran.

Commands and actual outcomes:

```sh
TSX_DISABLE_CACHE=1 nice -n 19 ionice -c 3 node --import tsx --test --test-isolation=none --test-concurrency=1 --test-reporter=spec tests/sentinel-dev.test.ts tests/sentinel.test.ts tests/sentinel-http.test.ts
nice -n 19 ionice -c 3 node node_modules/typescript/bin/tsc --noEmit
git diff --check
```

Final targeted tests: exit 0, 17 passed, 0 failed, 1 HTTP test skipped (opt-in
unset), 795.66 ms. No socket bind was attempted. Final TypeScript check: exit 0,
1.91 seconds. Diff check: exit 0. Targeted Prettier check: exit 0.
The initial dev-only test run exited 1 (2 passed, 4 failed) because the synthetic
fixture used an invalid RUNNING status; the fixture was corrected to use actual
PREPARING/CODEX_RUNNING/REVIEWING/ACCEPTED transitions. Subsequent runs passed.

Independent read-only review verified all eight provenance hashes and accepted
the final **planning-only slice** after a diagnostic-overflow fix and maximum-input
test. Reviewer did not run tests. No outstanding review blocker; real execution,
evidence ingestion, integration and activation remain deferred as described above.

