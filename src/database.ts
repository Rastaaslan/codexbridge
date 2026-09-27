import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import {
  assertTransition,
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
    if (version > 1)
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
    return this.transaction(() => {
      if (input.options.idempotencyKey) {
        const row = this.db
          .prepare("SELECT data FROM jobs WHERE idempotency_key=?")
          .get(input.options.idempotencyKey);
        if (row) {
          const prior = JSON.parse(String(row.data)) as Job;
          if (
            prior.ticket !== input.ticket ||
            prior.repository !== input.repository ||
            prior.title !== input.title ||
            prior.startRef !== input.startRef ||
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
      this.event(job.id, "JOB_CREATED", { title: job.title });
      return job;
    });
  }
  get(id: string): Job {
    const row = this.db.prepare("SELECT data FROM jobs WHERE id=?").get(id);
    if (!row) throw new Error(`Job ${id} not found`);
    return JSON.parse(String(row.data));
  }
  list(): Job[] {
    return this.db
      .prepare("SELECT data FROM jobs ORDER BY seq DESC")
      .all()
      .map((r) => JSON.parse(String(r.data)));
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
    return job;
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
