import type { Orchestrator } from "./orchestrator.js";
import { z } from "zod";
import type { GitWorkspace } from "./git.js";
import type { Store } from "./database.js";
import { createSchema, type Job } from "./domain.js";
import {
  actionEligible,
  devPolicySchema,
  hash,
  type DevPolicy,
  type SentinelDev,
} from "./sentinel-dev.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
// Supplied by a trusted operator authorization service, NEVER from policy,
// event text, reviewer output or an MCP caller. Manual permission is insufficient.
export const executionGrantSchema = z.strictObject({
  permission: z.literal("automatic-code-fix"),
  taskId: z.string().min(1),
  policyHash: digest,
  repository: z.string().min(1),
  sourceRef: z.string().min(1),
  baseCommit: z.string().regex(/^[a-f0-9]{40}$/),
  provenanceHash: digest,
  ticketHash: digest,
  expiresAt: z.number().int().positive(),
});
export type ExecutionGrant = z.infer<typeof executionGrantSchema>;
export interface ExecutionPorts {
  authorize(taskId: string): Promise<unknown>;
  // Must resolve actual canonical Git path/ref/commit and hash trusted source
  // provenance, including compatibility. No policy-derived echo verifier.
  verifySource(grant: ExecutionGrant): Promise<boolean>;
  // Optional protected revocation check at the synchronous insertion boundary.
  revalidateGrant?(grant: ExecutionGrant): boolean;
  schedulerAllows(repository: string): boolean;
  // MUST invoke guard synchronously at insertion, after any async preparation.
  create(input: unknown, beforeCreate: () => undefined): Promise<Job>;
}
const attemptSchema = z.strictObject({
  taskId: z.string(),
  key: digest,
  policyHash: digest,
  at: z.number().int().nonnegative(),
  state: z.enum(["reserved", "submitted"]),
  jobId: z.string().nullable(),
});
const ledgerSchema = z.array(attemptSchema).max(10);
export const executionReportSchema = z.strictObject({
  mode: z.enum(["disabled", "dry-run", "enabled"]),
  blocker: z.string().nullable(),
  attempts: ledgerSchema,
});
class Blocker extends Error {}
// Only ordinary pre-reservation waits may be rechecked by external dispatch.
class Deferral extends Blocker {
  constructor(
    message: string,
    readonly wakeAt: number | null = null,
  ) {
    super(message);
  }
}
type Attempt = z.infer<typeof attemptSchema>;

// Isolated, pull-driven action service. No timers, subscriptions, startup hooks,
// migrations, shell or event publisher. Absent enablement touches nothing.
export class SentinelExecutor {
  get isHalted() {
    return this.halted;
  }
  deferredUntil: number | null = null;
  private busy = false;
  private halted = false;
  private blocker: string | null = null;
  private attempts: Attempt[] = [];
  private readonly policy: DevPolicy;
  private readonly laneKey: string;
  constructor(
    private readonly store: Store,
    private readonly planner: Pick<SentinelDev, "tick" | "report">,
    policy: DevPolicy,
    private readonly ports: ExecutionPorts,
    private readonly options: {
      enabled?: boolean;
      dryRun?: boolean;
      repositories: readonly string[];
    },
    private readonly now: () => number = Date.now,
  ) {
    this.policy = devPolicySchema.parse(policy);
    // Repository-wide lane survives policy edits and prevents resetting budget.
    this.laneKey = `sentinel:execute:v1:${hash(this.policy.repository)}`;
  }
  report() {
    if (this.options.enabled && !this.options.dryRun) {
      try {
        this.attempts = this.read();
      } catch {
        this.blocker =
          "Action status storage unavailable; operator inspection required";
        this.halted = true;
      }
    }
    return executionReportSchema.parse({
      mode: !this.options.enabled
        ? "disabled"
        : this.options.dryRun
          ? "dry-run"
          : "enabled",
      blocker:
        this.blocker ??
        (this.attempts.some((a) => a.state === "reserved")
          ? "Unresolved reservation; operator inspection required"
          : null),
      attempts: this.attempts,
    });
  }
  private read() {
    const row = this.store.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(this.laneKey);
    return row ? ledgerSchema.parse(JSON.parse(String(row.value))) : [];
  }
  private write(rows: Attempt[]) {
    this.store.db
      .prepare("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)")
      .run(this.laneKey, JSON.stringify(ledgerSchema.parse(rows)));
    this.attempts = rows;
  }
  private lookup(key: string) {
    const row = this.store.db
      .prepare("SELECT id FROM jobs WHERE idempotency_key=?")
      .get(key);
    return row ? this.store.get(String(row.id)) : undefined;
  }
  private input(taskId: string, key: string) {
    const task = this.policy.tasks.find((t) => t.id === taskId)!;
    return createSchema.parse({
      title: `Sentinel code-fix: ${taskId}`,
      ticket: task.ticket,
      repository: this.policy.repository,
      startRef: this.policy.source!.baseCommit,
      dependencies: task.dependencies,
      options: { idempotencyKey: key, maxIterations: 1 },
    });
  }
  private matches(job: Job, attempt: Attempt) {
    // Only reconcile this exact approved policy; foreign/changed input fails closed.
    if (attempt.policyHash !== hash(JSON.stringify(this.policy))) return false;
    const input = this.input(attempt.taskId, attempt.key);
    return (
      job.repository === input.repository &&
      job.ticket === input.ticket &&
      job.title === input.title &&
      job.startRef === input.startRef &&
      job.baseCommit === input.startRef &&
      job.maxIterations === 1 &&
      job.priority === input.priority &&
      job.executionCost === input.executionCost &&
      job.projectId === undefined &&
      job.featureId === undefined &&
      JSON.stringify(job.acceptanceCriteria) ===
        JSON.stringify(input.acceptanceCriteria) &&
      JSON.stringify(job.dependencies) ===
        JSON.stringify([...new Set(input.dependencies)].sort())
    );
  }
  private dependencies(taskId: string) {
    const task = this.policy.tasks.find((t) => t.id === taskId);
    if (!task || task.requiredEvidence.length)
      throw new Blocker("Verified runtime evidence ingestion unavailable");
    if (task.ticket !== task.ticket.trim())
      throw new Blocker("Ticket normalization would change approved hash");
    for (const id of task.dependencies) {
      if (this.store.get(id).status !== "COMPLETED")
        throw new Blocker("Dependency requires workflow completion");
    }
  }
  private async validate(taskId: string) {
    const p = this.policy;
    const task = p.tasks.find((t) => t.id === taskId);
    if (
      !this.options.enabled ||
      this.options.dryRun ||
      !p.enabled ||
      !task ||
      !p.source ||
      !this.options.repositories.includes(p.repository)
    )
      throw new Blocker(
        "Disabled task, missing source or repository not allowlisted",
      );
    // Reject resource pressure before reading grants or performing Git IO.
    // Recheck again after verification and at the insertion boundary.
    if (!this.ports.schedulerAllows(p.repository))
      throw new Deferral("Canonical scheduler admission temporarily unavailable", this.now() + 60000);
    const grant = executionGrantSchema.safeParse(
      await this.ports.authorize(taskId),
    );
    if (!grant.success)
      throw new Blocker("Explicit automatic task authorization missing");
    const g = grant.data;
    if (
      g.taskId !== taskId ||
      g.policyHash !== hash(JSON.stringify(p)) ||
      g.repository !== p.repository ||
      g.baseCommit !== p.source.baseCommit ||
      g.provenanceHash !== p.source.provenanceHash ||
      g.ticketHash !== task.ticketHash ||
      g.expiresAt <= this.now()
    )
      throw new Blocker("Task authorization expired or pin mismatch");
    if (!(await this.ports.verifySource(g)))
      throw new Blocker("Actual source/ref/provenance verification failed");
    if (g.expiresAt <= this.now())
      throw new Blocker("Task authorization expired during verification");
    this.dependencies(taskId);
    if (!this.ports.schedulerAllows(p.repository))
      throw new Deferral("Canonical scheduler admission temporarily unavailable", this.now() + 60000);
    this.planner.tick();
    const report = this.planner.report();
    if (
      !actionEligible(p, taskId, report, {
        enabled: true,
        signedOffPolicyId: p.id,
        policyHash: g.policyHash,
        repository: g.repository,
        baseCommit: g.baseCommit,
        provenanceHash: g.provenanceHash,
        ticketHash: g.ticketHash,
        approvalsSatisfied: true,
        stateRechecked: true,
        schedulerAllows: true,
        usedBudget: 0,
        running: 0,
        elapsedMs: p.cooldownMs,
        alreadySubmitted: false,
      })
    )
      throw new Blocker("Fresh planner decision is blocked");
    return g;
  }
  async run(taskId: string) {
    if (
      !this.options.enabled ||
      this.options.dryRun ||
      this.busy ||
      this.halted
    )
      return this.report();
    this.busy = true;
    this.blocker = null;
    this.deferredUntil = null;
    let stage = "authorization";
    try {
      // Reconcile before considering any new action. Never resubmit an ambiguous
      // reservation: a crash before create requires operator investigation.
      stage = "reconciliation";
      this.store.transaction(() => {
        const rows = this.read();
        let changed = false;
        for (const row of rows) {
          const job = this.lookup(row.key);
          if (
            (row.state === "submitted" && (!job || row.jobId !== job.id)) ||
            (job && !this.matches(job, row))
          )
            throw new Blocker(
              "Reserved job input mismatch; operator inspection required",
            );
          if (job && row.state === "reserved") {
            row.state = "submitted";
            row.jobId = job.id;
            changed = true;
          }
        }
        if (changed) this.write(rows);
        this.attempts = rows;
      });
      const fingerprint = hash(JSON.stringify(this.policy));
      const key = hash(`sentinel:dev:v1:${fingerprint}:${taskId}`);
      if (this.attempts.some((a) => a.key === key && a.state === "submitted"))
        return this.report();
      stage = "authorization";
      await this.validate(taskId);
      stage = "reservation";
      this.store.transaction(() => {
        const rows = this.read();
        this.dependencies(taskId);
        if (rows.some((a) => a.state === "reserved" || !a.jobId))
          throw new Blocker(
            "Lane has unresolved attempt; operator inspection required",
          );
        const statuses = rows.map((a) => this.store.get(a.jobId!).status);
        const progressing = new Set([
          "CREATED",
          "QUEUED",
          "PREPARING",
          "CODEX_RUNNING",
          "REVIEWING",
          "CHANGES_REQUESTED",
          "ACCEPTED",
        ]);
        if (
          statuses.some(
            (status) => status !== "COMPLETED" && !progressing.has(status),
          )
        )
          throw new Blocker("Lane job requires operator inspection");
        if (statuses.some((status) => status !== "COMPLETED"))
          throw new Deferral("Lane occupied; awaiting workflow completion");
        if (rows.some((a) => a.key === key))
          throw new Blocker("Action already attempted");
        if (rows.length >= this.policy.budget)
          throw new Blocker("Lane job cap reached");
        if (rows.some((a) => this.now() - a.at < this.policy.cooldownMs))
          throw new Deferral(
            "Lane cooldown active",
            Math.max(...rows.map((a) => a.at + this.policy.cooldownMs)),
          );
        rows.push({
          taskId,
          key,
          policyHash: fingerprint,
          at: this.now(),
          state: "reserved",
          jobId: null,
        });
        this.write(rows);
      });
      stage = "pre-submit validation";
      const grant = await this.validate(taskId);
      // No await between final dependency/admission check and invoking core.create.
      this.dependencies(taskId);
      if (!this.ports.schedulerAllows(this.policy.repository))
        throw new Blocker("Canonical scheduler admission blocked");
      stage = "submission";
      const job = await this.ports.create(this.input(taskId, key), () => {
        if (
          !this.options.enabled ||
          this.options.dryRun ||
          grant.expiresAt <= this.now() ||
          (this.ports.revalidateGrant && !this.ports.revalidateGrant(grant))
        )
          throw new Blocker(
            "Task authorization expired or execution disabled before insertion",
          );
        this.dependencies(taskId);
        if (!this.ports.schedulerAllows(this.policy.repository))
          throw new Blocker("Canonical scheduler admission blocked");
        return undefined;
      });
      stage = "submission reconciliation";
      this.store.transaction(() => {
        const rows = this.read();
        const row = rows.find((a) => a.key === key)!;
        const persisted = this.lookup(key);
        if (
          !persisted ||
          persisted.id !== job.id ||
          !this.matches(persisted, row)
        )
          throw new Blocker(
            "Submission not reconciled; operator inspection required",
          );
        row.state = "submitted";
        row.jobId = job.id;
        this.write(rows);
      });
      this.blocker = null;
    } catch (error) {
      // Never expose arbitrary provider errors (tokens/paths). No automatic retry.
      const safe = error instanceof Blocker;
      this.blocker = safe
        ? error.message
        : `${stage} failed; operator inspection required`;
      this.halted = !(
        error instanceof Deferral &&
        (stage === "reservation" || stage === "authorization")
      );
      if (!this.halted && error instanceof Deferral)
        this.deferredUntil = error.wakeAt;
    } finally {
      this.busy = false;
    }
    return this.report();
  }
}

// Protected provenance is obtained from trusted service storage, not a ticket
// or worker-writable repository file. Its hash is independently pinned in grant.
export function gitSourceVerifier(
  workspace: Pick<GitWorkspace, "repository" | "resolve">,
  provenance: (grant: ExecutionGrant) => Promise<string>,
) {
  return async (grant: ExecutionGrant) => {
    const repository = await workspace.repository(grant.repository);
    if (repository !== grant.repository) return false;
    if (
      (await workspace.resolve(repository, grant.sourceRef)) !==
      grant.baseCommit
    )
      return false;
    if (
      (await workspace.resolve(repository, grant.baseCommit)) !==
      grant.baseCommit
    )
      return false;
    const text = await provenance(grant);
    if (text.length > 65536 || hash(text) !== grant.provenanceHash)
      return false;
    const record = z
      .strictObject({
        repository: z.string(),
        baseCommit: z.string(),
        sourceRef: z.string(),
      })
      .safeParse(JSON.parse(text));
    return (
      record.success &&
      record.data.repository === repository &&
      record.data.baseCommit === grant.baseCommit &&
      record.data.sourceRef === grant.sourceRef
    );
  };
}

// Host binding only: constructing this function does not create jobs or change
// configuration. Runtime retries must already be disabled by trusted operator.
export function coreCreatePort(
  core: Pick<Orchestrator, "create" | "config">,
): ExecutionPorts["create"] {
  return (input, beforeCreate) => {
    if (core.config.maxRuntimeRetries !== 0)
      throw new Blocker("Canonical scheduler runtime retries must be disabled");
    const approved = createSchema.parse(input);
    return core.create(approved, (source) => {
      if (
        source.repository !== approved.repository ||
        source.baseCommit !== approved.startRef
      )
        throw new Blocker("Actual source changed during creation preparation");
      if (core.config.maxRuntimeRetries !== 0)
        throw new Blocker(
          "Canonical scheduler runtime retries must be disabled",
        );
      return beforeCreate();
    });
  };
}

