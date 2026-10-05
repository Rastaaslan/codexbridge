# Release readiness

Use the authenticated `operational_summary` tool (or POST `/api/tools/operational_summary` with `{}`) for compact health, scheduler capacity, project/roadmap, integration, retry and human-attention counts. It excludes free-form job content and credentials. Existing `/health`, `server_doctor`, and `jobs_overview` responses are unchanged.

Call `release_preflight` with `{"candidateRef":"<local-ref-or-commit>"}` before release validation. It reports current release, resolved candidate commit, database version and concrete blockers. It performs local read-only checks: it does not fetch, build, migrate, pause work or activate a release. Missing local candidate evidence fails closed. A healthy external tunnel is not required for application readiness.

Both release policies must declare `runtimeSchema: 1`. The candidate must declare `sqliteSchema: 4`; the current release may declare schema 1 only with the installed [contract-2 cold rollback transaction](CB-134-ROLLBACK.md). Preflight checks the installed root-owned updater version against candidate requirements; activation also verifies installed startup-guard wiring. The current release manifest must identify the checked-out commit. Missing rollback baseline, active workers/child processes/integrations, maintenance, unhealthy application, incompatible database, or an unsafe release checkout blocks readiness. A preflight success is a point-in-time operational check, not authorization to activate: candidate build/tests and activation-time quiescence and health checks remain required. Older releases without explicit SQLite compatibility evidence remain blocked until their source schema and release identity can be verified.

For the actually deployed `3a99deafb510a893e607204f3add8805599c69e7`, the original
API lacks release_preflight and operational_summary. Use the reviewed installed
runner's `--bootstrap-preflight` after the [exact-source bootstrap installation](CB-134-ROLLBACK.md#exact-deployed-source-bootstrap).
It verifies source/build identity, the original doctor and live instrumentation
without opening or migrating the database. Its output never authorizes activation:
the subsequent updater still requires owned maintenance, zero live work/processes,
service stop and a durable snapshot. No other schema-less source is admitted.
