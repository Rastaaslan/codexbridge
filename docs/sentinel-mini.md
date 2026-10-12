# Sentinel Mini (V0)

For final isolated acceptance evidence and the future operator checklist, see
[integration readiness](sentinel-integration-readiness.md). The HTTP smoke test
was blocked by sandbox `listen EPERM`; no HTTP success is claimed.

Sentinel is an optional local lifecycle observer. `sentinelEnabled` defaults to
`false` in config.json. Disabled instances perform no Sentinel database access,
register no listeners and start no timers. This ticket does not enable it in any
running installation.

When enabled, Sentinel listens to the existing Store stream for
`JOB_READY_FOR_HUMAN_TEST`, `JOB_WAITING_FOR_HUMAN`, `JOB_FAILED` and
`JOB_COMPLETED`. Notifications coalesce into one pass after one second, outside
the job transaction. A 30-second unref'ed fallback catches missed notifications;
startup schedules one bounded catch-up pass. CODEX_MESSAGE/CODEX_OUTPUT never
schedule work or produce Sentinel logs/notifications.

First opt-in **observes new events only**: in one transaction it reads the
current `MAX(id)` through the existing primary key and durably saves that cursor
before registering a listener. It does not replay pre-opt-in history. For a journal
whose latest ID is 613044, the initial cursor is 613044, not zero. A restart before
the first tick preserves this starting point. Existing checkpoints, including the
previous V0 format, retain their replay cursor and summaries.

Each pass takes the current maximum ID and performs two bounded, typed reads:

- Ordered replay searches `(cursor, min(cursor + 4096, latest)]` for actionable
  types, returning at most 128 headers. If that limit is reached, the cursor moves
  only to the last returned event; otherwise it advances to the end of the window.
- When replay lags, a recent-tail search reads the latest 4096 ID positions beyond
  the replay cursor, returning the newest 100 actionable headers. This supplies
  fresh attention even when thousands or millions of token entries precede the
  latest lifecycle event. It does **not** advance the ordered replay cursor.

Both reads use the existing INTEGER PRIMARY KEY with explicit lower and upper
bounds. At most 8192 ID positions are examined per pass (fewer actual rows for
sparse IDs); at most 228 headers and 4096 characters of payload per selected
new actionable header are returned. No token payloads, full journal scans, new
indexes, migrations, recursive draining, or new infrastructure are involved.
Idle passes only check the maximum ID and do not acquire a write lock.

The existing `settings` table holds `sentinel:mini:v0`: the replay cursor, latest
sampled event ID, and newest 100 summaries sorted by event ID. These commit
atomically. Replay and tail overlap is deduplicated by event ID; older replay
cannot evict newer summaries. No per-job dedupe is used: distinct transitions
remain distinct even when they have the same status. Summary retention is bounded;
`job_events` remains append-only and untouched.

`replayPending` explicitly reports a gap between the ordered cursor and the
latest sampled ID. Tail sampling never discards that gap: subsequent bounded
passes replay it, including after restart. A lifecycle event followed by more
than 4096 other entries before observation can fall outside the recent tail and
must await ordered replay; this is an explicit bounded-work limitation, not a
claim that all historical events have been checked. More than 100 recent
lifecycle events also exceed the documented summary retention. The source
journal remains available through `get_job_events`. With a new lifecycle event
at the journal tail, observation occurs on the ~1-second debounce or next
30-second fallback, regardless of how many token entries preceded it (subject
to normal Node event-loop scheduling).

Job state, scheduler, recovery and authorization paths are unchanged. Blockers
use existing secret redaction, control-character removal and a 400-character
limit; oversized or invalid JSON gets a generic detail instead. As with existing
job APIs, arbitrary human text should not contain secrets that cannot be
recognized by redaction. Summaries describe transitions, not necessarily the
current job status.

Failures detach the observer, cancel its timers, and expose `observation:error`
without leaking exception details or throwing into startup/jobs. There is no
automatic error-retry loop. Normal service shutdown stops observation. The mode
is always `observe`; no actions, external requests, LLM calls, credentials,
subprocesses, or separate infrastructure are available to Sentinel.

## Read interface and human validation

`get_sentinel {}` is a read-only canonical tool available through existing MCP
and `POST /api/tools/get_sentinel`. Existing HTTP [REDACTED] and MCP
subject/scope checks apply unchanged. No public diagnostic endpoint is added.
The response includes `mode`, `observation`, `cursor`, `latestEventId`,
`replayPending`, and `summaries` with event
id, job id, timestamp, status, blocker and a detail pointing to existing
`get_job` / `get_job_events` tools. Reading the report does not trigger processing.

These steps are for an operator in a disposable local installation; they are
not permission to activate a release or to run jobs on the shared host:

1. With the setting absent, call `get_sentinel {}` through an authenticated
   client. Expect `disabled`, cursor zero, and no summaries. An unauthenticated
   HTTP request must still receive 401.
2. In that disposable installation only, set `sentinelEnabled: true` and start
   the service through the normal operator workflow. Expect `observing`, a cursor
   at the journal tip, and no pre-opt-in summaries.
3. Using existing authorized job workflows, reach an actionable status. After
   about one second (or the next 30-second fallback), compare the summary event id/time/status with `get_job_events`.
   Repeated reads must not duplicate it or change job state. A blocker containing
   `password="[REDACTED]" should be redacted.
4. Restart the disposable service normally; verify the cursor persists and
   committed events are not duplicated. A recent lifecycle event following many
   token entries should appear on the first pass, even with `replayPending:true`.
   Older gap events catch up in bounded steps; do not interpret a pending replay
   as completed historical coverage.
5. Remove/disable the setting and restart: expect `disabled`; the persisted
   checkpoint is retained but hidden until explicitly enabled again.

## V1 design only

`SentinelPolicy` is a small pure typed event-to-recommendation boundary. V0 does
not instantiate or invoke it. A future policy receives a readonly sanitized
Attention, and may ignore it or recommend something requiring explicit human
authorization. It receives no Store or execution capabilities.

V1 would need a separately reviewed executor with a narrow permitted-action
union, persisted idempotency keys, expiry and scope-bound explicit human approval,
current-state validation, denial by default, and per-job/global rate and budget
gates before any action. Approval must not be inferred from a recommendation or
from observation opt-in. Existing scheduler/recovery APIs remain authoritative.
Any future external LLM/API usage needs separate opt-in, credential isolation,
redaction, token/account budgets and audit records. Resource-pressure deferral
and WorldPrep priority must precede discretionary policy/executor work. None of
those capabilities is activated by this feature.

## CB-189 validation record

Base HEAD is Debian release `d9eb49dafce6d86eccc7457a80139a6d2b106f7e`.
Uses its Node 24 Store, schema-v4 settings table and canonical tool registry;
no schema version bump, migration, new dependency or deployment edit. Disabling
removes observer overhead. Older code ignores the additional settings row;
remove the new config option before running an older strict config parser.
The revised Sentinel reads previous V0 checkpoints; the previous unshipped
Sentinel implementation will reject the revised checkpoint fields and fail closed.

Only short serial commands were run with nice 19 and idle-class ionice. Initial
load was 1.05 with 8515 MiB available; before tests load was 0.21 with 8524 MiB
available and CPU/memory pressure avg10/avg60 zero. These are snapshots, not
evidence that WorldPrep is stopped. No workload logs, Minecraft directories,
server processes, browsers, Docker, live suites, or infrastructure were touched.
Dependencies were installed offline, without lifecycle scripts, in this worktree.

Commands and results:

- `nice -n 19 ionice -c 3 npm ci --offline --ignore-scripts --no-audit --no-fund`
  — exit 0, 111 packages in one second.
- `nice -n 19 ionice -c 3 node node_modules/typescript/bin/tsc --noEmit`
  — exit 0.
- `nice -n 19 ionice -c 3 node node_modules/tsx/dist/cli.mjs --test --test-concurrency=1 tests/sentinel.test.ts`
  — exit 1: tsx CLI attempted unavailable `/tmp/tsx-997`; no tests ran. Switched
  to the Node loader with cache disabled, avoiding out-of-worktree temp files.
- `TSX_DISABLE_CACHE=1 nice -n 19 ionice -c 3 node --import tsx --test --test-concurrency=1 tests/sentinel.test.ts`
  — exit 0, file-level pass. Explicit in-process run below confirms individual tests.
- `TSX_DISABLE_CACHE=1 nice -n 19 ionice -c 3 node --import tsx --test --test-isolation=none --test-concurrency=1 --test-reporter=spec tests/sentinel.test.ts`
  — exit 0, initially 5/5 tests; final run 6/6 after adding malformed/oversized-data coverage.

Tests use memory SQLite or a tiny temporary database inside this worktree (removed
after testing), fake timers, and no workers or servers. They verify default-off,
canonical read-only registration, event-driven observation, token filtering,
fallback, bounded batches/retention, durable restart dedupe, sanitation, write
failure rollback/replay, corrupt-checkpoint isolation and lifecycle rollback.
Full suites and live HTTP/MCP/service activation were deliberately not run.

Final TypeScript and six-test runs also passed (exit 0) after changing the idle
fallback to avoid acquiring a write lock when there are no new events. Final
resource snapshot: load 0.49, 8532 MiB available.

Formatting commands (both exit 0):

```sh
nice -n 19 ionice -c 3 node node_modules/prettier/bin/prettier.cjs --write src/sentinel.ts src/config.ts src/orchestrator.ts src/tools.ts tests/sentinel.test.ts docs/sentinel-mini.md
nice -n 19 ionice -c 3 node node_modules/prettier/bin/prettier.cjs --check src/sentinel.ts src/config.ts src/orchestrator.ts src/tools.ts tests/sentinel.test.ts docs/sentinel-mini.md
```

`git diff --check` also exited 0. Changed files: `src/config.ts`,
`src/orchestrator.ts`, `src/tools.ts`, new `src/sentinel.ts`, new
`tests/sentinel.test.ts`, and this document. No commit, push, merge, publication,
deployment or release activation was performed.

## Freshness acceptance revision

Only `src/sentinel.ts`, `tests/sentinel.test.ts`, and this document changed in
this revision; the original ticket's config/orchestrator/tool additions remain.
No live database, config, services, deployment, Git refs, WorldPrep, Director or
Minecraft files were accessed or changed.

Before execution: load 0.96, 8543 MiB available; CPU and memory pressure avg10
and avg60 were zero. Work remained serial with nice 19 and idle-class ionice.
The in-memory fixture uses 20,000 token events plus sparse lifecycle events,
then two additional 5,000-token bursts. A separate bootstrap fixture has over
2,000 historical entries and a journal tip of 613044. These are synthetic data;
no production journal was read or benchmarked.

Exact test command:

```sh
TSX_DISABLE_CACHE=1 nice -n 19 ionice -c 3 node --import tsx --test --test-isolation=none --test-concurrency=1 --test-reporter=spec tests/sentinel.test.ts
```

Exit 0; 9/9 tests passed in 628.49 ms. The 20,000-token seed took 41.89 ms;
its first observation pass took 0.98 ms. These are observed fixture timings,
not a production latency guarantee. Both actual SQL statements were checked
with `EXPLAIN QUERY PLAN` in the test and returned:

```text
SEARCH job_events USING INTEGER PRIMARY KEY (rowid>? AND rowid<?)
```

No full scan or temporary sort appeared. Tests cover durable current-tip
bootstrap, old checkpoint replay, restart deduplication, recovery of lifecycle
events inside the gap, newest-event freshness through both debounce and missed
notification fallback, bounded retention, sanitation, and observer failures
that leave job transitions working.

The first timing-wrapper attempt,
`/usr/bin/time -f 'elapsed=%e s; exit=%x' nice -n 19 ionice -c 3 node node_modules/typescript/bin/tsc --noEmit`,
exited 127 because `/usr/bin/time` is absent; compilation did not run in that
attempt. The replacement uses Bash's built-in timer:

```sh
TIMEFORMAT='elapsed=%3R s'; time nice -n 19 ionice -c 3 node node_modules/typescript/bin/tsc --noEmit
```

Compilation exited 0 in 1.907 seconds. The initial targeted Prettier check
exited 1 for document formatting only; it was corrected with the write command
below and rechecked. `git diff --check` exited 0.

```sh
nice -n 19 ionice -c 3 node node_modules/prettier/bin/prettier.cjs --write docs/sentinel-mini.md
nice -n 19 ionice -c 3 node node_modules/prettier/bin/prettier.cjs --check src/sentinel.ts tests/sentinel.test.ts docs/sentinel-mini.md
```

