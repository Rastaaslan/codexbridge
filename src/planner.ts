import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createSchema, refSchema, type Job } from "./domain.js";
import type { Store } from "./database.js";
import type { GitWorkspace } from "./git.js";
import type { Integration } from "./integration.js";

const key = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
export const roadmapInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  repository: z.string().min(1),
  startRef: refSchema,
  features: z
    .array(
      z.strictObject({
        key,
        title: createSchema.shape.title,
        ticket: createSchema.shape.ticket,
        acceptanceCriteria: createSchema.shape.acceptanceCriteria,
        priority: createSchema.shape.priority,
        executionCost: createSchema.shape.executionCost,
        dependencies: z.array(key).max(100).default([]),
        inheritFrom: key.optional(),
      }),
    )
    .min(1)
    .max(100),
});
const bindingSchema = z.strictObject({
  featureId: z.string(),
  jobId: z.string(),
});
export const roadmapSchema = z.strictObject({
  id: z.string(),
  version: z.number().int(),
  validatedVersion: z.number().int().nullable(),
  state: z.enum(["planned", "validated", "materialized", "complete"]),
  projectId: z.string().nullable(),
  baseCommit: z.string(),
  input: roadmapInputSchema,
  bindings: z.record(z.string(), bindingSchema),
});
export const roadmapIdSchema = z.strictObject({ id: z.string().uuid() });
export const roadmapVersionSchema = roadmapIdSchema.extend({
  version: z.number().int().min(1),
});
export const roadmapRevisionSchema = roadmapVersionSchema.extend({
  roadmap: roadmapInputSchema,
});
export const featureStateSchema = z.strictObject({
  key,
  jobId: z.string().nullable(),
  state: z.enum([
    "planned",
    "materialized",
    "running",
    "waiting-for-dependency",
    "waiting-for-review",
    "waiting-for-integration",
    "blocked",
    "complete",
  ]),
  reason: z.string().nullable(),
  failed: z.boolean(),
  exhausted: z.boolean(),
});
export const plannerReadSchema = z.strictObject({
  roadmap: roadmapSchema,
  features: z.array(featureStateSchema),
});
export const plannerSummarySchema = z.strictObject({
  projectId: z.string().nullable(),
  roadmapId: z.string(),
  version: z.number(),
  nextRunnable: z.array(key),
  blockers: z.array(featureStateSchema),
  integrationWaits: z.array(featureStateSchema),
  failed: z.array(featureStateSchema),
  humanAttention: z.array(featureStateSchema),
});
type Plan = z.infer<typeof roadmapSchema>;
type Input = z.infer<typeof roadmapInputSchema>;
function graph(input: unknown): Input {
  const parsed = roadmapInputSchema.parse(input);
  const keys = new Set(parsed.features.map((f) => f.key));
  if (keys.size !== parsed.features.length)
    throw Error("Duplicate feature key");
  const visiting = new Set<string>(),
    visited = new Set<string>();
  const visit = (k: string) => {
    if (visiting.has(k)) throw Error("Roadmap dependency cycle");
    if (visited.has(k)) return;
    const f = parsed.features.find((f) => f.key === k);
    if (!f) throw Error(`Unknown feature dependency ${k}`);
    f.dependencies = [...new Set(f.dependencies)].sort();
    if (f.inheritFrom && !f.dependencies.includes(f.inheritFrom))
      throw Error("inheritFrom must be an explicit dependency");
    visiting.add(k);
    for (const d of f.dependencies) visit(d);
    visiting.delete(k);
    visited.add(k);
  };
  for (const k of keys) visit(k);
  return parsed;
}
function started(j: Job) {
  return (
    j.status !== "QUEUED" ||
    !!j.worktree ||
    !!j.branch ||
    !!j.codexThreadId ||
    j.iteration > 0 ||
    j.retry.count > 0 ||
    !!j.metadata.plannerStarted
  );
}
export class Planner {
  constructor(
    private store: Store,
    private git: GitWorkspace,
    private integration: Integration,
  ) {}
  get(id: string): Plan {
    const row = this.store.db
      .prepare("SELECT data FROM roadmaps WHERE id=?")
      .get(id);
    if (!row) throw Error("Roadmap not found");
    const plan = roadmapSchema.parse(JSON.parse(String(row.data)));
    // JSON and schema parsing restore ordinary prototypes; normalize at every load.
    plan.bindings = Object.assign(Object.create(null), plan.bindings);
    return plan;
  }
  private save(p: Plan) {
    const data = JSON.stringify(p);
    this.store.db
      .prepare(
        "INSERT INTO roadmaps VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(p.id, data);
    this.store.db
      .prepare(
        "INSERT INTO roadmap_versions VALUES(?,?,?) ON CONFLICT(id,version) DO UPDATE SET data=excluded.data",
      )
      .run(p.id, p.version, data);
  }
  async create(input: unknown) {
    const parsed = graph(input);
    parsed.repository = await this.git.repository(parsed.repository);
    const baseCommit = await this.git.resolve(
      parsed.repository,
      parsed.startRef,
    );
    const p: Plan = {
      id: randomUUID(),
      version: 1,
      validatedVersion: null,
      state: "planned",
      projectId: null,
      baseCommit,
      input: parsed,
      bindings: Object.create(null),
    };
    this.store.transaction(() => this.save(p));
    return this.read(p.id);
  }
  private version(id: string, version: number) {
    const p = this.get(id);
    if (p.version !== version) throw Error("Stale roadmap version");
    return p;
  }
  validate(id: string, version: number) {
    return this.store.transaction(() => {
      const p = this.version(id, version);
      graph(p.input);
      p.validatedVersion = version;
      if (!p.projectId) p.state = "validated";
      this.save(p);
      return this.read(id);
    });
  }
  revise(id: string, version: number, input: unknown) {
    const next = graph(input);
    return this.store.transaction(() => {
      const p = this.version(id, version);
      if (
        next.repository !== p.input.repository ||
        next.startRef !== p.input.startRef
      )
        throw Error("Roadmap repository and baseline are immutable");
      for (const old of p.input.features) {
        const replacement = next.features.find((f) => f.key === old.key);
        if (!replacement) throw Error("Feature removal is unsupported");
        const binding = p.bindings[old.key];
        if (
          binding &&
          started(this.store.get(binding.jobId)) &&
          JSON.stringify(old) !== JSON.stringify(replacement)
        )
          throw Error(`Cannot revise started feature ${old.key}`);
      }
      p.input = next;
      p.version++;
      p.validatedVersion = null;
      // Hold all future jobs until this revision is validated and applied.
      for (const b of Object.values(p.bindings)) {
        const j = this.store.get(b.jobId);
        if (!started(j))
          this.store.patch(j.id, {
            metadata: {
              ...j.metadata,
              plannerWait: "Roadmap revision requires validation and apply",
            },
            readySince: null,
          });
      }
      p.state = "planned";
      this.save(p);
      return this.read(id);
    });
  }
  apply(id: string, version: number) {
    return this.store.transaction(() => {
      const p = this.version(id, version);
      if (p.validatedVersion !== version)
        throw Error("Validate this roadmap version before apply");
      if (["materialized", "complete"].includes(p.state))
        return this.reconcile(id);
      if (!p.projectId)
        p.projectId = this.store.createProject({ name: p.input.name }).id;
      for (const f of p.input.features) {
        if (!p.bindings[f.key]) {
          const feature = this.store.createFeature({
            name: f.title,
            projectId: p.projectId,
          });
          const job = this.store.create(
            createSchema.parse({
              ...this.jobInput(f),
              repository: p.input.repository,
              startRef: p.baseCommit,
              projectId: p.projectId,
              featureId: feature.id,
            }),
            p.baseCommit,
          );
          this.store.patch(job.id, {
            metadata: {
              roadmapId: id,
              plannerWait: "Awaiting roadmap reconciliation",
            },
          });
          p.bindings[f.key] = { featureId: feature.id, jobId: job.id };
        }
      }
      // Clear old edges first: safe revisions may reverse edges between future jobs.
      for (const b of Object.values(p.bindings))
        if (!started(this.store.get(b.jobId)))
          this.store.setDependencies(b.jobId, [], true);
      for (const f of p.input.features) {
        const b = p.bindings[f.key],
          j = this.store.get(b.jobId);
        if (started(j)) continue;
        this.store.patch(j.id, this.jobInput(f));
        this.store.db
          .prepare("UPDATE features SET name=? WHERE id=?")
          .run(f.title, b.featureId);
        this.store.setDependencies(
          j.id,
          f.dependencies.map((d) => p.bindings[d].jobId),
          true,
        );
      }
      p.state = "materialized";
      this.save(p);
      return this.reconcile(id);
    });
  }
  private jobInput(f: Input["features"][number]) {
    return {
      title: f.title,
      ticket: f.ticket,
      acceptanceCriteria: f.acceptanceCriteria,
      priority: f.priority,
      executionCost: f.executionCost,
    };
  }
  reconcile(id: string) {
    return this.store.transaction(() => {
      const p = this.get(id);
      if (!["materialized", "complete"].includes(p.state)) return this.read(id);
      for (const f of p.input.features) {
        const j = this.store.get(p.bindings[f.key].jobId);
        if (started(j)) continue;
        let wait: string | null = null,
          commit = p.baseCommit,
          integrationId: number | null = null;
        if (f.inheritFrom) {
          const predecessor = this.store.get(p.bindings[f.inheritFrom].jobId);
          const result = this.integration
            .history(predecessor.id)
            .find(
              (a) =>
                a.status === "SUCCEEDED" &&
                a.repository === j.repository &&
                a.resultCommit,
            );
          if (predecessor.status !== "COMPLETED" || !result)
            wait = `Waiting for completion and explicit integration of ${f.inheritFrom}`;
          else if (
            !this.integration.matchesAcceptedReview(predecessor.id, result)
          )
            wait = `Integration evidence for ${f.inheritFrom} does not match its current sealed accepted review. Review and explicitly integrate the current work before continuing; an older integration cannot supply this baseline.`;
          else {
            commit = result.resultCommit!;
            integrationId = result.id;
          }
        }
        if (
          j.metadata.plannerWait !== wait ||
          j.baseCommit !== commit ||
          j.metadata.integrationId !== integrationId
        )
          this.store.patch(j.id, {
            startRef: commit,
            baseCommit: commit,
            readySince: wait ? null : j.readySince,
            metadata: { ...j.metadata, plannerWait: wait, integrationId },
          });
      }
      if (
        Object.values(p.bindings).every(
          (b) => this.store.get(b.jobId).status === "COMPLETED",
        )
      )
        p.state = "complete";
      this.save(p);
      return this.read(id);
    });
  }
  reconcileAll() {
    for (const row of this.store.db.prepare("SELECT id FROM roadmaps").all())
      this.reconcile(String(row.id));
  }
  read(id: string) {
    const p = this.get(id);
    const features = p.input.features.map((f) => {
      const b = p.bindings[f.key],
        j = b ? this.store.get(b.jobId) : null;
      let state: z.infer<typeof featureStateSchema>["state"] = "planned",
        reason: string | null = null;
      if (j) {
        if (j.status === "COMPLETED") state = "complete";
        else if (
          ["FAILED", "CANCELLED", "WAITING_FOR_HUMAN"].includes(j.status)
        ) {
          state = "blocked";
          reason = j.blocker ?? j.status;
        } else if (
          ["REVIEWING", "ACCEPTED", "READY_FOR_HUMAN_TEST"].includes(j.status)
        )
          state = "waiting-for-review";
        else if (j.status !== "QUEUED") state = "running";
        else if (j.dependencyState === "BLOCKED") {
          state = "blocked";
          reason = "Predecessor failed or cancelled";
        } else if (j.dependencyState !== "SATISFIED") {
          state = "waiting-for-dependency";
          reason = "Predecessor completion required";
        } else if (j.metadata.plannerWait) {
          state =
            f.inheritFrom && p.state !== "planned"
              ? "waiting-for-integration"
              : "blocked";
          reason = String(j.metadata.plannerWait);
        } else {
          state = "materialized";
          reason = j.admissionReason;
        }
      }
      return {
        key: f.key,
        jobId: j?.id ?? null,
        state,
        reason,
        failed: !!j && ["FAILED", "CANCELLED"].includes(j.status),
        exhausted: j?.retry.exhausted ?? false,
      };
    });
    return { roadmap: p, features };
  }
  summary(id: string) {
    const { roadmap: p, features } = this.read(id);
    return {
      projectId: p.projectId,
      roadmapId: id,
      version: p.version,
      nextRunnable: features
        .filter(
          (f) =>
            f.state === "materialized" &&
            f.jobId &&
            !Object.values(this.store.get(f.jobId).pauseState).some(Boolean),
        )
        .map((f) => f.key),
      blockers: features.filter((f) =>
        ["blocked", "waiting-for-dependency"].includes(f.state),
      ),
      integrationWaits: features.filter(
        (f) => f.state === "waiting-for-integration",
      ),
      failed: features.filter((f) => f.failed || f.exhausted),
      humanAttention: features.filter((f) =>
        ["blocked", "waiting-for-review", "waiting-for-integration"].includes(
          f.state,
        ),
      ),
    };
  }
}
