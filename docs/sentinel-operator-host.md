# Sentinel Debian operator-host bootstrap (candidate)

Sentinel remains disabled by default. The ordinary CLI now attaches the signed
authorization host **only if** all of these separately controlled conditions hold:
`sentinelExecutionEnabled: true`, `sentinelEnabled: true`, an enabled
`sentinelDevPolicy`, `maxRuntimeRetries: 0`, and a Linux service environment
containing `CODEXBRIDGE_SENTINEL_OPERATOR_OPT_IN=1` plus:

- `CODEXBRIDGE_SENTINEL_GRANTS_FILE` — absolute path of signed bundle.
- `CODEXBRIDGE_SENTINEL_PUBLIC_KEY_FILE` — absolute path of approved Ed25519
  public PEM. The **private key must remain offline** and unavailable to workers.
- `CODEXBRIDGE_SENTINEL_PUBLIC_KEY_SHA256` — exact SHA-256 of public PEM file.
- `CODEXBRIDGE_SENTINEL_REPOSITORIES_JSON` — JSON list of exact canonical,
  operator-approved Git repositories, never derived from worker ticket/policy.

The trusted service operator must install these settings and files under the
appropriate existing managed-service security controls. No file or setting was
installed by this change. Paths inside the DB directory or allowlisted worker
repositories are rejected. A missing, invalid or incomplete configuration
leaves Sentinel execution disabled with a diagnostic. Neither policy text,
Codex responses nor MCP clients can opt themselves in.

The host adapter verifies operator signatures and pinned source provenance
through GitWorkspace; it rereads the signed document immediately before
inserting a job. It also performs lightweight fail-closed resource admission
from Linux `/proc`: no CPU pressure >=10% avg10, I/O full pressure >=8% avg10,
or available RAM below 3 GiB. The normal CodexBridge scheduler is authoritative,
but the host temporarily defers new Sentinel jobs while resources are scarce or
CodexBridge is already using its job capacity. No extra monitor or timer is
started: deferrals use the existing bounded scheduler cadence (60-second
deadline). If temporary admission fails **after a durable reservation**, the
executor halts for human investigation instead of risking duplicate submissions.

These thresholds apply only to **new Sentinel-initiated jobs**, not existing
Minecraft or CodexBridge jobs. The first enabled WorldPrep policy still requires
independently approved canonical Git source, completed dependencies, and
authenticated runtime evidence. The sample policy intentionally remains
disabled with source=null; these prerequisites have not been supplied.

Real deployment and operator signing remain separate, explicitly authorized
steps. Running the test suite or pushing this branch does NOT activate jobs.
