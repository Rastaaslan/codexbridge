import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import {
  assertTransition,
  projectInputSchema,
  projectSchema,
  featureInputSchema,
  featureSchema,
  dependencyIdsSchema,
  type Job,
  type Status,
  type CreateInput,
  type Review,
} from "./domain.js";
import { redact } from "./log.js";

export class Store extends EventEmitter {
  db: DatabaseSync;
  constructor(file: string) {
    super();
    this.db = new DatabaseSync(file);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    const version = (
      this.db.prepare("PRAGMA user_version").get() as { user_version: number }
    ).user_version;
    if (version > 2)
      throw new Error("Database is newer than this codexbridge version.");
    if (version === 0)
      this.db.exec(`BEGIN IMMEDIATE;
   CREATE TABLE jobs (seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,data TEXT NOT NULL,idempotency_key TEXT UNIQUE);
   CREATE TABLE job_events (id INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL REFERENCES jobs(id),time TEXT NOT NULL,type TEXT NOT NULL,data TEXT NOT NULL);
   CREATE INDEX events_job ON job_events(job_id,id);
   CREATE TABLE codex_threads (job_id TEXT PRIMARY KEY REFERENCES jobs(id),thread_id TEXT NOT NULL);
   CREATE TABLE reviews (id INTEGER PRIMARY KEY,job_id TEXT NOT NULL REFERENCES jobs(id),iteration INTEGER NOT NULL,data TEXT NOT NULL);
   CREATE TABLE human_decisions (id INTEGER PRIMARY KEY,job_id TEXT NOT NULL REFERENCES jobs(id),time TEXT NOT NULL,action TEXT NOT NULL,instruction TEXT NOT NULL);
   CREATE TABLE repository_locks (repository TEXT PRIMARY KEY,job_id TEXT NOT NULL);
   CREATE TABLE settings (key TEXT PRIMARY KEY,value TEXT NOT NULL);
   PRAGMA user_version=1; COMMIT;`);
    if (version < 2)
      this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE projects (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE features (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE job_hierarchy (job_id TEXT PRIMARY KEY REFERENCES jobs(id), project_id TEXT NOT NULL REFERENCES projects(id), feature_id TEXT REFERENCES features(id));
        CREATE TABLE job_dependencies (job_id TEXT NOT NULL REFERENCES jobs(id), dependency_id TEXT NOT NULL REFERENCES jobs(id), PRIMARY KEY(job_id, dependency_id), CHECK(job_id != dependency_id));
        CREATE INDEX dependencies_target ON job_dependencies(dependency_id);
        PRAGMA user_version=2; COMMIT;`);
  }
  createProject(input: unknown) {
    const { name } = projectInputSchema.parse(input);
    return this.transaction(() => {
      const seq = this.db
        .prepare("SELECT COALESCE(MAX(seq),0)+1 AS seq FROM projects")
        .get()!;
      const project = {
        id: `PR-${seq.seq}`,
        name,
        createdAt: new Date().toISOString(),
      };
      this.db
        .prepare("INSERT INTO projects(id,name,created_at) VALUES(?,?,?)")
        .run(project.id, name, project.createdAt);
      return project;
    });
  }
  projects() {
    return this.db
      .prepare(
        "SELECT id,name,created_at AS createdAt FROM projects ORDER BY seq",
      )
      .all()
      .map((r) => projectSchema.parse(r));
  }
  createFeature(input: unknown) {
    const { name, projectId } = featureInputSchema.parse(input);
    if (!this.projects().some((p) => p.id === projectId))
      throw Error(`Project ${projectId} not found`);
    return this.transaction(() => {
      const seq = this.db
        .prepare("SELECT COALESCE(MAX(seq),0)+1 AS seq FROM features")
        .get()!;
      const feature = {
        id: `FT-${seq.seq}`,
        projectId,
        name,
        createdAt: new Date().toISOString(),
      };
      this.db
        .prepare(
          "INSERT INTO features(id,project_id,name,created_at) VALUES(?,?,?,?)",
        )
        .run(feature.id, projectId, name, feature.createdAt);
      return feature;
    });
  }
  features() {
    return this.db
      .prepare(
        "SELECT id,project_id AS projectId,name,created_at AS createdAt FROM features ORDER BY seq",
      )
      .all()
      .map((r) => featureSchema.parse(r));
  }
  private hierarchy(input: CreateInput) {
    const feature = input.featureId
      ? this.features().find((f) => f.id === input.featureId)
      : undefined;
    if (input.featureId && !feature)
      throw Error(`Feature ${input.featureId} not found`);
    const projectId = input.projectId ?? feature?.projectId;
    if (feature && feature.projectId !== projectId)
      throw Error("Feature does not belong to project");
    if (projectId && !this.projects().some((p) => p.id === projectId))
      throw Error(`Project ${projectId} not found`);
    return { ...input, projectId };
  }
  private writeDependencies(id: string, dependencies: string[]) {
    const ids = [...new Set(dependencyIdsSchema.parse(dependencies))].sort();
    for (const dependency of ids) {
      if (dependency === id) throw Error("Self-dependency is not allowed");
      if (!this.db.prepare("SELECT 1 FROM jobs WHERE id=?").get(dependency))
        throw Error(`Unknown dependency ${dependency}`);
      const cycle = this.db
        .prepare(
          `WITH RECURSIVE ancestors(id) AS (
        SELECT ? UNION SELECT dependency_id FROM job_dependencies JOIN ancestors ON job_id=ancestors.id
      ) SELECT 1 FROM ancestors WHERE id=?`,
        )
        .get(dependency, id);
      if (cycle) throw Error("Dependency cycle is not allowed");
    }
    this.db.prepare("DELETE FROM job_dependencies WHERE job_id=?").run(id);
    for (const dependency of ids)
      this.db
        .prepare("INSERT INTO job_dependencies VALUES(?,?)")
        .run(id, dependency);
  }
  setDependencies(id: string, dependencies: string[]) {
    return this.transaction(() => {
      const job = this.get(id);
      if (job.status !== "QUEUED" || job.worktree || job.iteration !== 0)
        throw Error("Dependencies can only change before a queued job starts");
      this.writeDependencies(id, dependencies);
      this.event(id, "DEPENDENCIES_UPDATED", { dependencies });
      return this.get(id);
    });
  }
  private projectJob(raw: Job): Job {
    const hierarchy = this.db
      .prepare("SELECT project_id,feature_id FROM job_hierarchy WHERE job_id=?")
      .get(raw.id);
    const dependencyStatuses = this.db
      .prepare(
        "SELECT j.id,j.data FROM job_dependencies d JOIN jobs j ON j.id=d.dependency_id WHERE d.job_id=? ORDER BY j.id",
      )
      .all(raw.id)
      .map((r) => {
        const status = (JSON.parse(String(r.data)) as Job).status;
        const state =
          status === "COMPLETED"
            ? ("SATISFIED" as const)
            : ["FAILED", "CANCELLED"].includes(status)
              ? ("BLOCKED" as const)
              : ("WAITING" as const);
        return { id: String(r.id), status, state };
      });
    const dependencyState = dependencyStatuses.some(
      (d) => d.state === "BLOCKED",
    )
      ? "BLOCKED"
      : dependencyStatuses.some((d) => d.state === "WAITING")
        ? "WAITING"
        : "SATISFIED";
    return {
      ...raw,
      projectId: hierarchy ? String(hierarchy.project_id) : undefined,
      featureId: hierarchy?.feature_id
        ? String(hierarchy.feature_id)
        : undefined,
      dependencies: dependencyStatuses.map((d) => d.id),
      dependencyStatuses,
      dependencyState,
      schedulingState:
        raw.status !== "QUEUED"
          ? "INACTIVE"
          : dependencyState === "SATISFIED"
            ? "READY"
            : dependencyState,
    };
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const x = fn();
      this.db.exec("COMMIT");
      return x;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  create(input: CreateInput, baseCommit: string | null = null): Job {
    input = this.hierarchy(input);
    return this.transaction(() => {
      if (input.options.idempotencyKey) {
        const row = this.db
          .prepare("SELECT data FROM jobs WHERE idempotency_key=?")
          .get(input.options.idempotencyKey);
        if (row) {
          const prior = this.projectJob(JSON.parse(String(row.data)) as Job);
          if (
            prior.ticket !== input.ticket ||
            prior.repository !== input.repository ||
            prior.title !== input.title ||
            prior.startRef !== input.startRef ||
            prior.projectId !== input.projectId ||
            prior.featureId !== input.featureId ||
            JSON.stringify(prior.dependencies) !==
              JSON.stringify([...new Set(input.dependencies ?? [])].sort()) ||
            JSON.stringify(prior.acceptanceCriteria) !==
              JSON.stringify(input.acceptanceCriteria) ||
            prior.maxIterations !== input.options.maxIterations
          )
            throw new Error(
              "Idempotency key already used with different input",
            );
          return prior;
        }
      }
      const seq = this.db
        .prepare("INSERT INTO jobs(data,idempotency_key) VALUES (?,?)")
        .run("{}", input.options.idempotencyKey ?? null).lastInsertRowid;
      const now = new Date().toISOString();
      const job: Job = {
        ...input,
        id: `CB-${seq}`,
        status: "QUEUED",
        codexThreadId: null,
        branch: null,
        worktree: null,
        baseCommit,
        iteration: 0,
        maxIterations: input.options.maxIterations,
        createdAt: now,
        updatedAt: now,
        result: null,
        blocker: null,
        metadata: {},
        feedback: null,
        childPid: null,
      };
      this.db
        .prepare("UPDATE jobs SET id=?,data=? WHERE seq=?")
        .run(job.id, JSON.stringify(job), seq);
      if (input.projectId)
        this.db
          .prepare("INSERT INTO job_hierarchy VALUES(?,?,?)")
          .run(job.id, input.projectId, input.featureId ?? null);
      this.writeDependencies(job.id, input.dependencies ?? []);
      this.event(job.id, "JOB_CREATED", { title: job.title });
      return this.get(job.id);
    });
  }
  get(id: string): Job {
    const row = this.db.prepare("SELECT data FROM jobs WHERE id=?").get(id);
    if (!row) throw new Error(`Job ${id} not found`);
    return this.projectJob(JSON.parse(String(row.data)));
  }
  list(): Job[] {
    return this.db
      .prepare("SELECT data FROM jobs ORDER BY seq DESC")
      .all()
      .map((r) => this.projectJob(JSON.parse(String(r.data))));
  }
  patch(id: string, patch: Partial<Job>) {
    const job = {
      ...this.get(id),
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.db
      .prepare("UPDATE jobs SET data=? WHERE id=?")
      .run(JSON.stringify(job), id);
    return this.get(id);
  }
  transition(id: string, status: Status, patch: Partial<Job> = {}) {
    return this.transaction(() => {
      assertTransition(this.get(id).status, status);
      const j = this.patch(id, { ...patch, status });
      this.event(id, `JOB_${status}`, {
        blocker: j.blocker,
        iteration: j.iteration,
      });
      return j;
    });
  }
  event(id: string, type: string, data: unknown = {}) {
    const clean = redact(data);
    this.db
      .prepare("INSERT INTO job_events(job_id,time,type,data) VALUES(?,?,?,?)")
      .run(id, new Date().toISOString(), type, clean);
    queueMicrotask(() => this.emit("event", id, type));
  }
  events(id: string, after = 0, limit = 300) {
    this.get(id);
    return this.db
      .prepare(
        "SELECT id,time,type,data FROM job_events WHERE job_id=? AND id>? ORDER BY id LIMIT ?",
      )
      .all(id, after, limit)
      .map((r) => ({
        id: Number(r.id),
        time: String(r.time),
        type: String(r.type),
        data: JSON.parse(String(r.data)),
      }));
  }
  thread(id: string, threadId: string) {
    this.transaction(() => {
      this.patch(id, { codexThreadId: threadId });
      this.db
        .prepare("INSERT OR REPLACE INTO codex_threads VALUES(?,?)")
        .run(id, threadId);
      this.event(id, "CODEX_THREAD", { threadId });
    });
  }
  review(id: string, iteration: number, review: Review) {
    this.db
      .prepare("INSERT INTO reviews(job_id,iteration,data) VALUES(?,?,?)")
      .run(id, iteration, JSON.stringify(review));
    this.event(id, `REVIEW_${review.decision}`, review);
  }
  reviews(id: string) {
    return this.db
      .prepare("SELECT iteration,data FROM reviews WHERE job_id=? ORDER BY id")
      .all(id)
      .map((r) => ({ iteration: r.iteration, ...JSON.parse(String(r.data)) }));
  }
  decision(id: string, action: string, instruction: string) {
    this.db
      .prepare(
        "INSERT INTO human_decisions(job_id,time,action,instruction) VALUES(?,?,?,?)",
      )
      .run(id, new Date().toISOString(), action, instruction);
    this.event(id, "HUMAN_DECISION", { action, instruction });
  }
  decisions(id: string) {
    return this.db
      .prepare(
        "SELECT time,action,instruction FROM human_decisions WHERE job_id=? ORDER BY id",
      )
      .all(id);
  }
  lock(repository: string, id: string) {
    this.db
      .prepare("INSERT INTO repository_locks VALUES(?,?)")
      .run(repository, id);
  }
  unlock(id: string) {
    this.db.prepare("DELETE FROM repository_locks WHERE job_id=?").run(id);
  }
  close() {
    this.db.close();
  }
}
