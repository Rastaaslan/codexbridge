# Persistent roadmap planner (P4)

Use the same strict operations through MCP or `POST /api/tools/:name`.

1. `create_roadmap` persists a plan and freezes its `startRef` to a commit. It creates no project, feature or job records.
2. `validate_roadmap` with `{ "id": "<roadmap UUID>", "version": 1 }` explicitly validates the DAG without creating jobs.
3. `apply_roadmap` with the same ID/version atomically creates one project and one feature/primary implementation job per feature key. Retain the returned UUID and bindings for retries.
4. `get_roadmap` reads lifecycle and execution state; `get_roadmap_summary` gives runnable features, dependency blockers, integration waits, failures/exhaustion and human-attention items.
5. `reconcile_roadmap` refreshes admission from persisted job and P2 integration records. Recovery and scheduler ticks also reconcile automatically.

Example `create_roadmap` body:

```json
{
  "name": "Service upgrade",
  "repository": "/absolute/allowed/repository",
  "startRef": "HEAD",
  "features": [
    {
      "key": "storage",
      "title": "Persistent storage",
      "ticket": "Implement storage and migration tests.",
      "acceptanceCriteria": ["Data survives restart"],
      "priority": 80,
      "executionCost": 2
    },
    {
      "key": "docs",
      "title": "Documentation",
      "ticket": "Document the upgrade.",
      "priority": 20,
      "executionCost": 1
    },
    {
      "key": "api",
      "title": "Storage API",
      "ticket": "Expose the storage API.",
      "dependencies": ["storage", "docs"],
      "inheritFrom": "storage"
    }
  ]
}
```

`dependencies` are completion gates: all predecessor jobs must be `COMPLETED` through the existing human approval workflow. Independent jobs use P3 concurrency, priority, cost and admission controls. Completion alone does not incorporate code.

`inheritFrom` must name one of those dependencies. It additionally requires a successful explicit P2 integration associated with that predecessor job in the same repository. The downstream job uses the successful result's immutable commit as both `startRef` and `baseCommit`, with the integration attempt ID recorded in metadata. A branch tip, repository HEAD, failed attempt or another job's integration cannot substitute. The first successful associated result is selected deterministically and must match the predecessor’s current sealed accepted review, including its iteration and canonical snapshot. Missing or changed review evidence holds downstream admission with an explicit integration-wait reason, including after restart. An integration performed before human rejection cannot supply the baseline for subsequently reworked code. A feature has one code baseline; fan-in can have many completion gates. To inherit multiple branches, explicitly establish the combined reviewed baseline through sequential predecessor work before making it the inherited predecessor. The planner does not combine divergent histories.

Integration remains the separate `integrate_job` action with its existing P2 review, expected-base and verification requirements. The planner performs no integration, push, merge, deployment or update.

`revise_roadmap` accepts `{ "id": "...", "version": 1, "roadmap": { ... } }`. It increments the version, holds future jobs, and requires validation and apply again. Existing keys retain their IDs. Future feature metadata and DAG edges may change, and features may be added. Started, retried or completed execution cannot change. Removal, repository changes and baseline changes are rejected. Version checks reject stale writes; revisions are retained in SQLite. Change planner-owned dependencies through revisions, not `set_job_dependencies`.

Roadmap lifecycle is `planned`, `validated`, `materialized`, then `complete`. Feature state distinguishes planned/materialized/running, dependency waits, review waits, integration waits, blocked and complete. Read operations do not mutate state. Summary runnable candidates remain subject to P3 capacity and admission checks. Repeated apply/reconcile preserves IDs and does not duplicate execution; atomic materialization and persisted admission gates protect restart boundaries.
