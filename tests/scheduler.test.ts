import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/database.js";
import { configSchema } from "../src/config.js";
import { createSchema, jobSchema } from "../src/domain.js";
import { Orchestrator } from "../src/orchestrator.js";
import { GitWorkspace } from "../src/git.js";
import {
  HumanRequired,
  TransientRuntimeError,
  type RunOptions,
} from "../src/codex.js";
import { toolDefinitions } from "../src/tools.js";

async function fixture(
  overrides = {},
  worker?: (o: RunOptions) => Promise<unknown>,
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cb-scheduler-"));
  const config = configSchema.parse({
    dataDir: dir,
    token: "x".repeat(32),
    ...overrides,
  });
  const file = path.join(dir, "state.db");
  const store = new Store(file);
  const calls: RunOptions[] = [];
  const git = new GitWorkspace(config);
  git.repository = async (p) => p;
  git.plan = async (j) => ({
    worktree: `/work/${j.id}`,
    branch: j.id,
    baseCommit: "base",
  });
  git.prepare = async () => {};
  const core = new Orchestrator(
    config,
    store,
    git,
    {
      async run(o) {
        calls.push(o);
        o.onThread(o.threadId ?? `thread-${calls.length}`);
        if (worker) return worker(o);
        return new Promise((_, reject) =>
          o.signal.addEventListener("abort", () => reject(Error("aborted")), {
            once: true,
          }),
        );
      },
    },
    {
      async review() {
        throw Error("Unexpected review");
      },
    },
  );
  const add = (extra = {}) =>
    store.create(
      createSchema.parse({
        title: "Job",
        ticket: "Work",
        repository: "/a",
        ...extra,
      }),
    );
  return {
    config,
    store,
    core,
    calls,
    file,
    add,
    async close() {
      await core.stop();
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
async function flush() {
  await new Promise((r) => setImmediate(r));
}
async function tick(core: Orchestrator) {
  await core.tick();
  await flush();
}

test("weighted capacity, hard ceiling, concrete persisted reasons and dependency gating", async () => {
  const f = await fixture({ schedulerCapacity: 3, maxConcurrentJobs: 2 });
  try {
    const a = f.add({ executionCost: 2 });
    const b = f.add({ executionCost: 2, repository: "/b" });
    const c = f.add({ repository: "/c" });
    const d = f.add({ dependencies: [a.id] });
    await tick(f.core);
    assert.equal(f.store.get(a.id).status, "CODEX_RUNNING");
    assert.equal(f.store.get(c.id).status, "CODEX_RUNNING");
    assert.match(f.store.get(b.id).admissionReason!, /capacity|concurrency/i);
    assert.equal(f.store.get(d.id).schedulingState, "WAITING");
    assert.match(f.store.get(d.id).admissionReason!, /Dependencies/);
    assert.equal(f.core.scheduler().usedCapacity, 3);
    await tick(f.core);
    assert.match(f.store.get(b.id).admissionReason!, /Global concurrency/);
    const reopened = new Store(f.file);
    assert.equal(
      reopened.get(b.id).admissionReason,
      f.store.get(b.id).admissionReason,
    );
    reopened.close();
  } finally {
    await f.close();
  }
});

test("repository concurrency does not block other repositories; FIFO breaks equal priority ties", async () => {
  const f = await fixture({
    repositoryConcurrencyLimits: { "/a": 1 },
    maxConcurrentJobs: 3,
  });
  try {
    const a = f.add(),
      b = f.add(),
      c = f.add({ repository: "/b" });
    await tick(f.core);
    assert.equal(f.store.get(a.id).status, "CODEX_RUNNING");
    assert.equal(f.store.get(b.id).status, "QUEUED");
    assert.match(f.store.get(b.id).admissionReason!, /Repository concurrency/);
    assert.equal(f.store.get(c.id).status, "CODEX_RUNNING");
    await f.core.action(a.id, "cancel");
    await tick(f.core);
    assert.equal(f.store.get(b.id).status, "CODEX_RUNNING");
  } finally {
    await f.close();
  }
});

test("priority ordering and bounded aging prevent starvation, including expensive jobs", async () => {
  const f = await fixture({
    maxConcurrentJobs: 2,
    schedulerCapacity: 2,
    schedulerAgingMs: 1000,
  });
  try {
    const old = f.add({ executionCost: 2 });
    const high = f.add({ priority: 100, repository: "/b" });
    await tick(f.core);
    assert.equal(f.store.get(high.id).status, "CODEX_RUNNING");
    assert.equal(f.store.get(old.id).status, "QUEUED");
    f.store.patch(old.id, {
      readySince: new Date(Date.now() - 101000).toISOString(),
    });
    const arrival = f.add({ priority: 100, repository: "/c" });
    await tick(f.core);
    assert.match(f.store.get(arrival.id).admissionReason!, /reserved/);
    await f.core.action(high.id, "cancel");
    await tick(f.core);
    assert.equal(f.store.get(old.id).status, "CODEX_RUNNING");
    assert.equal(f.store.get(arrival.id).status, "QUEUED");
  } finally {
    await f.close();
  }
});

test("project/repository pauses survive reopen and only affect new starts", async () => {
  const f = await fixture();
  try {
    const project = f.store.createProject({ name: "P" });
    const active = f.add({ projectId: project.id });
    await tick(f.core);
    await f.core.setAdmission({
      scope: "project",
      target: project.id,
      paused: true,
    });
    const queued = f.add({ projectId: project.id });
    const unrelated = f.add({ repository: "/b" });
    await tick(f.core);
    assert.equal(f.store.get(active.id).status, "CODEX_RUNNING");
    assert.match(
      f.store.get(queued.id).admissionReason!,
      /Project admission paused/,
    );
    assert.equal(f.store.get(unrelated.id).status, "CODEX_RUNNING");
    await f.core.setAdmission({
      scope: "repository",
      target: "/a",
      paused: true,
    });
    await f.core.setAdmission({
      scope: "project",
      target: project.id,
      paused: false,
    });
    assert.match(
      f.store.get(queued.id).admissionReason!,
      /Repository admission paused/,
    );
    const reopened = new Store(f.file);
    assert.equal(reopened.get(queued.id).pauseState.repository, true);
    reopened.close();
    await f.core.setAdmission({
      scope: "repository",
      target: "/a",
      paused: false,
    });
    await flush();
    assert.equal(f.store.get(queued.id).status, "CODEX_RUNNING");
  } finally {
    await f.close();
  }
});

test("bounded transient retries persist backoff and reuse worktree/thread across restart", async () => {
  const f = await fixture(
    { maxRuntimeRetries: 2, retryBackoffMs: 10000 },
    async () => {
      throw new TransientRuntimeError("transport reset");
    },
  );
  try {
    const j = f.add();
    await tick(f.core);
    let failed = f.store.get(j.id);
    assert.equal(failed.retry.count, 1);
    assert.ok(Date.parse(failed.retry.nextRetryAt!) > Date.now());
    await tick(f.core);
    assert.equal(f.calls.length, 1);
    const reopened = new Store(f.file);
    assert.deepEqual(reopened.get(j.id).retry, failed.retry);
    const resumed = new Orchestrator(
      f.config,
      reopened,
      f.core.git,
      {
        async run(o) {
          assert.equal(o.cwd, failed.worktree);
          assert.equal(o.threadId, failed.codexThreadId);
          throw new TransientRuntimeError("again");
        },
      },
      {
        async review() {
          throw Error("Unexpected");
        },
      },
    );
    try {
      await resumed.recover();
      await tick(resumed);
      assert.equal(reopened.get(j.id).retry.count, 1);
      reopened.patch(j.id, {
        retry: { ...failed.retry, nextRetryAt: new Date(0).toISOString() },
      });
      await tick(resumed);
      const second = reopened.get(j.id);
      assert.equal(second.retry.count, 2);
      assert.ok(Date.parse(second.retry.nextRetryAt!) - Date.now() > 18000);
      reopened.patch(j.id, {
        retry: { ...second.retry, nextRetryAt: new Date(0).toISOString() },
      });
      await tick(resumed);
      assert.equal(reopened.get(j.id).retry.exhausted, true);
      assert.equal(reopened.get(j.id).retry.nextRetryAt, null);
      await tick(resumed);
      assert.equal(reopened.get(j.id).status, "FAILED");
    } finally {
      await resumed.stop();
      reopened.close();
    }
  } finally {
    await f.close();
  }
});

test("unknown failures and human blockers never schedule runtime retries", async () => {
  for (const error of [
    new Error("test failed"),
    new Error("integration failed"),
    new Error("review rejected"),
    new HumanRequired("Choose product"),
  ]) {
    const f = await fixture({}, async () => {
      throw error;
    });
    try {
      const j = f.add();
      await tick(f.core);
      assert.equal(f.store.get(j.id).retry.count, 0);
      assert.equal(f.store.get(j.id).retry.nextRetryAt, null);
      assert.equal(
        f.store.get(j.id).status,
        error instanceof HumanRequired ? "WAITING_FOR_HUMAN" : "FAILED",
      );
    } finally {
      await f.close();
    }
  }
});

test("legacy defaults and strict shared MCP/API scheduler and overview surfaces", async () => {
  const f = await fixture();
  try {
    const j = f.add();
    const raw: any = { ...j };
    for (const key of [
      "priority",
      "executionCost",
      "retry",
      "readySince",
      "admissionReason",
      "pauseState",
    ])
      delete raw[key];
    f.store.db
      .prepare("UPDATE jobs SET data=? WHERE id=?")
      .run(JSON.stringify(raw), j.id);
    const legacy = jobSchema.parse(f.store.get(j.id));
    assert.equal(legacy.priority, 0);
    assert.equal(legacy.executionCost, 1);
    assert.equal(legacy.retry.count, 0);
    const custom = f.add({ priority: 42, executionCost: 3 });
    const reopened = new Store(f.file);
    assert.equal(reopened.get(custom.id).priority, 42);
    assert.equal(reopened.get(custom.id).executionCost, 3);
    reopened.close();
    for (const name of ["get_scheduler", "jobs_overview", "get_job"]) {
      const tool = toolDefinitions(f.core).find((t) => t.name === name)!;
      const result = await tool.run(
        tool.input.parse(name === "get_job" ? { id: j.id } : {}),
      );
      tool.output.parse(result);
      assert.equal(
        tool.output.safeParse({ ...result, unknown: true }).success,
        false,
      );
    }
    assert.equal(
      createSchema.safeParse({ ...raw, priority: 101 }).success,
      false,
    );
  } finally {
    await f.close();
  }
});

test("weighted capacity is independent of the job ceiling and oversized jobs remain inspectable", async () => {
  const f = await fixture({ maxConcurrentJobs: 5, schedulerCapacity: 3 });
  try {
    f.add({ executionCost: 2 });
    const waiting = f.add({ executionCost: 2, repository: "/b" });
    const oversized = f.add({ executionCost: 4, repository: "/c" });
    await tick(f.core);
    assert.equal(f.core.scheduler().runningJobs, 1);
    assert.match(
      f.store.get(waiting.id).admissionReason!,
      /Insufficient weighted capacity/,
    );
    assert.match(
      f.store.get(oversized.id).admissionReason!,
      /exceeds scheduler capacity/,
    );
  } finally {
    await f.close();
  }
});

test("cancellation clears pending retries and aborting a worker never retries", async () => {
  const f = await fixture({}, async () => {
    throw new TransientRuntimeError("reset");
  });
  try {
    const j = f.add();
    await tick(f.core);
    assert.ok(f.store.get(j.id).retry.nextRetryAt);
    await f.core.action(j.id, "cancel");
    await tick(f.core);
    assert.equal(f.store.get(j.id).retry.nextRetryAt, null);
    assert.equal(f.calls.length, 1);
  } finally {
    await f.close();
  }
  const active = await fixture();
  try {
    const j = active.add();
    await tick(active.core);
    await active.core.action(j.id, "cancel");
    assert.equal(active.store.get(j.id).retry.count, 0);
    assert.equal(active.store.get(j.id).status, "CANCELLED");
  } finally {
    await active.close();
  }
});

test("recovery schedules only interrupted workers and refuses to overlap a surviving process", async () => {
  const f = await fixture();
  try {
    const j = f.add();
    f.store.transition(j.id, "PREPARING");
    f.store.transition(j.id, "CODEX_RUNNING", {
      childPid: process.pid,
      codexThreadId: "saved",
      worktree: "/work/saved",
    });
    await f.core.recover();
    const recovered = f.store.get(j.id);
    assert.equal(recovered.retry.count, 1);
    f.store.patch(j.id, {
      retry: { ...recovered.retry, nextRetryAt: new Date(0).toISOString() },
    });
    await tick(f.core);
    assert.equal(f.calls.length, 0);
    f.store.patch(j.id, { childPid: null });
    await tick(f.core);
    assert.equal(f.calls[0].threadId, "saved");
    assert.equal(f.calls[0].cwd, "/work/saved");
  } finally {
    await f.close();
  }
});

test("structured product blockers, failed tests, review rejections and integration snapshot failures do not get runtime retries", async () => {
  for (const kind of [
    "human",
    "tests",
    "review",
    "integration",
    "review-runtime",
  ]) {
    const result = {
      status: "completed",
      summary: "Result",
      changedFiles: [],
      testsExecuted: ["npm test"],
      testsPassed: kind !== "tests",
      remainingIssues: [],
      questions: ["Choose"],
      requiresHumanDecision: kind === "human",
    };
    const f = await fixture({}, async () => result);
    try {
      f.core.integration.snapshot = async () => {
        if (kind === "integration")
          throw new TransientRuntimeError("Snapshot failure must not retry");
        return {} as any;
      };
      f.core.integration.reviewDiff = async () => ({
        diff: "",
        changedFiles: [],
        commits: "",
        status: "",
        truncated: false,
      });
      (f.core as any).reviewer = {
        async review() {
          if (kind === "review-runtime")
            throw new TransientRuntimeError("Reviewer runtime failure");
          return {
            decision: kind === "review" ? "REQUEST_CHANGES" : "ACCEPT",
            summary: "Review",
            issues: [],
            requestedChanges: [],
            humanQuestion: null,
          };
        },
      };
      const j = f.add({ options: { maxIterations: 1 } });
      await tick(f.core);
      assert.equal(f.store.get(j.id).retry.count, 0, kind);
      assert.equal(f.store.get(j.id).retry.nextRetryAt, null, kind);
      assert.equal(
        f.store.get(j.id).status,
        kind === "human" ? "WAITING_FOR_HUMAN" : "FAILED",
        kind,
      );
    } finally {
      await f.close();
    }
  }
});

test("recovery never retries a worker result persisted before its final status transition", async () => {
  const f = await fixture();
  try {
    for (const human of [true, false]) {
      const j = f.add();
      f.store.transition(j.id, "PREPARING");
      f.store.transition(j.id, "CODEX_RUNNING", {
        result: {
          status: "blocked",
          summary: "Needs attention",
          changedFiles: [],
          testsExecuted: ["npm test"],
          testsPassed: false,
          remainingIssues: [],
          questions: ["Choose"],
          requiresHumanDecision: human,
        },
      });
      await f.core.recover();
      assert.equal(f.store.get(j.id).status, "FAILED");
      assert.equal(f.store.get(j.id).retry.count, 0);
      assert.equal(f.store.get(j.id).retry.nextRetryAt, null);
    }
  } finally {
    await f.close();
  }
});

for (const interruption of [false, true]) {
  test(`runtime ${interruption ? "interruption" : "failure"} preserves correction budget across restart`, async () => {
    const f = await fixture({}, async () => {
      throw new TransientRuntimeError("Worker transport reset");
    });
    try {
      const j = f.add({ options: { maxIterations: 2 } });
      if (interruption) {
        f.store.transition(j.id, "PREPARING");
        f.store.transition(j.id, "CODEX_RUNNING", {
          iteration: 1,
          worktree: "/work/saved",
          codexThreadId: "saved",
        });
        await f.core.recover();
      } else await tick(f.core);
      const failed = f.store.get(j.id);
      assert.equal(failed.iteration, 0);
      assert.equal(failed.retry.count, 1);
      const reopened = new Store(f.file);
      let passages = 0;
      const resumed = new Orchestrator(
        f.config,
        reopened,
        f.core.git,
        {
          async run(o) {
            passages++;
            assert.equal(o.cwd, failed.worktree);
            assert.equal(o.threadId, failed.codexThreadId);
            return {
              status: "completed",
              summary: "Implemented",
              changedFiles: [],
              testsExecuted: ["npm test"],
              testsPassed: true,
              remainingIssues: [],
              questions: [],
              requiresHumanDecision: false,
            };
          },
        },
        {
          async review({ job }) {
            assert.equal(job.iteration, passages);
            return {
              decision: passages === 1 ? "REQUEST_CHANGES" : "ACCEPT",
              summary: "Review",
              issues: [],
              requestedChanges: [],
              humanQuestion: null,
            };
          },
        },
      );
      resumed.integration.snapshot = async () => ({}) as any;
      resumed.integration.reviewDiff = async () => ({
        diff: "",
        changedFiles: [],
        commits: "",
        status: "",
        truncated: false,
      });
      resumed.integration.seal = () => {};
      try {
        await resumed.recover();
        assert.equal(reopened.get(j.id).iteration, 0);
        reopened.patch(j.id, {
          retry: { ...failed.retry, nextRetryAt: new Date(0).toISOString() },
        });
        await tick(resumed);
        assert.equal(reopened.get(j.id).status, "QUEUED");
        assert.equal(reopened.get(j.id).iteration, 1);
        await tick(resumed);
        assert.equal(reopened.get(j.id).status, "READY_FOR_HUMAN_TEST");
        assert.equal(reopened.get(j.id).iteration, 2);
        assert.equal(reopened.get(j.id).retry.count, 1);
        assert.deepEqual(
          reopened.reviews(j.id).map((r) => r.iteration),
          [1, 2],
        );
      } finally {
        await resumed.stop();
        reopened.close();
      }
    } finally {
      await f.close();
    }
  });
}
