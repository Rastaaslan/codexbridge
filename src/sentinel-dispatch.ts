import type { Orchestrator } from "./orchestrator.js";
import {
  SentinelExecutor,
  coreCreatePort,
  type ExecutionPorts,
} from "./sentinel-executor.js";

// Constructor-only trusted host capability. Never loaded from policy, JSON,
// event prose or public tools. Providers must use protected storage and bounded
// IO; verifySource must coordinate source/revocation changes with submission.
export interface SentinelHost {
  repositories: readonly string[];
  authorize: ExecutionPorts["authorize"];
  verifySource: ExecutionPorts["verifySource"];
  schedulerAllows: ExecutionPorts["schedulerAllows"];
  revalidateGrant?: ExecutionPorts["revalidateGrant"];
  now?: () => number;
}

// Uses the existing scheduler cadence: one coalesced pass per relevant event,
// plus one deadline check for a known cooldown. No new timer or journal reader.
export class SentinelDispatch {
  readonly executor: SentinelExecutor;
  private dirty = true;
  private stopped = false;
  private pending?: Promise<void>;
  private wakeAt: number | null = null;
  private readonly options;
  private readonly now;
  constructor(
    private readonly core: Orchestrator,
    host: SentinelHost,
  ) {
    this.now = host.now ?? Date.now;
    this.options = { enabled: true, repositories: [...host.repositories] };
    this.executor = new SentinelExecutor(
      core.store,
      core.sentinelDev,
      core.config.sentinelDevPolicy!,
      {
        authorize: host.authorize,
        verifySource: host.verifySource,
        revalidateGrant: host.revalidateGrant,
        schedulerAllows: (repository) =>
          !this.stopped && host.schedulerAllows(repository),
        create: coreCreatePort(core),
      },
      this.options,
      this.now,
    );
  }
  notify(type: string) {
    if (
      !this.stopped &&
      /^JOB_(CREATED|QUEUED|PREPARING|CODEX_RUNNING|REVIEWING|CHANGES_REQUESTED|ACCEPTED|COMPLETED|FAILED|CANCELLED|WAITING_FOR_HUMAN|READY_FOR_HUMAN_TEST)$/.test(
        type,
      )
    )
      this.dirty = true;
  }
  tick(): Promise<void> {
    try {
      if (this.pending) return this.pending;
      if (
        this.stopped ||
        this.executor.isHalted ||
        (!this.dirty && (this.wakeAt === null || this.now() < this.wakeAt))
      )
        return Promise.resolve();
      this.dirty = false;
      this.wakeAt = null;
      this.pending = this.dispatch()
        .catch(() => {
          // Sentinel errors never propagate to scheduler/startup or leak provider text.
          this.stop();
          this.core.sentinelExecutionBlocker =
            "Sentinel dispatch failed; operator inspection required";
        })
        .finally(() => {
          this.pending = undefined;
        });
      return this.pending;
    } catch {
      this.stop();
      this.core.sentinelExecutionBlocker =
        "Sentinel dispatch failed; operator inspection required";
      return Promise.resolve();
    }
  }
  private async dispatch() {
    this.core.sentinel.tick();
    const observation = this.core.sentinel.report();
    if (observation.observation === "observing" && observation.replayPending) {
      // One bounded replay window per existing scheduler tick, never a loop.
      this.dirty = true;
      return;
    }
    this.core.sentinelDev.tick();
    const report = this.executor.report();
    const task = this.core.config.sentinelDevPolicy!.tasks.find(
      (t) =>
        !report.attempts.some(
          (a) => a.taskId === t.id && a.state === "submitted",
        ),
    );
    if (!task) return;
    // Reconcile an ambiguous reservation even if the planner is now blocked.
    // run() cannot replay its create; it only associates a durable matching job.
    if (
      !report.attempts.some((a) => a.taskId === task.id) &&
      !this.core.sentinelDev
        .report()
        .decisions.some(
          (d) => d.taskId === task.id && d.status === "ready-for-code",
        )
    )
      return;
    const next = await this.executor.run(task.id);
    if (this.stopped) return;
    // Reconciliation emits no lifecycle event. Its durable state change earns
    // one follow-up on the existing cadence so the next task is considered.
    if (
      !this.executor.isHalted &&
      report.attempts.some(
        (before) =>
          before.state === "reserved" &&
          next.attempts.some(
            (after) => after.key === before.key && after.state === "submitted",
          ),
      )
    )
      this.dirty = true;
    this.wakeAt = this.executor.deferredUntil;
  }
  stop() {
    this.stopped = true;
    this.options.enabled = false; // Also cancels in-flight pre-insertion guards.
    this.dirty = false;
    this.wakeAt = null;
  }
}

