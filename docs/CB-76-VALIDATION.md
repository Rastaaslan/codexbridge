# CB-76 final validation — 4 October 2026

Based on CB-75 commit `2654cf1`. Its worker Git permissions, service Git callback
protections and regression tests are preserved. No production state was changed;
no push, deployment, merge or service restart was performed.

## Resolved CB-71 findings

- Release manifests now include `sqliteSchema: 4`; activation and preflight reject
  missing or contradictory runtime/SQLite metadata.
- Recovery validates the restoration target without requiring a damaged outgoing
  release to validate. Forward activation still validates both releases.
- Preparation failures preserve maintenance markers belonging to other operations.
  Recovery recognizes updater-owned markers, including the legacy reason format.
- Regression coverage checks real Git policies, manifest/HEAD mismatches, direct
  activation and transaction rejection, damaged-release restoration, and maintenance
  ownership. Existing recovery fixtures use the separate restoration interface.

## Validation results

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

## Remaining release gates

Run the live worker/edit/test/resume validation in an isolated environment with a
working Codex sandbox and writable test-only session storage. This worktree cannot
repair the host socket configuration while preserving production unchanged.

Schema-v4 gating is a fail-closed policy, not cross-version rollback. Cross-version
rollout remains blocked pending a separately validated migration/recovery procedure;
the passing tests validate compatible v4 restoration only. See [MIGRATION.md](MIGRATION.md).
