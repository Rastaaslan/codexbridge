import { SentinelDispatch, type SentinelHost } from "./sentinel-dispatch.js";
import type { SentinelExecutor } from "./sentinel-executor.js";
import { SentinelDev } from "./sentinel-dev.js";
import { Planner } from "./planner.js";
import { SentinelMini } from "./sentinel.js";
import { Integration } from "./integration.js";
import type { Config } from "./config.js";
import { Store } from "./database.js";
import { GitWorkspace } from "./git.js";
import {
  activeStatuses,
  createSchema,
  errorMessage,
  resultSchema,
  type Job,
} from "./domain.js";
import {
  HumanRequired,
  TransientRuntimeError,
  type CodexAdapter,
} from "./codex.js";
import type { Reviewer } from "./reviewer.js";
import { logger } from "./log.js";

import { maintenance } from "./headless.js";

export function alive(pid: number | null) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
export class Orchestrator {
  // Operator-only injected host; ordinary application construction stays inert.
  readonly sentinelDispatch?: SentinelDispatch;
  sentinelExecutionBlocker: string | null = null;
  sentinelExecutor?: SentinelExecutor;
  readonly sentinel: SentinelMini;
  readonly sentinelDev: SentinelDev;
  readonly integration: Integration;
  readonly planner: Planner;
  restarting = false;
  private running = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  private timer?: NodeJS.Timeout;
  private stopping = false;
  private ticking = false;
  readonly log: ReturnType<typeof logger>;
  constructor(
    readonly config: Config,
    readonly store: Store,
    readonly git: GitWorkspace,
    private adapter: CodexAdapter,
    private reviewer: Reviewer,
    sentinelHost?: SentinelHost,
  ) {
    this.integration = new Integration(config, store, git);
    this.planner = new Planner(store, git, this.integration);
    this.log = logger(config.dataDir);
    this.sentinel = new SentinelMini(store, config.sentinelEnabled);
    this.sentinelDev = new SentinelDev(
      store,
      this.sentinel,
      config.sentinelDevPolicy,
    );
    if (config.sentinelExecutionEnabled) {
      if (
        !sentinelHost ||
        typeof sentinelHost.authorize !== "function" ||
        typeof sentinelHost.verifySource !== "function" ||
        typeof sentinelHost.schedulerAllows !== "function" ||
        !Array.isArray(sentinelHost.repositories) ||
        !config.sentinelEnabled ||
        !config.sentinelDevPolicy?.enabled
      )
        this.sentinelExecutionBlocker =
          "Execution disabled: protected host services and enabled observer/policy required";
      else if (config.maxRuntimeRetries !== 0)
        this.sentinelExecutionBlocker =
          "Execution disabled: automatic runtime retries must be disabled";
      else {
        try {
          this.sentinelDispatch = new SentinelDispatch(this, sentinelHost);
          this.sentinelExecutor = this.sentinelDispatch.executor;
        } catch {
          this.sentinelExecutionBlocker =
            "Execution disabled: protected host initialization failed";
        }
      }
    }
    store.on("event", (jobId: string, type: string) => {
      this.sentinelDispatch?.notify(type);
      if (!["CODEX_MESSAGE", "CODEX_OUTPUT"].includes(type))
        this.log(type === "CODEX_ERROR" ? "warn" : "info", type, jobId);
    });
  }
  private recovery?: Promise<void>;
  recover() {
    if (this.recovery) return this.recovery;
    this.recovery = this.recoverJobs().finally(() => {
      this.recovery = undefined;
    });
    return this.recovery;
  }
  private async recoverJobs() {
    await this.integration.recover();
    for (const job of this.store.list()) {
      if (activeStatuses.includes(job.status)) {
        let state = "No worktree created.";
        try {
          if (job.worktree) {
            const d = await this.git.diff(job);
            state = `Worktree intact. Git status: ${d.status || "clean"}. Thread: ${job.codexThreadId ?? "not started"}.`;
          }
        } catch (e) {
          state = errorMessage(e);
        }
        // A cancellation or other mutation during Git inspection wins.
        if (JSON.stringify(this.store.get(job.id)) !== JSON.stringify(job))
          continue;
        const message = `Interrupted service. ${state} ${alive(job.childPid) ? "Old Codex process still alive; retry is blocked until it exits." : "Retry resumes the saved thread and inspects existing changes before continuing."}`;
        this.store.patch(job.id, {
          metadata: { ...job.metadata, recoveredFrom: job.status },
        });
        if (job.status === "CODEX_RUNNING" && !job.result)
          this.runtimeFailure(job.id, message);
        else this.store.transition(job.id, "FAILED", { blocker: message });
        this.store.event(job.id, "RECOVERY", {
          previousStatus: job.status,
          threadId: job.codexThreadId,
          worktree: job.worktree,
        });
      } else if (job.status === "CHANGES_REQUESTED")
        this.store.transition(job.id, "QUEUED");
      else if (job.status === "ACCEPTED")
        this.store.transition(job.id, "READY_FOR_HUMAN_TEST");
      if (!alive(job.childPid)) this.store.unlock(job.id);
    }
    this.planner.reconcileAll();
  }
  start() {
    this.stopping = false;
    this.timer = setInterval(() => void this.tick(), 500);
    void this.tick();
  }
  async stop() {
    this.sentinelDispatch?.stop();
    this.sentinel.stop();
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    for (const r of this.running.values()) r.controller.abort();
    await Promise.allSettled([...this.running.values()].map((r) => r.promise));
    await this.integration.settle();
  }
  async integrate(input: unknown) {
    if (this.recovery) await this.recovery;
    if (this.restarting || maintenance(this.config.dataDir) || this.stopping)
      throw Error("Service stopping or maintenance in progress");
    return this.integration.integrate(input);
  }
  async create(
    input: unknown,
    beforeCreate?: (source: {
      repository: string;
      baseCommit: string | null;
    }) => undefined,
  ) {
    if (this.recovery) await this.recovery;
    if (this.restarting || maintenance(this.config.dataDir))
      throw new Error("Update maintenance in progress; retry shortly.");
    const parsed = createSchema.parse(input);
    parsed.repository = await this.git.repository(parsed.repository);
    // Invalid refs cannot leave a queued job; replays retain the original commit.
    const prior = parsed.options.idempotencyKey
      ? this.store
          .list()
          .find(
            (j) => j.options.idempotencyKey === parsed.options.idempotencyKey,
          )
      : undefined;
    const baseCommit =
      parsed.startRef && !prior
        ? await this.git.resolve(parsed.repository, parsed.startRef)
        : null;
    // Optional trusted-host guard runs after asynchronous Git work, immediately
    // before the synchronous Store transaction. Normal API callers are unchanged.
    beforeCreate?.({ repository: parsed.repository, baseCommit });
    const job = this.store.create(parsed, baseCommit);
    void this.tick();
    return job;
  }
  async tick() {
    if (
      this.restarting ||
      maintenance(this.config.dataDir) ||
      this.stopping ||
      this.ticking ||
      this.recovery
    )
      return;
    this.ticking = true;
    try {
      this.sentinelDev.tick();
      void this.sentinelDispatch?.tick();
      for (const job of this.store.list())
        if (
          !activeStatuses.includes(job.status) &&
          !this.running.has(job.id) &&
          !alive(job.childPid)
        )
          this.store.unlock(job.id);
      const now = Date.now();
      for (const job of this.store.list()) {
        if (
          job.status === "FAILED" &&
          job.retry.nextRetryAt &&
          Date.parse(job.retry.nextRetryAt) <= now &&
          !alive(job.childPid) &&
          !this.running.has(job.id)
        )
          this.store.transition(job.id, "QUEUED", {
            retry: { ...job.retry, nextRetryAt: null },
          });
      }
      this.planner.reconcileAll();
      const score = (job: Job) =>
        Math.min(
          100,
          job.priority +
            Math.floor(
              Math.max(
                0,
                now - Date.parse(job.readySince ?? new Date(now).toISOString()),
              ) / this.config.schedulerAgingMs,
            ),
        );
      const jobs = this.store
        .list()
        .sort(
          (a, b) =>
            score(b) - score(a) ||
            Number(a.id.slice(3)) - Number(b.id.slice(3)),
        );
      let reserved = false;
      for (let job of jobs) {
        if (job.status !== "QUEUED") continue;
        let reason: string | null = null;
        if (job.schedulingState !== "READY") {
          reason = job.metadata.plannerWait
            ? String(job.metadata.plannerWait)
            : `Dependencies ${job.dependencyState?.toLowerCase()}`;
          if (job.readySince)
            job = this.store.patch(job.id, { readySince: null });
        } else {
          if (!job.readySince)
            job = this.store.patch(job.id, {
              readySince: new Date(now).toISOString(),
            });
          const active = this.store
            .list()
            .filter(
              (j) =>
                activeStatuses.includes(j.status) ||
                this.running.has(j.id) ||
                alive(j.childPid),
            );
          const used = active.reduce((n, j) => n + j.executionCost, 0);
          const limit =
            this.config.repositoryConcurrencyLimits[job.repository] ??
            this.config.maxConcurrentJobs;
          if (job.pauseState.project) reason = "Project admission paused";
          else if (job.pauseState.repository)
            reason = "Repository admission paused";
          else if (alive(job.childPid) || this.running.has(job.id))
            reason = "Previous worker still active";
          else if (job.executionCost > this.capacity)
            reason = "Execution cost exceeds scheduler capacity";
          else if (
            active.filter((j) => j.repository === job.repository).length >=
            limit
          )
            reason = "Repository concurrency limit reached";
          else if (active.length >= this.config.maxConcurrentJobs)
            reason = "Global concurrency limit reached";
          else if (reserved) reason = "Capacity reserved for an aged READY job";
          else if (used + job.executionCost > this.capacity) {
            reason = "Insufficient weighted capacity";
            // Drain capacity for aged expensive jobs instead of letting small arrivals starve them.
            if (score(job) === 100) reserved = true;
          }
          if (!reason) {
            try {
              this.store.lock(job.repository, job.id);
            } catch {
              reason = "Repository preparation or integration lock held";
            }
          }
        }
        if (reason) {
          if (job.admissionReason !== reason)
            this.store.patch(job.id, { admissionReason: reason });
          continue;
        }
        if (job.metadata.roadmapId)
          this.store.patch(job.id, {
            metadata: { ...job.metadata, plannerStarted: true },
          });
        const controller = new AbortController();
        const promise = this.run(job.id, controller.signal).finally(() => {
          this.running.delete(job.id);
          if (!alive(this.store.get(job.id).childPid))
            this.store.unlock(job.id);
        });
        this.running.set(job.id, { controller, promise });
      }
    } finally {
      this.ticking = false;
    }
  }
  get capacity() {
    return this.config.schedulerCapacity ?? this.config.maxConcurrentJobs;
  }
  scheduler() {
    const active = this.store
      .list()
      .filter(
        (j) =>
          activeStatuses.includes(j.status) ||
          this.running.has(j.id) ||
          alive(j.childPid),
      );
    return {
      maxConcurrentJobs: this.config.maxConcurrentJobs,
      capacity: this.capacity,
      usedCapacity: active.reduce((n, j) => n + j.executionCost, 0),
      runningJobs: active.length,
      repositoryLimits: this.config.repositoryConcurrencyLimits,
      pauses: this.store.pauses(),
    };
  }
  async setAdmission(input: {
    scope: "project" | "repository";
    target: string;
    paused: boolean;
  }) {
    if (this.recovery) await this.recovery;
    if (input.scope === "repository")
      input = { ...input, target: await this.git.repository(input.target) };
    const control = this.store.setPause(input);
    await this.tick();
    return control;
  }
  private runtimeFailure(id: string, message: string) {
    const job = this.store.get(id);
    const exhausted = job.retry.count >= this.config.maxRuntimeRetries;
    const retry = {
      count: job.retry.count + (exhausted ? 0 : 1),
      nextRetryAt: exhausted
        ? null
        : new Date(
            Date.now() +
              Math.min(
                this.config.retryMaxBackoffMs,
                this.config.retryBackoffMs * 2 ** job.retry.count,
              ),
          ).toISOString(),
      exhausted,
      lastError: message,
    };
    this.store.transition(id, "FAILED", {
      blocker: message,
      retry,
      // CODEX_RUNNING reserved this passage's iteration. A runtime failure did
      // not reach review: refund it atomically with the persisted retry state,
      // including when recovery detects an interrupted worker after restart.
      iteration: Math.max(0, job.iteration - 1),
    });
    this.store.event(
      id,
      exhausted ? "RUNTIME_RETRY_EXHAUSTED" : "RUNTIME_RETRY_SCHEDULED",
      retry,
    );
  }
  private async run(id: string, signal: AbortSignal) {
    let workerRuntime = false;
    try {
      let job = this.store.transition(id, "PREPARING", { blocker: null });
      if (!job.worktree) {
        const plan = await this.git.plan(job);
        job = this.store.patch(id, plan);
      }
      await this.git.prepare(job);

      // Le dépôt parent n'est verrouillé que pendant la création/validation
      // du worktree. Le travail Codex suivant est isolé dans job.worktree.
      this.store.unlock(id);
      void this.tick();
      signal.throwIfAborted();
      this.store.event(id, "WORKTREE_READY", {
        branch: job.branch,
        worktree: job.worktree,
      });
      job = this.store.transition(id, "CODEX_RUNNING", {
        result: null,
        iteration: job.iteration + 1,
      });
      const prompt = `Job ${job.id}: ${job.title}\nOriginal ticket:\n${job.ticket}\nAcceptance criteria:\n${job.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n${job.feedback ? "Feedback / human decision:\n" + job.feedback : ""}\n${job.metadata.recoveredFrom ? "This is recovery after interruption. Inspect existing changes and tests; do not repeat completed external actions." : ""}\nImplement the ticket and run meaningful tests. Report test commands and actual outcomes accurately. Return the structured result. If compilation or tests fail, fix them before reporting. Never push, publish, deploy, or merge. If credentials or a genuine product decision are missing, return blocked with a precise question.`;
      const callbacks = {
        signal,
        onPid: (pid: number | null) => {
          this.store.patch(id, { childPid: pid });
        },
        onEvent: (type: string, data: unknown) =>
          this.store.event(id, type, data),
      };
      workerRuntime = true;
      const result = resultSchema.parse(
        await this.adapter.run({
          cwd: job.worktree!,
          threadId: job.codexThreadId,
          prompt,
          schema: resultSchema,
          ...callbacks,
          onThread: (thread) => this.store.thread(id, thread),
        }),
      );
      workerRuntime = false;
      signal.throwIfAborted();
      job = this.store.patch(id, { result });
      if (result.requiresHumanDecision) {
        this.store.transition(id, "WAITING_FOR_HUMAN", {
          blocker: result.questions.join("\n") || result.summary,
        });
        return;
      }
      job = this.store.transition(id, "REVIEWING");
      const snapshot = await this.integration.snapshot(job);
      const diff = await this.integration.reviewDiff(job, snapshot);
      const context = { job, diff, history: this.store.reviews(id) };
      // Large immutable tree diffs must be fully inspected, not merely previewed.
      // Coverage is determined by the trusted adapter, never a model claim.
      const chunked =
        diff.truncated && this.reviewer.reviewAllChunks
          ? await this.reviewer.reviewAllChunks(context, callbacks)
          : null;
      const review = chunked
        ? chunked.review
        : await this.reviewer.review(context, callbacks);
      const verifiedFullDiff =
        !diff.truncated ||
        !!(
          chunked?.coverageSha256 &&
          chunked.coverageSha256 === diff.fullDiffSha256 &&
          diff.reviewChunks?.length
        );
      signal.throwIfAborted();
      // Evidence guard: a model cannot accept known failed tests or an
      // incomplete review. Legacy/mock reviewers without full coverage fail closed.
      if (
        review.decision === "ACCEPT" &&
        (result.status === "blocked" ||
          !result.testsPassed ||
          result.testsExecuted.length === 0 ||
          !verifiedFullDiff)
      ) {
        review.decision = "REQUEST_CHANGES";
        review.requestedChanges.push(
          !verifiedFullDiff
            ? "Full diff review coverage missing; require bounded independent segment review."
            : "Finish the implementation, run meaningful tests successfully and include the test commands in the result.",
        );
      }
      this.store.review(id, job.iteration, review);
      if (review.decision === "HUMAN_REQUIRED") {
        this.store.transition(id, "WAITING_FOR_HUMAN", {
          blocker: review.humanQuestion || review.summary,
        });
        return;
      }
      if (review.decision === "ACCEPT") {
        if (
          JSON.stringify(snapshot) !==
          JSON.stringify(await this.integration.snapshot(job))
        )
          throw Error("Reviewed-diff drift during review");
        this.integration.seal(id, snapshot);
        this.store.transition(id, "ACCEPTED");
        this.store.transition(id, "READY_FOR_HUMAN_TEST");
        return;
      }
      this.store.transition(id, "CHANGES_REQUESTED", {
        feedback: `Review iteration ${job.iteration}:\n${JSON.stringify(review)}`,
      });
      if (job.iteration >= job.maxIterations)
        this.store.transition(id, "FAILED", {
          blocker: `Iteration budget (${job.maxIterations}) exhausted. Review the report and retry with additional instructions.`,
        });
      else this.store.transition(id, "QUEUED");
    } catch (e) {
      const job = this.store.get(id);
      if (job.status === "CANCELLED") return;
      const message = errorMessage(e);
      this.log("error", message, id);
      if (
        e instanceof HumanRequired &&
        (job.status === "CODEX_RUNNING" || job.status === "REVIEWING")
      )
        this.store.transition(id, "WAITING_FOR_HUMAN", { blocker: message });
      else if (
        workerRuntime &&
        e instanceof TransientRuntimeError &&
        !signal.aborted
      )
        this.runtimeFailure(id, message);
      else if (activeStatuses.includes(job.status))
        this.store.transition(id, "FAILED", { blocker: message });
    }
  }
  async action(id: string, action: string, instruction = "") {
    if (this.recovery) await this.recovery;
    if (this.integration.active(id)) throw Error("Integration in progress");
    const job = this.store.get(id);
    if (action === "cancel") {
      if (job.status === "CANCELLED") return job;
      this.store.transition(id, "CANCELLED", {
        retry: { ...job.retry, nextRetryAt: null },
      });
      const run = this.running.get(id);
      run?.controller.abort();
      if (run) await run.promise;
      this.store.decision(id, action, instruction);
      return this.store.get(id);
    }
    if (this.running.has(id) || activeStatuses.includes(job.status))
      throw new Error("Job is active. Cancel it before changing instructions.");
    if (alive(job.childPid))
      throw new Error(
        "Previous Codex process is still alive; cannot safely resume yet.",
      );
    if (action === "approve") {
      if (job.status !== "READY_FOR_HUMAN_TEST")
        throw new Error("Only a job ready for human testing can be completed.");
      this.store.decision(id, action, instruction);
      const completed = this.store.transition(id, "COMPLETED");
      void this.tick();
      return completed;
    }
    if (!["retry", "send_instruction", "reject"].includes(action))
      throw new Error("Unknown action");
    if (action !== "retry" && !instruction.trim())
      throw new Error("An instruction or reason is required.");
    if (
      ![
        "FAILED",
        "CANCELLED",
        "WAITING_FOR_HUMAN",
        "READY_FOR_HUMAN_TEST",
      ].includes(job.status)
    )
      throw new Error("Job cannot be resumed in this state.");
    this.store.decision(id, action, instruction);
    const next = this.store.transition(id, "QUEUED", {
      retry: { count: 0, nextRetryAt: null, exhausted: false, lastError: null },
      feedback: instruction || job.feedback,
      blocker: null,
      maxIterations: Math.max(job.maxIterations, job.iteration + 5),
      childPid: null,
    });
    void this.tick();
    return next;
  }
  async report(id: string) {
    const job = this.store.get(id);
    let changes: unknown;
    try {
      changes = await this.git.diff(job);
    } catch (e) {
      changes = { error: errorMessage(e) };
    }
    return {
      job,
      changes,
      reviews: this.store.reviews(id),
      humanDecisions: this.store.decisions(id),
      integrations: this.integration.history(id),
      humanTestingInstructions: job.worktree
        ? `Inspect ${job.worktree}, run the reported tests and your functional checks. Approve to mark COMPLETED. Use integrate_job explicitly to create a verified local baseline.`
        : "Worktree not prepared yet.",
    };
  }
}
