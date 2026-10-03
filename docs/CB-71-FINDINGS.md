# CB-71 findings and CB-76 disposition

Source: persisted CB-71 ticket, worker result and three reviewer reports, read
from the local job database during CB-76 iteration 1. This document retains the
finding text needed to review CB-76 without access to that private database.
The quoted excerpts below are from those reports, not new validation claims.

## Original audit scope

CB-71 audited hardening candidate `e03abf91f79b4cc3d90d9435e6c908f926e6f197`.
It required proof that legacy rollback baselines were rejected before activation,
that compatible v4 baselines matched manifest, HEAD and committed policy, and
that direct activation and transaction paths behaved consistently. It also
requested P1–P5, legacy `create_job`, recovery, concurrency and native tunnel
regression checks, distinguishing fail-closed policy from cross-version rollback.

## Findings and evidence map

| Source   | Original finding (excerpt)                                                                                                                                                                    | CB-76 disposition and evidence                                                                                                                                                                                                                                                                                               |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Review 1 | “recovery validates the current release before restoring the previous release” and “a corrupt current manifest prevents restoration of a valid v4 baseline and leaves maintenance enabled”    | Fixed by separate `restore` and guarded forward `activate` paths in `scripts/self-update.mjs`. `tests/update.test.ts` covers corrupt outgoing manifests in transaction and boot restoration, plus invalid restoration-target rejection.                                                                                      |
| Review 1 | “activation ignores manifest runtimeSchema/sqliteSchema” and “build() also omits sqliteSchema from the generated manifest”                                                                    | Fixed by manifest generation and compatibility validation. Updater tests check the exact generated manifest and missing, contradictory and wrongly typed metadata on both releases, against disk policy, committed policy and HEAD.                                                                                          |
| Review 1 | “preparation rejection unconditionally resumes scheduling” and “legacy rejection deleting a pre-existing maintenance marker”                                                                  | Fixed by acquisition tracking and marker ownership. Updater tests preserve another operation's bytes through preparation rejection, occupied acquisition, startup cleanup and recovery. Review follow-up adds atomic no-replace publication, partial-write/crash/write-failure/sync-failure tests and fresh-driver recovery. |
| Review 2 | “release_preflight ignores manifest runtimeSchema/sqliteSchema” and “ready=true for both missing schema fields and runtimeSchema=99/sqliteSchema=1, while activation rejects these baselines” | Fixed in `src/readiness.ts`. `tests/readiness.test.ts` rejects eight invalid metadata combinations, verifies read-only behavior, then confirms restored valid metadata permits readiness.                                                                                                                                    |
| Review 3 | “successful worker edits, test execution and thread resume under the actual hardened sandbox remain unverified”                                                                               | Still blocked by this environment: Codex fails before sandbox execution; the actual `AppServerAdapter.run` probe exits before a thread starts. Adapter protocol tests pass but do not replace live execution evidence. See the validation report for commands and outcomes.                                                  |
| Review 3 | “Schema-v4 gating is fail-closed migration policy, not cross-version rollback” and “cross-version rollout still requires a validated migration/recovery procedure”                            | Limitation retained explicitly in `docs/MIGRATION.md`. Compatible-v4 restoration is tested; a v4-to-v1 recovery procedure is neither implemented nor claimed. Production rollout remains blocked.                                                                                                                            |
| Review 3 | “Native tunnel availability remains unverified”                                                                                                                                               | CB-76 iteration 1 read-only probes returned HTTP 200 for the installed tunnel's `/healthz` and `/readyz`. This establishes installed-runtime health only, not candidate deployment or external end-to-end availability. No tunnel was restarted or reconfigured.                                                             |

Review 3 also reported: “Reviewed P1–P5, legacy create_job, recovery, concurrency
and tunnel contracts; no additional regression identified.” CB-76 reruns the full
suite, including those contracts and CB-75's Git callback protections. All CB-75
production code and adapter regression tests are unchanged from commit `2654cf1`.

The original worker result reported 143 passing tests but marked overall
validation blocked. CB-76 iteration 1 reported 144 passing tests after preserving
CB-75. The current suite result is recorded in [CB-76-VALIDATION.md](CB-76-VALIDATION.md);
none of these automated results establishes successful live sandbox execution.
