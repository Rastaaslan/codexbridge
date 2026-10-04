import { redact } from "./log.js";
import { z } from "zod";
import { mkdtemp, rm, mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { git, type GitWorkspace } from "./git.js";
import type { Store } from "./database.js";
import type { Config } from "./config.js";
import { errorMessage, type Job } from "./domain.js";
const exec = promisify(execFile);
const snapshotSchema = z.strictObject({
  evidenceVersion: z.literal(2).optional(),
  baseCommit: z.string(),
  sourceCommit: z.string(),
  tree: z.string(),
  diffIdentity: z.string(),
  status: z.string(),
  iteration: z.number(),
});
export const integrationInputSchema = z.strictObject({
  id: z.string().regex(/^CB-\d+$/),
  target: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/),
  expectedBase: z.string().regex(/^[0-9a-f]{40,64}$/),
});
export const integrationSchema = z.strictObject({
  id: z.number(),
  jobId: z.string(),
  repository: z.string(),
  ref: z.string(),
  expectedBase: z.string(),
  previousCommit: z.string().nullable(),
  snapshot: snapshotSchema.nullable(),
  resultCommit: z.string().nullable(),
  status: z.enum(["VERIFYING", "PUBLISHING", "SUCCEEDED", "FAILED"]),
  commands: z.array(
    z.strictObject({
      command: z.string(),
      args: z.array(z.string()),
      timeoutMs: z.number(),
    }),
  ),
  results: z.array(
    z.strictObject({
      command: z.string(),
      args: z.array(z.string()),
      exitCode: z.number().nullable(),
      output: z.string(),
      startedAt: z.string(),
      finishedAt: z.string(),
    }),
  ),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  failure: z.string().nullable(),
});
type Attempt = z.infer<typeof integrationSchema>;
export class Integration {
  // Terminal results are persisted before cleanup; pending operations remain
  // active until execute() has also finished removing the candidate worktree.
  private pending = new Map<Promise<Attempt>, string>();
  get activeOperations() {
    return this.pending.size;
  }
  async settle() {
    await Promise.allSettled([...this.pending.keys()]);
  }
  async integrate(input: unknown) {
    const request = integrationInputSchema.parse(input);
    const promise = this.execute(request);
    this.pending.set(promise, request.id);
    try {
      return await promise;
    } finally {
      this.pending.delete(promise);
    }
  }
  constructor(
    private config: Config,
    private store: Store,
    private workspace: GitWorkspace,
  ) {}
  async snapshot(job: Job) {
    await this.workspace.repository(job.repository);
    await this.workspace.validate(job);
    if (!job.baseCommit) throw Error("Source base missing");
    const root = path.join(this.config.dataDir, "integration");
    await mkdir(root, { recursive: true });
    const tmp = await mkdtemp(path.join(root, "index-"));
    try {
      const env = { GIT_INDEX_FILE: path.join(tmp, "index") };
      // Preserve staged additions (including force-added ignored files), then
      // rebuild without index flags/stat caches that can hide working changes.
      const sourceIndex = await git(job.worktree!, [
        "rev-parse",
        "--git-path",
        "index",
      ]);
      await copyFile(
        path.resolve(job.worktree!, sourceIndex),
        env.GIT_INDEX_FILE,
      );
      const stagedTree = await git(job.worktree!, ["write-tree"], env);
      await rm(env.GIT_INDEX_FILE);
      await git(job.worktree!, ["read-tree", stagedTree], env);
      await git(job.worktree!, ["add", "-A", "--", "."], env);
      const tree = await git(job.worktree!, ["write-tree"], env);
      return {
        evidenceVersion: 2 as const,
        baseCommit: job.baseCommit,
        sourceCommit: await this.workspace.resolve(job.worktree!, "HEAD"),
        tree,
        diffIdentity: createHash("sha256")
          .update(`${job.baseCommit}\n${tree}`)
          .digest("hex"),
        status: await git(job.worktree!, [
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
        ]),
        iteration: job.iteration,
      };
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
  async reviewDiff(job: Job, snapshot: z.infer<typeof snapshotSchema>) {
    // The immutable tree is the sole source of review evidence and integration.
    const args = ["diff", "--no-ext-diff", "--no-textconv", "--no-renames"];
    const diff = await git(job.repository, [
      ...args,
      "--binary",
      "--full-index",
      snapshot.baseCommit,
      snapshot.tree,
      "--",
    ]);
    return {
      diff: diff.slice(0, 500000),
      changedFiles: (
        await git(job.repository, [
          ...args,
          "--name-only",
          "-z",
          snapshot.baseCommit,
          snapshot.tree,
          "--",
        ])
      )
        .split("\0")
        .filter(Boolean),
      commits: await git(job.repository, [
        "log",
        "--oneline",
        `${snapshot.baseCommit}..${snapshot.sourceCommit}`,
      ]),
      status: snapshot.status,
      truncated: diff.length > 500000,
    };
  }
  seal(id: string, snapshot: z.infer<typeof snapshotSchema>) {
    this.store.db
      .prepare("INSERT OR REPLACE INTO reviewed_snapshots VALUES(?,?)")
      .run(id, JSON.stringify(snapshot));
  }
  history(id: string): Attempt[] {
    this.store.get(id);
    return this.store.db
      .prepare("SELECT data FROM integrations WHERE job_id=? ORDER BY id")
      .all(id)
      .map((r) => integrationSchema.parse(JSON.parse(String(r.data))));
  }
  matchesAcceptedReview(id: string, attempt: Attempt) {
    const job = this.store.get(id);
    const row = this.store.db
      .prepare("SELECT data FROM reviewed_snapshots WHERE job_id=?")
      .get(id);
    const review = this.store.reviews(id).at(-1);
    if (
      !row ||
      review?.decision !== "ACCEPT" ||
      review.iteration !== job.iteration
    )
      return false;
    const sealed = snapshotSchema.parse(JSON.parse(String(row.data)));
    return (
      attempt.jobId === id &&
      sealed.evidenceVersion === 2 &&
      sealed.iteration === job.iteration &&
      sealed.baseCommit === job.baseCommit &&
      JSON.stringify(attempt.snapshot) === JSON.stringify(sealed)
    );
  }
  active(id: string) {
    return (
      [...this.pending.values()].includes(id) ||
      this.history(id).some((a) =>
        ["VERIFYING", "PUBLISHING"].includes(a.status),
      )
    );
  }
  private async removeCandidate(repository: string, candidate: string) {
    await git(repository, ["worktree", "remove", "--force", candidate]);
  }
  private save(a: Attempt) {
    this.store.db
      .prepare("UPDATE integrations SET status=?,data=? WHERE id=?")
      .run(a.status, JSON.stringify(a), a.id);
  }
  private async ref(repo: string, ref: string) {
    const entries = await git(repo, [
      "for-each-ref",
      "--format=%(refname) %(objectname) %(symref)",
      ref,
    ]);
    const entry = entries
      .split("\n")
      .find((line) => line.split(" ")[0] === ref);
    if (!entry) return null;
    const [, commit, symbolic] = entry.split(" ");
    if (symbolic) throw Error("Unsafe symbolic integration ref");
    return commit;
  }
  async recover() {
    const rows = this.store.db
      .prepare(
        "SELECT data FROM integrations WHERE status IN ('VERIFYING','PUBLISHING')",
      )
      .all();
    for (const row of rows) {
      const a = integrationSchema.parse(JSON.parse(String(row.data)));
      const current = await this.ref(a.repository, a.ref).catch(() => null);
      const published =
        a.status === "PUBLISHING" &&
        a.resultCommit !== null &&
        a.resultCommit === current;
      a.status = published ? "SUCCEEDED" : "FAILED";
      a.failure = published
        ? null
        : "Interrupted integration; candidate was not published. Retry explicitly.";
      a.finishedAt = new Date().toISOString();
      this.save(a);
    }
  }
  private async execute(input: unknown) {
    const request = integrationInputSchema.parse(input);
    const job = this.store.get(request.id);
    const ref = `refs/codexbridge/integration/${request.target}`;
    const success = this.history(job.id).find((a) => a.status === "SUCCEEDED");
    if (success) {
      const sealed = this.store.db
        .prepare("SELECT data FROM reviewed_snapshots WHERE job_id=?")
        .get(job.id);
      if (sealed && JSON.stringify(success.snapshot) !== String(sealed.data))
        throw Error("Conflicting duplicate integration: review changed");
      if (success.ref !== ref || success.expectedBase !== request.expectedBase)
        throw Error("Conflicting duplicate integration request");
      return success;
    }
    const a: Attempt = {
      id: 0,
      jobId: job.id,
      repository: job.repository,
      ref,
      expectedBase: request.expectedBase,
      previousCommit: null,
      snapshot: null,
      resultCommit: null,
      status: "VERIFYING",
      commands: structuredClone(this.config.integrationCommands),
      results: [],
      startedAt: new Date().toISOString(),
      finishedAt: null,
      failure: null,
    };
    this.store.transaction(() => {
      if (
        this.store.db
          .prepare(
            "SELECT 1 FROM integrations WHERE repository=? AND status IN ('VERIFYING','PUBLISHING')",
          )
          .get(job.repository)
      )
        throw Error("Conflicting integration already in progress");
      a.id = Number(
        this.store.db
          .prepare(
            "INSERT INTO integrations(job_id,repository,status,data) VALUES(?,?,?,?)",
          )
          .run(job.id, job.repository, a.status, "{}").lastInsertRowid,
      );
      this.save(a);
    });
    let candidate: string | undefined;
    try {
      if (
        !["READY_FOR_HUMAN_TEST", "COMPLETED"].includes(job.status) ||
        job.childPid
      )
        throw Error("Job is not eligible for integration");
      const row = this.store.db
        .prepare("SELECT data FROM reviewed_snapshots WHERE job_id=?")
        .get(job.id);
      if (!row || this.store.reviews(job.id).at(-1)?.decision !== "ACCEPT")
        throw Error("No sealed accepted review; review the job again");
      a.snapshot = snapshotSchema.parse(JSON.parse(String(row.data)));
      if (a.snapshot.evidenceVersion !== 2)
        throw Error(
          "Review evidence predates canonical snapshots; review the job again",
        );
      this.save(a);
      const checkSource = async () => {
        if (
          JSON.stringify(await this.snapshot(this.store.get(job.id))) !==
          JSON.stringify(a.snapshot)
        )
          throw Error("Reviewed-diff drift or unexpected dirty source state");
      };
      await checkSource();
      if (
        (await git(job.repository, ["ls-tree", "-r", a.snapshot.tree]))
          .split("\n")
          .some((line) => line.startsWith("160000 "))
      )
        throw Error("Submodule integration is unsupported");
      if (
        await git(job.repository, [
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
        ])
      )
        throw Error("Unexpected dirty repository state");
      a.previousCommit = await this.ref(job.repository, ref);
      if (
        request.expectedBase !== job.baseCommit ||
        (a.previousCommit && a.previousCommit !== request.expectedBase)
      )
        throw Error("Stale integration base");
      if (!a.commands.length)
        throw Error("Configure integrationCommands before integration");
      candidate = path.join(
        this.config.dataDir,
        "integration",
        `candidate-${a.id}`,
      );
      await git(job.repository, [
        "worktree",
        "add",
        "--detach",
        candidate,
        request.expectedBase,
      ]);
      await git(candidate, ["read-tree", "--reset", "-u", a.snapshot.tree]);
      const commit = await git(candidate, [
        "-c",
        "user.name=CodexBridge",
        "-c",
        "user.email=integration@codexbridge.invalid",
        "commit-tree",
        a.snapshot.tree,
        "-p",
        request.expectedBase,
        "-m",
        `Integrate ${job.id} reviewed ${a.snapshot.diffIdentity}`,
      ]);
      await git(candidate, ["reset", "--hard", commit]);
      for (const command of a.commands) {
        const startedAt = new Date().toISOString();
        let exitCode: number | null = 0,
          output = "";
        try {
          const result = await exec(command.command, command.args, {
            cwd: candidate,
            timeout: command.timeoutMs,
            maxBuffer: 1024 * 1024,
          });
          output = result.stdout + result.stderr;
        } catch (e) {
          const err = e as Error & {
            code?: number;
            stdout?: string;
            stderr?: string;
          };
          exitCode = typeof err.code === "number" ? err.code : null;
          output = (err.stdout ?? "") + (err.stderr ?? "") + err.message;
        }
        a.results.push({
          command: command.command,
          args: command.args,
          exitCode,
          output: redact(output).slice(0, 65536),
          startedAt,
          finishedAt: new Date().toISOString(),
        });
        this.save(a);
        if (exitCode !== 0) throw Error("Candidate verification failed");
      }
      if (
        (await git(candidate, [
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
        ])) ||
        (await this.workspace.resolve(candidate, "HEAD")) !== commit
      )
        throw Error("Verification changed candidate state");
      await checkSource();
      if (
        await git(job.repository, [
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
        ])
      )
        throw Error("Unexpected dirty repository state");
      a.resultCommit = commit;
      a.status = "PUBLISHING";
      this.save(a);
      await git(job.repository, [
        "update-ref",
        "--no-deref",
        ref,
        commit,
        a.previousCommit ?? "0".repeat(commit.length),
      ]);
      a.status = "SUCCEEDED";
      a.finishedAt = new Date().toISOString();
      this.save(a);
    } catch (e) {
      a.status = "FAILED";
      a.failure = errorMessage(e);
      a.finishedAt = new Date().toISOString();
      this.save(a);
    } finally {
      if (candidate)
        await this.removeCandidate(job.repository, candidate).catch(() => {});
    }
    return a;
  }
}
