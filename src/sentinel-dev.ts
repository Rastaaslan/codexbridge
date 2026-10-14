import { createHash } from "node:crypto";
import { z } from "zod";
import type { Store } from "./database.js";
import { statuses } from "./domain.js";
import type { SentinelMini } from "./sentinel.js";

const name = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const devPolicySchema = z
  .strictObject({
    id: name,
    enabled: z.boolean().default(false),
    repository: z.string().min(1).max(512),
    source: z
      .strictObject({
        baseCommit: sha,
        provenanceHash: digest,
        approvedBy: name,
      })
      .nullable(),
    budget: z.number().int().min(1).max(10),
    concurrency: z.literal(1),
    cooldownMs: z.number().int().min(60000).max(86400000),
    tasks: z
      .array(
        z.strictObject({
          id: name,
          operation: z.literal("code-fix"),
          maxIterations: z.number().int().min(1).max(10).default(1),
          dependencies: z
            .array(z.string().regex(/^CB-\d+$/))
            .min(1)
            .max(10),
          requiredEvidence: z.array(name).max(10),
          ticket: z.string().min(1).max(4000),
          ticketHash: digest,
        }),
      )
      .min(1)
      .max(10),
  })
  .superRefine((p, ctx) => {
    if (new Set(p.tasks.map((t) => t.id)).size !== p.tasks.length)
      ctx.addIssue({ code: "custom", message: "Duplicate task ID" });
    if (p.tasks.reduce((sum, t) => sum + t.maxIterations, 0) > p.budget)
      ctx.addIssue({
        code: "custom",
        message: "Task iteration budgets exceed policy budget",
      });
    for (const t of p.tasks)
      if (hash(t.ticket) !== t.ticketHash)
        ctx.addIssue({ code: "custom", message: "Ticket hash mismatch" });
  });
export type DevPolicy = z.infer<typeof devPolicySchema>;
export function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
const decisionSchema = z.strictObject({
  taskId: name,
  key: digest,
  dependencies: z.array(z.string()).max(10),
  dependencyStates: z
    .array(
      z.strictObject({
        jobId: z.string(),
        currentStatus: z.string(),
        observedStatus: z.string().nullable(),
        durableCompletion: z.boolean().default(false),
      }),
    )
    .max(10),
  status: z.enum(["blocked", "ready-for-code"]),
  reason: z.string().max(400),
});
const stateSchema = z.strictObject({
  cursor: z.number().int().nonnegative(),
  decisions: z.array(decisionSchema).max(10),
});
export const devReportSchema = stateSchema.extend({
  mode: z.literal("plan-only"),
  observation: z.enum(["disabled", "planning", "error"]),
  policyId: name.nullable(),
});

// Historical dependencies may predate the observer's first checkpoint.
// Verify the canonical lifecycle journal as well as the current Store status.
// Bounded tail scan on events_job(job_id,id). Missing/contradictory proof
// denies admission. This never emits or backfills completion events.
const workflowEvents = new Set(statuses.map((status) => "JOB_" + status));
function durableCompletion(store: Store, jobId: string): boolean {
  const tail = store.db
    .prepare(
      "SELECT type FROM job_events WHERE job_id=? ORDER BY id DESC LIMIT 128",
    )
    .all(jobId) as { type: string }[];
  return (
    tail.find((event) => workflowEvents.has(event.type))?.type ===
    "JOB_COMPLETED"
  );
}

// This layer consumes Mini's bounded snapshots, never subscribes to the journal
// or duplicates the workflow state machine. Current Store status is authoritative.
export class SentinelDev {
  private state: z.infer<typeof stateSchema> = { cursor: 0, decisions: [] };
  private observation: "disabled" | "planning" | "error" = "disabled";
  private readonly policy?: DevPolicy;
  private readonly key: string;
  constructor(
    private readonly store: Store,
    private readonly mini: SentinelMini,
    policy?: DevPolicy,
  ) {
    this.policy =
      policy === undefined ? undefined : devPolicySchema.parse(policy);
    this.key = `sentinel:dev:v1:${hash(JSON.stringify(this.policy ?? null))}`;
    if (!this.policy?.enabled) return;
    try {
      const row = store.db
        .prepare("SELECT value FROM settings WHERE key=?")
        .get(this.key);
      if (row) this.state = stateSchema.parse(JSON.parse(String(row.value)));
      this.observation = "planning";
      this.tick();
    } catch {
      this.observation = "error";
    }
  }
  tick() {
    if (this.observation !== "planning" || !this.policy) return;
    try {
      const snapshot = this.mini.report();
      const p = this.policy;
      const decisions = p.tasks.map((task) => {
        const dependencyStates = task.dependencies.map((jobId) => {
          const event = snapshot.summaries
            .filter((s) => s.jobId === jobId)
            .at(-1);
          let currentStatus: string;
          try {
            currentStatus = this.store.get(jobId).status;
          } catch {
            currentStatus = "missing";
          }
          return {
            jobId,
            currentStatus,
            observedStatus: event?.status ?? null,
            durableCompletion:
              currentStatus === "COMPLETED" &&
              durableCompletion(this.store, jobId),
          };
        });
        let reason = "";
        if (snapshot.observation !== "observing" || snapshot.replayPending)
          reason = "Observer unavailable or replay pending";
        else if (!p.source)
          reason = "Approved compatible source and provenance missing";
        else {
          const blocked = dependencyStates.find(
            (d) => d.currentStatus !== "COMPLETED" || !d.durableCompletion,
          );
          if (blocked)
            reason = `${blocked.jobId}: ${blocked.currentStatus}; requires current workflow completion and durable lifecycle event`;
          // V1 has no evidence attestation writer. Event prose is not approval.
          if (!reason && task.requiredEvidence.length)
            reason = `Verified evidence required: ${task.requiredEvidence.join(", ")}`;
        }
        return decisionSchema.parse({
          taskId: task.id,
          key: hash(`${this.key}:${task.id}`),
          dependencies: task.dependencies,
          dependencyStates,
          status: reason ? "blocked" : "ready-for-code",
          reason: (
            reason ||
            "Dependencies complete; code-only candidate requires separate preapproval"
          ).slice(0, 400),
        });
      });
      const next = { cursor: snapshot.cursor, decisions };
      if (JSON.stringify(next) === JSON.stringify(this.state)) return;
      this.store.db
        .prepare("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)")
        .run(this.key, JSON.stringify(next));
      this.state = next;
    } catch {
      this.observation = "error";
    }
  }
  report() {
    return devReportSchema.parse({
      ...this.state,
      mode: "plan-only",
      observation: this.observation,
      policyId: this.policy?.id ?? null,
    });
  }
}

// Future adapter contract. No executor is wired into Orchestrator or config.
// A trusted service must atomically reserve budget/concurrency and submit via
// existing create-job idempotency/scheduler APIs; this predicate is not a lock.
export interface DevActionCheck {
  enabled: boolean;
  signedOffPolicyId: string | null;
  policyHash: string | null;
  repository: string;
  baseCommit: string | null;
  provenanceHash: string | null;
  ticketHash: string;
  approvalsSatisfied: boolean;
  stateRechecked: boolean;
  schedulerAllows: boolean;
  usedBudget: number;
  running: number;
  elapsedMs: number;
  alreadySubmitted: boolean;
}
export function actionEligible(
  policy: DevPolicy,
  taskId: string,
  report: ReturnType<SentinelDev["report"]>,
  check: DevActionCheck,
): boolean {
  const p = devPolicySchema.parse(policy);
  const task = p.tasks.find((t) => t.id === taskId);
  return !!(
    p.enabled &&
    p.source &&
    task &&
    check.enabled &&
    check.signedOffPolicyId === p.id &&
    check.policyHash === hash(JSON.stringify(p)) &&
    check.repository === p.repository &&
    check.baseCommit === p.source.baseCommit &&
    check.provenanceHash === p.source.provenanceHash &&
    check.ticketHash === task.ticketHash &&
    check.approvalsSatisfied &&
    check.stateRechecked &&
    check.schedulerAllows &&
    Number.isInteger(check.usedBudget) &&
    check.usedBudget >= 0 &&
    check.usedBudget + task.maxIterations <= p.budget &&
    check.running === 0 &&
    Number.isFinite(check.elapsedMs) &&
    check.elapsedMs >= p.cooldownMs &&
    !check.alreadySubmitted &&
    report.observation === "planning" &&
    report.policyId === p.id &&
    report.decisions.some(
      (d) =>
        d.taskId === taskId &&
        d.status === "ready-for-code" &&
        d.key === hash(`sentinel:dev:v1:${hash(JSON.stringify(p))}:${taskId}`),
    )
  );
}
