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
import { HumanRequired, type CodexAdapter } from "./codex.js";
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
  ) {
    this.log = logger(config.dataDir);
    store.on("event", (jobId: string, type: string) => {
      if (!["CODEX_MESSAGE", "CODEX_OUTPUT"].includes(type))
        this.log(type === "CODEX_ERROR" ? "warn" : "info", type, jobId);
    });
  }
  async recover() {
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
        this.store.transition(job.id, "FAILED", {
          blocker: `Interrupted service. ${state} ${alive(job.childPid) ? "Old Codex process still alive; retry is blocked until it exits." : "Retry resumes the saved thread and inspects existing changes before continuing."}`,
          metadata: { ...job.metadata, recoveredFrom: job.status },
        });
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
  }
  start() {
    this.stopping = false;
    this.timer = setInterval(() => void this.tick(), 500);
    void this.tick();
  }
  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    for (const r of this.running.values()) r.controller.abort();
    await Promise.allSettled([...this.running.values()].map((r) => r.promise));
  }
  async create(input: unknown) {
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
      this.running.size >= this.config.maxConcurrentJobs
    )
      return;
    this.ticking = true;
    try {
      for (const job of this.store.list())
        if (
          !activeStatuses.includes(job.status) &&
          !this.running.has(job.id) &&
          !alive(job.childPid)
        )
          this.store.unlock(job.id);
      for (const job of this.store.list().reverse()) {
        if (this.running.size >= this.config.maxConcurrentJobs) break;
        if (job.status !== "QUEUED") continue;
        if (alive(job.childPid)) continue;
        try {
          this.store.lock(job.repository, job.id);
        } catch {
          continue;
        }
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
  private async run(id: string, signal: AbortSignal) {
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
      signal.throwIfAborted();
      job = this.store.patch(id, { result });
      if (result.requiresHumanDecision) {
        this.store.transition(id, "WAITING_FOR_HUMAN", {
          blocker: result.questions.join("\n") || result.summary,
        });
        return;
      }
      job = this.store.transition(id, "REVIEWING");
      const diff = await this.git.diff(job);
      const review = await this.reviewer.review(
        { job, diff, history: this.store.reviews(id) },
        callbacks,
      );
      signal.throwIfAborted();
      // Evidence guard: a model cannot accept a known failed test run or an incomplete diff.
      if (
        review.decision === "ACCEPT" &&
        (result.status === "blocked" ||
          !result.testsPassed ||
          result.testsExecuted.length === 0 ||
          diff.truncated)
      ) {
        review.decision = "REQUEST_CHANGES";
        review.requestedChanges.push(
          diff.truncated
            ? "Diff is incomplete; reduce scope or provide a reviewable change."
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
      else if (activeStatuses.includes(job.status))
        this.store.transition(id, "FAILED", { blocker: message });
    }
  }
  async action(id: string, action: string, instruction = "") {
    const job = this.store.get(id);
    if (action === "cancel") {
      if (job.status === "CANCELLED") return job;
      this.store.transition(id, "CANCELLED");
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
      return this.store.transition(id, "COMPLETED");
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
      humanTestingInstructions: job.worktree
        ? `Inspect ${job.worktree}, run the reported tests and your functional checks. Approve to mark COMPLETED. Integration and push remain explicit manual actions.`
        : "Worktree not prepared yet.",
    };
  }
}
