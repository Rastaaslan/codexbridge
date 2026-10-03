# CB-76 final validation — 4 October 2026

Based on CB-75 commit `2654cf1`. Its worker Git permissions, service Git callback
protections and regression tests are preserved. No production state was changed;
no push, deployment, merge or service restart was performed.

## Resolved CB-71 findings

The [original CB-71 findings and evidence map](CB-71-FINDINGS.md) retain excerpts
from all three reviewer reports and identify each fix or remaining limitation.

- Release manifests now include `sqliteSchema: 4`; activation and preflight reject
  missing or contradictory runtime/SQLite metadata.
- Recovery validates the restoration target without requiring a damaged outgoing
  release to validate. Forward activation still validates both releases.
- Preparation failures preserve maintenance markers belonging to other operations.
  Recovery recognizes updater-owned markers, including the legacy reason format.
- Regression coverage checks real Git policies, manifest/HEAD mismatches, direct
  activation and transaction rejection, damaged-release restoration, and maintenance
  ownership. Existing recovery fixtures use the separate restoration interface.

## Iteration 1 validation results

- `npm ci`: succeeded; dependency audit reported zero vulnerabilities.
- `TMPDIR="$PWD/.test-tmp" npm run check`: TypeScript compilation succeeded;
  **144 tests passed**, zero failures, cancellations or skips. An earlier run made
  before all recovery fixtures were updated failed; the complete rerun passed.
- `npm run format:check`: passed.
- `npm run audit:publication`: passed.
- `git diff --check`: passed.
- Read-only HTTP probes to the installed tunnel's loopback health URL returned
  **200** for `/healthz` and `/readyz`. This establishes current installed-tunnel
  readiness only, not candidate deployment or end-to-end external MCP availability.
- `codex sandbox linux --help`: exited **1** before sandbox execution with
  `app-server socket directory must be a user-owned directory with mode 0700`.
  Live hardened-worker edits, test execution and same-thread resume therefore
  remain unverified. No sandbox permissions were relaxed to bypass this failure.

## Review follow-up validation

The review identified a crash window while writing `maintenance.json`. Acquisition
now writes a unique temporary file, syncs and closes it, then publishes it with an
atomic hard link that refuses to overwrite an existing marker. The directory is
synced before acquisition returns. Interrupted writes leave only an unused
temporary file; after publication the live marker always contains complete JSON.
Ordinary failure paths clean up temporary files. Recovery does not need to read
or remove temporary files left by a crashed process.

Fault-injection tests terminate a child process after a partial write, before
publication and immediately after publication; they also inject write and
directory-sync errors. Fresh driver instances perform startup cleanup, boot
restoration and post-start health verification. Concurrent acquisitions prove
exactly one publisher succeeds and the winner's bytes are preserved.

- `TMPDIR="$PWD/.test-tmp" npx tsx --test tests/update.test.ts`: **27 passed**.
- `TMPDIR="$PWD/.test-tmp" npm run check`: compilation and **150 tests passed**,
  with zero failures, cancellations or skips; includes the final fresh-driver
  adoption assertions and the preserved CB-75 regression coverage.
- `npm run format:check`, `npm run audit:publication`, `git diff --check`: passed.
- `codex sandbox linux --help`: again exited **1** with
  `app-server socket directory must be a user-owned directory with mode 0700`.
- `TMPDIR="$PWD/.test-tmp" npx tsx .test-tmp/live-adapter-probe.ts`: exited **1**
  with `Codex app-server exited (1)`. The probe called the actual
  `AppServerAdapter.run` using a worktree-local test state directory, a 10-second
  timeout and the linked worktree as cwd. No thread-start callback occurred;
  therefore edits, tests and resume could not be exercised. The local probe and
  output are retained under ignored `.test-tmp/`; this paragraph records the
  outcome in version control without private runtime state.

No host socket configuration, production state or sandbox permissions were changed.
These failures are environmental validation blockers, not passing live evidence.

## Remaining release gates

### Reproducible hardened-worker validation

`scripts/live-hardened-worker.ts` replaces the startup-only probe for the remaining
live gate. Run it on Linux with a functioning Codex sandbox and a separately
authenticated, test-only Codex home under this checkout's `.test-tmp/`:

```sh
TMPDIR="$PWD/.test-tmp" npm run test:live-hardened -- .test-tmp/test-codex-home
```

The directory must already exist. Authentication must be provisioned in that
test-only home; the harness does not copy production credentials or sessions.
The launcher scopes the home setting to the child runtime. No running service,
production database, production configuration or external MCP tool is used.

The harness creates its own Git repository and linked worktree, then invokes the
unchanged `AppServerAdapter` twice. It asserts:

- Turn one edits the broken addition fixture and runs at least four passing tests.
- Turn two resumes exactly the same thread, preserves those tests and appends the
  fractional regression, then runs at least five passing tests.
- Completed command-execution events show successful worker test execution and
  sandbox write-denial checks; model summaries alone cannot pass validation.
- The worker cannot write common Git metadata, linked-worktree Git metadata or a
  sibling directory, and does not modify the sandbox probe.
- Independent test execution passes after each turn; both Git HEADs and the
  original working tree remain unchanged.

The actual CB-75 adapter supplies the same network-disabled workspace-write
policy, approval denial and disabled plugins/MCP configuration. No policy is
relaxed by the harness. These settings remain covered by adapter protocol tests;
the live harness additionally probes filesystem enforcement.

Each attempt retains `report.json` under `.test-tmp/live-hardened-*`, including
the checkout commit, tracked changes, adapter and harness SHA-256 hashes, thread
IDs, completed commands, independent test output, assertions' failures and final
status. Reports remain local because runtime output may contain private paths.
For release evidence, run from the committed, clean checkout and require
`status: "passed"` with two completed turns.

Iteration 3 attempted the command with `.test-tmp/live-test-codex-home`, an isolated
empty test home. It exited **1**, `Codex app-server exited (1)`, before the first
thread callback. The runtime's `codex sandbox linux --help` also exited **1** with
the same socket-directory error reported above. This is failed live validation,
not successful edit/test/resume evidence; authentication in the isolated home is
also still required once the runtime can start.

Iteration 3 automated validation: `TMPDIR="$PWD/.test-tmp" npm run check`
passed compilation and all **150 tests**, with zero failures or skips.
`npx tsc --noEmit --module NodeNext --target ES2023 --strict --skipLibCheck scripts/live-hardened-worker.ts`
passed standalone harness typechecking. Formatting, publication audit and diff
checks passed. The audit initially flagged a dummy token literal in the harness;
the final explicit generated test placeholder passes the audit.

Run the live worker/edit/test/resume validation in an isolated environment with a
working Codex sandbox and writable test-only session storage. This worktree cannot
repair the host socket configuration while preserving production unchanged.

Schema-v4 gating is a fail-closed policy, not cross-version rollback. Cross-version
rollout remains blocked pending a separately validated migration/recovery procedure;
the passing tests validate compatible v4 restoration only. See [MIGRATION.md](MIGRATION.md).
