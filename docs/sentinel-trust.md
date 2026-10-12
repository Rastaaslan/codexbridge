# Sentinel: offline-signed operator grants (V1.2 candidate)

This **opt-in** component does not activate Sentinel or approve WorldPrep. It
provides `signedFileSentinelHost()` for a future trusted application host.
Only an independently held Ed25519 **private key** may authorize code-fix jobs.
Never place the private key in a repository, CodexBridge data directory, worker
sandbox, ticket, PR, CI environment or Minecraft machine account.

The host receives its **trusted public key** and absolute grant document path
from an operator-controlled environment, not the policy or any MCP request.
The signed JSON structure is `{ "payload": { "version": 1, "grants": [
{ "grant": <ExecutionGrant>, "provenance": {
"repository": "<canonical path>", "baseCommit": "<40-hex SHA>",
"sourceRef": "<verified Git ref>" } } ] }, "signature": "<base64>" }`.
Sign exactly the bytes returned by `signedBundleMessage(payload)` with
Ed25519, using an offline operator-only process. Limit: ten grants, 64 KiB total.
The grant's `provenanceHash` must equal SHA-256 of
`sourceProvenanceBytes(provenance)`. Both helpers canonicalize strict
schemas; inconsistent or duplicated records are rejected.

Each authorization read reopens and verifies the full signed document without
following symlinks. Real source verification checks canonical repository
identity, immutable commit and ref through the existing GitWorkspace API, plus
the separately signed provenance. The new `revalidateGrant` callback rechecks
the signed document synchronously **immediately before Store.create** so
revoked grants cannot be accepted based only on an earlier asynchronous check.

This is a trust **adapter**, not a grant writer. No automatic credential issuance,
deployment, service restart, production source discovery, new API endpoint,
scheduler, or background task was introduced. A malicious worker cannot
create a valid grant without the external private key. Availability is
fail-closed: missing, invalid, expired or revoked documents block execution.

Remaining prerequisites before any live WorldPrep development lane:
1. Operator-owned key management and protected source/approval storage;
2. Explicit integration of this host provider with the managed Debian service,
   after controlled source/revocation coordination and permission review;
3. Verified WorldPrep canonical source and actual CB-188/Director runtime
   evidence; the existing WorldPrep sample remains disabled;
4. A separately authorized deployment and dry run while Minecraft load is low.

Tests generate **synthetic ephemeral keys and documents only**; real-Git
and dispatch tests from the earlier feature remain separately covered in CI.
