import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Store } from "../src/database.js";
import { configSchema } from "../src/config.js";
import { createSchema } from "../src/domain.js";
import { Orchestrator } from "../src/orchestrator.js";
import { GitWorkspace } from "../src/git.js";
import { devPolicySchema, hash } from "../src/sentinel-dev.js";
import type { SentinelHost } from "../src/sentinel-dispatch.js";
import { gitSourceVerifier } from "../src/sentinel-executor.js";
import { toolDefinitions } from "../src/tools.js";

function fixture(t: TestContext, enabled = true, realGit = false) {
  const dir = mkdtempSync(path.join(process.cwd(), ".sentinel-dispatch-"));
  let commit = "a".repeat(40);
  if (realGit) {
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_AUTHOR_NAME: "Fixture",
          GIT_AUTHOR_EMAIL: "fixture@example.invalid",
          GIT_COMMITTER_NAME: "Fixture",
          GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        },
      }).trim();
    try {
      git("init", "-q", "--initial-branch=main");
      git(
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "--allow-empty",
        "-qm",
        "synthetic fixture",
      );
      commit = git("rev-parse", "HEAD");
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error; // Optional caller skips EPERM; never retries or works around it.
    }
  }
  const file = path.join(dir, "state.sqlite");
  let store = new Store(file);
  const prerequisite = store.create(
    createSchema.parse({
      title: "synthetic prerequisite",
      ticket: "fixture",
      repository: dir,
    }),
  );
  store.patch(prerequisite.id, { status: "COMPLETED" });
  const policy = devPolicySchema.parse({
    id: "dispatch-fixture",
    enabled: true,
    repository: dir,
    source: {
      baseCommit: commit,
      provenanceHash: "b".repeat(64),
      approvedBy: "not-authority",
    },
    budget: 2,
    concurrency: 1,
    cooldownMs: 60000,
    tasks: ["fix1", "fix2"].map((id, i) => ({
      id,
      operation: "code-fix",
      dependencies: [i ? "CB-2" : prerequisite.id],
      requiredEvidence: [],
      ticket: "Synthetic correction",
      ticketHash: hash("Synthetic correction"),
    })),
  });
  const config = configSchema.parse({
    dataDir: dir,
    token: "x".repeat(32),
    sentinelEnabled: enabled,
    sentinelExecutionEnabled: enabled,
    sentinelDevPolicy: policy,
    maxRuntimeRetries: 0,
    repositoryRoots: [dir],
  });
  let now = 100000;
  let authorizationCalls = 0;
  let workerCalls = 0;
  const host: SentinelHost = {
    repositories: [dir],
    now: () => now,
    authorize: async (id) => {
      authorizationCalls++;
      return {
        permission: "automatic-code-fix",
        taskId: id,
        policyHash: hash(JSON.stringify(config.sentinelDevPolicy)),
        repository: dir,
        sourceRef: "refs/heads/main",
        baseCommit: policy.source!.baseCommit,
        provenanceHash: policy.source!.provenanceHash,
        ticketHash: policy.tasks[0].ticketHash,
        expiresAt: 999999,
      };
    },
    verifySource: async () => true, // Synthetic capability confined to this fixture.
    schedulerAllows: () => true,
  };
  const cores: Orchestrator[] = [];
  const make = (services: SentinelHost | undefined = host) => {
    const git = new GitWorkspace(config);
    if (!realGit) {
      git.repository = async (p) => p;
      git.resolve = async () => policy.source!.baseCommit;
    }
    git.plan = async (job) => ({
      worktree: dir,
      branch: `fixture-${job.id}`,
      baseCommit: policy.source!.baseCommit,
    });
    git.prepare = async () => {};
    const core = new Orchestrator(
      config,
      store,
      git,
      {
        async run() {
          workerCalls++;
          return {
            status: "completed",
            summary: "synthetic adapter",
            changedFiles: [],
            testsExecuted: ["synthetic"],
            testsPassed: true,
            remainingIssues: [],
            questions: [],
            requiresHumanDecision: false,
          };
        },
      },
      {
        async review() {
          return {
            decision: "ACCEPT",
            summary: "synthetic review",
            issues: [],
            requestedChanges: [],
            humanQuestion: null,
          };
        },
      },
      services,
    );
    // No real Git, shell, model or review artifact: isolate scheduler lifecycle.
    core.integration.snapshot = async () => ({}) as any;
    core.integration.reviewDiff = async () => ({ truncated: false }) as any;
    core.integration.seal = () => {};
    cores.push(core);
    return core;
  };
  t.after(async () => {
    for (const core of cores) await core.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    config,
    policy,
    host,
    make,
    get store() {
      return store;
    },
    prerequisite,
    authorizationCalls: () => authorizationCalls,
    workerCalls: () => workerCalls,
    advance: () => {
      now += 60000;
    },
    restart: async (core: Orchestrator) => {
      await core.stop();
      store.close();
      store = new Store(file);
      return make();
    },
  };
}
async function pump(core: Orchestrator) {
  await core.tick();
  await core.sentinelDispatch?.tick();
  // Bounded draining of synthetic scheduler promises, no polling sleep.
  for (let i = 0; i < 12; i++)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

test("real constructor defaults off and missing protected host remains disabled", async (t) => {
  const f = fixture(t, false);
  const core = f.make();
  await pump(core);
  assert.equal(core.sentinelDispatch, undefined);
  assert.equal(f.authorizationCalls(), 0);
  f.config.sentinelExecutionEnabled = true;
  f.config.sentinelEnabled = true;
  // Explicitly instantiate without a host; config is not authorization.
  const missing = new Orchestrator(
    f.config,
    f.store,
    core.git,
    {} as any,
    {} as any,
  );
  t.after(() => missing.stop());
  await pump(missing);
  const tool = toolDefinitions(missing).find(
    (x) => x.name === "get_sentinel_dev_actions",
  )!;
  assert.equal(tool.readOnly, true);
  assert.match((await tool.run({})).blocker, /protected host/);
  assert.equal(f.store.list().length, 1);
});

test("real dispatch/core.create/scheduler sequences two tasks once across durable restart", async (t) => {
  const f = fixture(t);
  let core = f.make();
  f.store.event(f.prerequisite.id, "JOB_COMPLETED", {});
  await pump(core);
  assert.equal(f.store.list().length, 2);
  assert.equal(f.store.get("CB-2").status, "READY_FOR_HUMAN_TEST");
  assert.equal(f.workerCalls(), 1);
  const calls = f.authorizationCalls();
  for (let i = 0; i < 50; i++)
    f.store.event("CB-2", "CODEX_OUTPUT", { text: "no authorization" });
  await pump(core);
  assert.equal(f.authorizationCalls(), calls);
  // Fixture-only workflow completion, not a human-approval API or live evidence.
  f.store.transition("CB-2", "COMPLETED");
  await pump(core);
  assert.match(core.sentinelExecutor!.report().blocker!, /cooldown/);
  assert.equal(f.store.list().length, 2);
  f.advance();
  await pump(core); // Deadline wakes without a new event or a second timer.
  assert.equal(f.store.list().length, 3);
  assert.equal(f.store.get("CB-3").status, "READY_FOR_HUMAN_TEST");
  assert.equal(f.workerCalls(), 2);
  f.store.transition("CB-3", "COMPLETED");
  core = await f.restart(core);
  await pump(core);
  f.store.event("CB-3", "JOB_COMPLETED", {});
  await pump(core);
  assert.equal(f.store.list().length, 3);
  assert.equal(f.workerCalls(), 2);
  assert.equal(core.sentinelExecutor!.report().attempts.length, 2);
});

test("wrong/expired grants and source mismatch create no jobs through dispatch", async (t) => {
  for (const scenario of ["wrong", "expired", "source"] as const) {
    await t.test(scenario, async (child) => {
      const f = fixture(child);
      const authorize = f.host.authorize;
      f.host.authorize = async (id) => ({
        ...((await authorize(id)) as object),
        ...(scenario === "wrong"
          ? { taskId: "other" }
          : scenario === "expired"
            ? { expiresAt: 1 }
            : {}),
      });
      if (scenario === "source") f.host.verifySource = async () => false;
      const core = f.make();
      f.store.event(f.prerequisite.id, "JOB_COMPLETED", {});
      await pump(core);
      const calls = f.authorizationCalls();
      f.store.event(f.prerequisite.id, "JOB_COMPLETED", {});
      await pump(core);
      assert.equal(f.authorizationCalls(), calls);
      assert.equal(f.store.list().length, 1);
      assert.ok(core.sentinelExecutor!.report().blocker);
    });
  }
});

test("evidence requirement and disabled WorldPrep sample never dispatch", async (t) => {
  const f = fixture(t);
  f.config.sentinelDevPolicy!.tasks[0].requiredEvidence = ["protected-runtime"];
  const core = f.make();
  f.store.event(f.prerequisite.id, "JOB_COMPLETED", {});
  await pump(core);
  assert.equal(f.authorizationCalls(), 0);
  f.config.sentinelDevPolicy = JSON.parse(
    readFileSync(
      new URL("../fixtures/sentinel/worldprep-policy.json", import.meta.url),
      "utf8",
    ),
  );
  const worldprep = f.make();
  await pump(worldprep);
  assert.equal(worldprep.sentinelDispatch, undefined);
  assert.equal(f.store.list().length, 1);
});

test("stop during protected verification prevents later job insertion", async (t) => {
  const f = fixture(t);
  let release!: (value: boolean) => void;
  f.host.verifySource = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const core = f.make();
  f.store.event(f.prerequisite.id, "JOB_COMPLETED", {});
  await core.tick();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(release);
  await core.stop();
  release(true);
  await core.sentinelDispatch!.tick();
  assert.equal(f.store.list().length, 1);
});

test("cancelled prior job blocks the next task without a dispatch loop", async (t) => {
  const f = fixture(t);
  // Both tasks initially ready so cancellation is enforced by the durable lane.
  f.config.sentinelDevPolicy!.tasks[1].dependencies = [f.prerequisite.id];
  const core = f.make();
  f.store.event(f.prerequisite.id, "JOB_COMPLETED", {});
  await pump(core);
  f.store.transition("CB-2", "CANCELLED");
  await pump(core);
  const calls = f.authorizationCalls();
  await pump(core);
  assert.equal(f.authorizationCalls(), calls);
  assert.equal(f.store.list().length, 2);
  assert.ok(core.sentinelExecutor!.isHalted);
});

test("dispatch restart reconciles a crash after core.create inserts without duplicate", async (t) => {
  const f = fixture(t);
  let core = f.make();
  const create = core.create.bind(core);
  core.create = async (...args) => {
    await create(...args);
    throw Error("lost response");
  };
  f.store.event(f.prerequisite.id, "JOB_COMPLETED", {});
  await pump(core);
  assert.equal(core.sentinelExecutor!.report().attempts[0].state, "reserved");
  assert.equal(f.store.list().length, 2);
  core = await f.restart(core);
  await pump(core);
  assert.equal(core.sentinelExecutor!.report().attempts[0].state, "submitted");
  assert.equal(f.store.list().length, 2);
  assert.equal(f.workerCalls(), 1);
});

test("unexpected dispatch error fails closed without interrupting core scheduler", async (t) => {
  const f = fixture(t);
  const core = f.make();
  const report = core.sentinelDev.report.bind(core.sentinelDev);
  core.sentinelDev.report = () => {
    throw Error("sensitive provider detail");
  };
  f.store.event(f.prerequisite.id, "JOB_COMPLETED", {});
  await pump(core);
  assert.match(core.sentinelExecutionBlocker!, /dispatch failed/);
  assert.doesNotMatch(core.sentinelExecutionBlocker!, /sensitive/);
  core.sentinelDev.report = report;
  await pump(core);
  assert.equal(f.store.list().length, 1);
  assert.equal(f.authorizationCalls(), 0);
});

test(
  "opt-in real disposable Git plus dispatch/core.create/scheduler smoke",
  { skip: process.env.SENTINEL_DISPATCH_GIT_TEST !== "1" },
  async (t) => {
    let f: ReturnType<typeof fixture>;
    try {
      f = fixture(t, true, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      t.skip("Git spawn denied with EPERM; no retry or workaround");
      return;
    }
    const core = f.make();
    // Resolve actual Git pins through the existing hardened GitWorkspace.
    const provenance = JSON.stringify({
      repository: f.policy.repository,
      baseCommit: f.policy.source!.baseCommit,
      sourceRef: "refs/heads/main",
    });
    f.policy.source!.provenanceHash = hash(provenance);
    f.config.sentinelDevPolicy!.source!.provenanceHash = hash(provenance);
    f.host.verifySource = gitSourceVerifier(core.git, async () => provenance);
    // Reconstruct with the protected fixture verifier installed (captured by value).
    await core.stop();
    const wired = f.make();
    f.store.event(f.prerequisite.id, "JOB_COMPLETED", {});
    await pump(wired);
    assert.equal(f.store.get("CB-2").status, "READY_FOR_HUMAN_TEST");
    f.store.transition("CB-2", "COMPLETED");
    f.advance();
    await pump(wired);
    assert.equal(f.store.get("CB-3").status, "READY_FOR_HUMAN_TEST");
    assert.equal(f.workerCalls(), 2);
  },
);

test("persisted token backlog catches up across bounded ticks without a new lifecycle event", async (t) => {
  const f = fixture(t);
  let core = f.make();
  await core.stop();
  f.store.db
    .prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<13000)
    INSERT INTO job_events(job_id,time,type,data) SELECT ?, '2026-10-12T00:00:00Z', 'CODEX_OUTPUT', '{}' FROM n`,
    )
    .run(f.prerequisite.id);
  f.store.event(f.prerequisite.id, "JOB_COMPLETED", {});
  core = await f.restart(core);
  for (let i = 0; i < 8 && f.store.list().length === 1; i++) await pump(core);
  assert.equal(f.store.list().length, 2);
  assert.equal(f.workerCalls(), 1);
  await pump(core);
  assert.equal(f.store.list().length, 2);
});

test("incomplete injected host is disabled at construction", async (t) => {
  const f = fixture(t);
  const core = f.make({
    ...f.host,
    verifySource: undefined,
  } as unknown as SentinelHost);
  await pump(core);
  assert.equal(core.sentinelDispatch, undefined);
  assert.match(core.sentinelExecutionBlocker!, /protected host/);
  assert.equal(f.store.list().length, 1);
});

test("completed job reconciles on restart and wakes next task without an external event", async (t) => {
  for (const cooldownElapsed of [false, true]) {
    await t.test(
      cooldownElapsed
        ? "cooldown elapsed before restart"
        : "cooldown remains after restart",
      async (child) => {
        const f = fixture(child);
        let core = f.make();
        const create = core.create.bind(core);
        core.create = async (...args) => {
          await create(...args);
          throw Error("lost response");
        };
        f.store.event(f.prerequisite.id, "JOB_COMPLETED", {});
        await pump(core);
        assert.equal(
          core.sentinelExecutor!.report().attempts[0].state,
          "reserved",
        );
        assert.equal(f.store.get("CB-2").status, "READY_FOR_HUMAN_TEST");
        f.store.transition("CB-2", "COMPLETED");
        if (cooldownElapsed) f.advance();
        core = await f.restart(core);
        // No external lifecycle event after restart: only existing scheduler ticks.
        await pump(core);
        await pump(core);
        assert.equal(
          core.sentinelExecutor!.report().attempts[0].state,
          "submitted",
        );
        if (!cooldownElapsed) {
          assert.equal(f.store.list().length, 2);
          assert.match(core.sentinelExecutor!.report().blocker!, /cooldown/);
          f.advance();
          await pump(core);
        }
        assert.equal(f.store.list().length, 3);
        assert.equal(f.store.get("CB-2").status, "COMPLETED");
        assert.equal(f.store.get("CB-3").status, "READY_FOR_HUMAN_TEST");
        assert.equal(f.workerCalls(), 2);
        await pump(core); // Drain any coalesced events from task 2 itself.
        const calls = f.authorizationCalls();
        for (let i = 0; i < 3; i++) await pump(core);
        assert.equal(f.authorizationCalls(), calls);
        assert.equal(f.store.list().length, 3);
        assert.equal(f.workerCalls(), 2);
      },
    );
  }
});

