import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Store } from "../src/database.js";
import { createSchema } from "../src/domain.js";
import { SentinelMini } from "../src/sentinel.js";
import { SentinelDev, devPolicySchema, hash } from "../src/sentinel-dev.js";
import {
  SentinelExecutor,
  gitSourceVerifier,
  coreCreatePort,
  type ExecutionPorts,
} from "../src/sentinel-executor.js";
import { Orchestrator } from "../src/orchestrator.js";
import { GitWorkspace } from "../src/git.js";
import { configSchema } from "../src/config.js";
import { toolDefinitions } from "../src/tools.js";

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(process.cwd(), ".sentinel-executor-"));
  const file = path.join(dir, "store.sqlite");
  let store = new Store(file);
  const dep = store.create(
    createSchema.parse({
      title: "fixture prerequisite",
      ticket: "synthetic",
      repository: dir,
    }),
  );
  store.patch(dep.id, { status: "COMPLETED" });
  const mini = new SentinelMini(store, true);
  store.event(dep.id, "JOB_COMPLETED", {});
  mini.tick();
  const p = devPolicySchema.parse({
    id: "fixture",
    enabled: true,
    repository: dir,
    source: {
      baseCommit: "a".repeat(40),
      provenanceHash: "b".repeat(64),
      approvedBy: "not-authority",
    },
    budget: 2,
    concurrency: 1,
    cooldownMs: 60000,
    tasks: ["fix1", "fix2"].map((id) => ({
      id,
      operation: "code-fix",
      dependencies: [dep.id],
      requiredEvidence: [],
      ticket: "Synthetic code correction",
      ticketHash: hash("Synthetic code correction"),
    })),
  });
  const planner = new SentinelDev(store, mini, p);
  let time = 100000;
  let calls = 0;
  let grantOverride: unknown;
  const grant = (id: string) => ({
    permission: "automatic-code-fix",
    taskId: id,
    policyHash: hash(JSON.stringify(p)),
    repository: p.repository,
    sourceRef: "refs/heads/main",
    ...p.source,
    ticketHash: p.tasks[0].ticketHash,
    expiresAt: 999999,
  });
  const ports: ExecutionPorts = {
    authorize: async (id) => {
      const { approvedBy, ...g } = grant(id);
      return grantOverride ?? g;
    },
    verifySource: async () => true,
    schedulerAllows: () => true,
    create: async (input, beforeCreate) => {
      beforeCreate();
      calls++;
      return store.create(createSchema.parse(input), p.source!.baseCommit);
    },
  };
  const make = (options = { enabled: true, repositories: [dir] }) =>
    new SentinelExecutor(store, planner, p, ports, options, () => time);
  t.after(() => {
    mini.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    file,
    get store() {
      return store;
    },
    dep,
    p,
    planner,
    ports,
    make,
    calls: () => calls,
    override: (g: unknown) => {
      grantOverride = g;
    },
    advance: () => {
      time += 60000;
    },
    restart: () => {
      mini.stop();
      store.close();
      store = new Store(file);
    },
  };
}

test("default off and dry-run perform zero port, planner or Store IO; canonical tool is read-only", async () => {
  const p = devPolicySchema.parse({
    id: "off",
    repository: "/fixture",
    source: null,
    budget: 1,
    concurrency: 1,
    cooldownMs: 60000,
    tasks: [
      {
        id: "fix",
        operation: "code-fix",
        dependencies: ["CB-1"],
        requiredEvidence: [],
        ticket: "x",
        ticketHash: hash("x"),
      },
    ],
  });
  const trap = new Proxy(
    {},
    {
      get() {
        throw Error("IO forbidden");
      },
    },
  );
  for (const opts of [
    { repositories: [] },
    { enabled: true, dryRun: true, repositories: [] },
  ]) {
    const service = new SentinelExecutor(
      trap as Store,
      trap as SentinelDev,
      p,
      trap as ExecutionPorts,
      opts,
    );
    assert.equal((await service.run("fix")).attempts.length, 0);
  }
  const tool = toolDefinitions({} as Orchestrator).find(
    (t) => t.name === "get_sentinel_dev_actions",
  )!;
  assert.equal(tool.readOnly, true);
  assert.equal((await tool.run({})).mode, "disabled");
});

test("explicit task automatic permission and every pin required; arbitrary provider error is redacted", async (t) => {
  const f = fixture(t);
  const valid = (await f.ports.authorize("fix1")) as object;
  for (const change of [
    { permission: "manual" },
    { taskId: "" },
    { taskId: "fix2" },
    { policyHash: "c".repeat(64) },
    { repository: "/other" },
    { baseCommit: "c".repeat(40) },
    { provenanceHash: "c".repeat(64) },
    { ticketHash: "c".repeat(64) },
    { expiresAt: 1 },
  ]) {
    f.override({ ...valid, ...change });
    assert.ok((await f.make().run("fix1")).blocker);
  }
  f.override(valid);
  assert.ok(
    (await f.make({ enabled: true, repositories: [] }).run("fix1")).blocker,
  );
  f.ports.authorize = async () => {
    throw Error("Task authorization secret-token");
  };
  const s = f.make();
  assert.equal(
    (await s.run("fix1")).blocker,
    "authorization failed; operator inspection required",
  );
  await s.run("fix1");
  assert.equal(f.calls(), 0);
});

test("forbidden dependencies, evidence, missing task, stale planner and source fail closed", async (t) => {
  const f = fixture(t);
  for (const status of [
    "FAILED",
    "WAITING_FOR_HUMAN",
    "READY_FOR_HUMAN_TEST",
    "ACCEPTED",
    "QUEUED",
  ] as const) {
    f.store.patch(f.dep.id, { status });
    assert.ok((await f.make().run("fix1")).blocker);
  }
  f.store.patch(f.dep.id, { status: "COMPLETED" });
  assert.ok((await f.make().run("unknown")).blocker);
  f.ports.verifySource = async () => false;
  assert.match((await f.make().run("fix1")).blocker!, /source/);
  f.ports.verifySource = async () => true;
  f.p.tasks[0].requiredEvidence = ["protected-runtime"];
  assert.match((await f.make().run("fix1")).blocker!, /evidence/);
  f.p.tasks[0].requiredEvidence = [];
  const stale = {
    tick() {},
    report: () => ({ ...f.planner.report(), observation: "error" as const }),
  };
  const s = new SentinelExecutor(f.store, stale, f.p, f.ports, {
    enabled: true,
    repositories: [f.dir],
  });
  assert.ok((await s.run("fix1")).blocker);
  assert.equal(f.calls(), 0);
});

test("coalesces concurrent calls, reserves once, restart preserves idempotency", async (t) => {
  const f = fixture(t);
  const s = f.make();
  await Promise.all([s.run("fix1"), s.run("fix1"), f.make().run("fix1")]);
  assert.equal(f.calls(), 1);
  assert.equal(s.report().attempts[0].state, "submitted");
  f.restart();
  await f.make().run("fix1");
  assert.equal(f.calls(), 1);
});

test("reservation persists before failed adapter; no busy retry or restart resubmission", async (t) => {
  const f = fixture(t);
  let failures = 0;
  f.ports.create = async () => {
    failures++;
    throw Error("secret");
  };
  const s = f.make();
  assert.match((await s.run("fix1")).blocker!, /submission failed/);
  assert.equal(s.report().attempts[0].state, "reserved");
  await s.run("fix1");
  // Same persisted reservation blocks another service before invoking adapter.
  await f.make().run("fix1");
  assert.equal(failures, 1);
});

test("crash after durable create reconciles by unique key without adapter replay", async (t) => {
  const f = fixture(t);
  const create = f.ports.create;
  f.ports.create = async (input, beforeCreate) => {
    await create(input, beforeCreate);
    throw Error("response lost");
  };
  await f.make().run("fix1");
  f.restart();
  const next = await f.make().run("fix1");
  assert.equal(next.attempts[0].state, "submitted");
  assert.equal(f.calls(), 1);
});

test("storage failure before reservation never creates; source/dependency changes after reservation block", async (t) => {
  const f = fixture(t);
  f.store.db.exec(
    "CREATE TRIGGER deny_action BEFORE INSERT ON settings WHEN NEW.key LIKE 'sentinel:execute:%' BEGIN SELECT RAISE(ABORT,'denied'); END",
  );
  assert.match((await f.make().run("fix1")).blocker!, /reservation failed/);
  assert.equal(f.calls(), 0);
  f.store.db.exec("DROP TRIGGER deny_action");
  let checks = 0;
  f.ports.verifySource = async () => {
    if (++checks === 2)
      f.store.patch(f.dep.id, { status: "WAITING_FOR_HUMAN" });
    return true;
  };
  assert.match((await f.make().run("fix1")).blocker!, /Dependency/);
  assert.equal(f.calls(), 0);
});

test("lane concurrency, cooldown and cap cannot reset with policy or service restart", async (t) => {
  const f = fixture(t);
  const first = await f.make().run("fix1");
  assert.match((await f.make().run("fix2")).blocker!, /Lane occupied/);
  f.store.patch(first.attempts[0].jobId!, { status: "COMPLETED" });
  assert.match((await f.make().run("fix2")).blocker!, /cooldown/);
  f.advance();
  const second = await f.make().run("fix2");
  assert.equal(f.calls(), 2);
  f.store.patch(second.attempts[1].jobId!, { status: "COMPLETED" });
  f.p.tasks.push({ ...f.p.tasks[0], id: "fix3" });
  // Policy edits cannot erase repository-wide accounting; require investigation.
  assert.ok((await f.make().run("fix3")).blocker);
  assert.equal(f.calls(), 2);
});

test(
  "actual Git verification and Orchestrator.create only in disposable repository/Store",
  { skip: process.env.SENTINEL_EXECUTOR_GIT_TEST !== "1" },
  async (t) => {
    const f = fixture(t);
    const repo = path.join(f.dir, "repo");
    mkdirSync(repo);
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: repo,
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
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      t.skip(
        "Sandbox prohibits Git child process (EPERM); no workaround attempted",
      );
      return;
    }
    git(
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--allow-empty",
      "-qm",
      "synthetic fixture",
    );
    const sha = git("rev-parse", "HEAD");
    f.p.repository = repo;
    f.p.source!.baseCommit = sha;
    const provenance = JSON.stringify({
      repository: repo,
      baseCommit: sha,
      sourceRef: "refs/heads/main",
    });
    f.p.source!.provenanceHash = hash(provenance);
    const config = configSchema.parse({
      dataDir: f.dir,
      token: "x".repeat(32),
      repositoryRoots: [repo],
    });
    const workspace = new GitWorkspace(config);
    const verify = gitSourceVerifier(workspace, async () => provenance);
    const grant = (await f.ports.authorize("fix1")) as any;
    assert.equal(await verify(grant), true);
    assert.equal(await verify({ ...grant, baseCommit: "b".repeat(40) }), false);
    assert.equal(
      await verify({ ...grant, provenanceHash: "c".repeat(64) }),
      false,
    );
    assert.equal(
      await gitSourceVerifier(workspace, async () => "{}")(grant),
      false,
    );
    // Exercise real create API and canonical Store, suppress scheduling workers.
    let ticks = 0;
    const core = {
      config,
      store: f.store,
      git: workspace,
      tick: async () => {
        ticks++;
      },
    } as unknown as Orchestrator;
    f.ports.verifySource = verify;
    f.ports.create = (input, beforeCreate) =>
      Orchestrator.prototype.create.call(core, input, beforeCreate);
    const planner = new SentinelDev(
      f.store,
      {
        report: () => ({
          observation: "observing",
          replayPending: false,
          cursor: 1,
          summaries: [{ jobId: f.dep.id, status: "COMPLETED" }],
        }),
      } as SentinelMini,
      f.p,
    );
    const service = new SentinelExecutor(
      f.store,
      planner,
      f.p,
      f.ports,
      {
        enabled: true,
        repositories: [repo],
      },
      () => 100000,
    );
    const result = await service.run("fix1");
    assert.equal(result.blocker, null);
    assert.equal(result.attempts[0].state, "submitted");
    assert.equal(f.store.get(result.attempts[0].jobId!).baseCommit, sha);
    assert.equal(ticks, 1);
  },
);

test("Git verifier rejects canonical path, ref, commit and provenance mismatches", async (t) => {
  const f = fixture(t);
  const provenance = JSON.stringify({
    repository: f.dir,
    baseCommit: f.p.source!.baseCommit,
    sourceRef: "refs/heads/main",
  });
  f.p.source!.provenanceHash = hash(provenance);
  const g = (await f.ports.authorize("fix1")) as any;
  const workspace = {
    repository: async () => f.dir,
    resolve: async () => g.baseCommit,
  };
  assert.equal(
    await gitSourceVerifier(workspace, async () => provenance)(g),
    true,
  );
  assert.equal(
    await gitSourceVerifier(
      { ...workspace, repository: async () => "/alias" },
      async () => provenance,
    )(g),
    false,
  );
  assert.equal(
    await gitSourceVerifier(
      { ...workspace, resolve: async () => "f".repeat(40) },
      async () => provenance,
    )(g),
    false,
  );
  let calls = 0;
  assert.equal(
    await gitSourceVerifier(
      {
        ...workspace,
        resolve: async () => (++calls === 1 ? g.baseCommit : "f".repeat(40)),
      },
      async () => provenance,
    )(g),
    false,
  );
  assert.equal(await gitSourceVerifier(workspace, async () => "{}")(g), false);
  const stale = JSON.stringify({
    repository: f.dir,
    baseCommit: "f".repeat(40),
    sourceRef: g.sourceRef,
  });
  assert.equal(
    await gitSourceVerifier(
      workspace,
      async () => stale,
    )({ ...g, provenanceHash: hash(stale) }),
    false,
  );
});

test("resource deferral skips authorization and Git before rechecking", async (t) => {
  const f = fixture(t);
  const service = f.make();
  let authorizations = 0;
  let verifications = 0;
  const previousAuthorize = f.ports.authorize;
  const previousVerify = f.ports.verifySource;
  f.ports.authorize = async (taskId) => {
    authorizations++;
    return previousAuthorize(taskId);
  };
  f.ports.verifySource = async (grant) => {
    verifications++;
    return previousVerify(grant);
  };
  f.ports.schedulerAllows = () => false;
  await service.run("fix1");
  assert.equal(service.isHalted, false);
  assert.equal(authorizations, 0);
  assert.equal(verifications, 0);
  assert.equal(f.calls(), 0);
  f.ports.schedulerAllows = () => true;
  f.advance();
  await service.run("fix1");
  assert.equal(f.calls(), 1);
  assert.ok(authorizations >= 1);
  assert.ok(verifications >= 1);
});

test("temporary scheduler pressure defers and rechecks without restarting the executor", async (t) => {
  const f = fixture(t);
  const executor = f.make();
  f.ports.schedulerAllows = () => false;
  const deferred = await executor.run("fix1");
  assert.match(deferred.blocker!, /temporarily unavailable/);
  assert.equal(executor.isHalted, false);
  assert.equal(f.calls(), 0);
  assert.equal(executor.deferredUntil, 160000);
  f.ports.schedulerAllows = () => true;
  f.advance();
  const completed = await executor.run("fix1");
  assert.equal(completed.attempts.length, 1);
  assert.equal(f.calls(), 1);
});

test("budget exhausted and scheduler refusal cannot submit", async (t) => {
  const f = fixture(t);
  f.p.budget = 1;
  // Rebuild planner because a policy hash intentionally changes decision keys.
  const planner = {
    tick() {},
    report: () => ({
      ...f.planner.report(),
      decisions: f.p.tasks.map((task) => ({
        ...f.planner.report().decisions[0],
        taskId: task.id,
        key: hash(`sentinel:dev:v1:${hash(JSON.stringify(f.p))}:${task.id}`),
        status: "ready-for-code" as const,
      })),
    }),
  };
  const make = () =>
    new SentinelExecutor(
      f.store,
      planner,
      f.p,
      f.ports,
      { enabled: true, repositories: [f.dir] },
      () => 100000,
    );
  f.ports.schedulerAllows = () => false;
  assert.match((await make().run("fix1")).blocker!, /scheduler/);
  f.ports.schedulerAllows = () => true;
  const first = await make().run("fix1");
  f.store.patch(first.attempts[0].jobId!, { status: "COMPLETED" });
  assert.match((await make().run("fix2")).blocker!, /cap/);
  assert.equal(f.calls(), 1);
});

test("actual source rechecked after reservation; changed source cannot create", async (t) => {
  const f = fixture(t);
  let checks = 0;
  f.ports.verifySource = async () => ++checks === 1;
  assert.match((await f.make().run("fix1")).blocker!, /source/);
  assert.equal(f.calls(), 0);
  assert.equal(f.make().report().attempts[0].state, "reserved");
});

test("post-create ledger write failure reconciles; corrupt ledger fails closed", async (t) => {
  const f = fixture(t);
  const create = f.ports.create;
  f.ports.create = async (input, beforeCreate) => {
    const job = await create(input, beforeCreate);
    f.store.db.exec(
      "CREATE TRIGGER deny_final BEFORE INSERT ON settings WHEN NEW.key LIKE 'sentinel:execute:%' BEGIN SELECT RAISE(ABORT,'denied'); END",
    );
    return job;
  };
  assert.match(
    (await f.make().run("fix1")).blocker!,
    /submission reconciliation/,
  );
  f.store.db.exec("DROP TRIGGER deny_final");
  assert.equal((await f.make().run("fix1")).attempts[0].state, "submitted");
  assert.equal(f.calls(), 1);
  f.store.db
    .prepare(
      "UPDATE settings SET value='{}' WHERE key LIKE 'sentinel:execute:%'",
    )
    .run();
  assert.ok((await f.make().run("fix2")).blocker);
  assert.equal(f.calls(), 1);
});

test("core binding rejects automatic runtime retries", async (t) => {
  const f = fixture(t);
  const config = configSchema.parse({
    dataDir: f.dir,
    token: "x".repeat(32),
    maxRuntimeRetries: 0,
  });
  let ticks = 0;
  const core = {
    config,
    store: f.store,
    git: {
      repository: async (p: string) => p,
      resolve: async () => {
        if (mutate) f.store.patch(f.dep.id, { status: "WAITING_FOR_HUMAN" });
        return f.p.source!.baseCommit;
      },
    },
    tick: async () => {
      ticks++;
    },
    create: Orchestrator.prototype.create,
  } as unknown as Orchestrator;
  f.ports.create = coreCreatePort(core);
  config.maxRuntimeRetries = 1;
  assert.match((await f.make().run("fix1")).blocker!, /runtime retries/);
  assert.equal(ticks, 0);
  // A different fixture is needed: failed submissions deliberately retain their reservation.
});

test("canonical create guard prevents dependency drift during async Git preparation", async (t) => {
  const f = fixture(t);
  const config = configSchema.parse({
    dataDir: f.dir,
    token: "x".repeat(32),
    maxRuntimeRetries: 0,
  });
  let ticks = 0;
  const core = {
    config,
    store: f.store,
    git: {
      repository: async (p: string) => p,
      resolve: async () => {
        f.store.patch(f.dep.id, { status: "WAITING_FOR_HUMAN" });
        return f.p.source!.baseCommit;
      },
    },
    tick: async () => {
      ticks++;
    },
    create: Orchestrator.prototype.create,
  } as unknown as Orchestrator;
  f.ports.create = coreCreatePort(core);
  assert.match((await f.make().run("fix1")).blocker!, /Dependency/);
  assert.equal(f.store.list().length, 1);
  assert.equal(ticks, 0);
});

test("canonical create with injected Git uses pinned SHA and invokes scheduler once", async (t) => {
  const f = fixture(t);
  const config = configSchema.parse({
    dataDir: f.dir,
    token: "x".repeat(32),
    maxRuntimeRetries: 0,
  });
  let ticks = 0;
  const core = {
    config,
    store: f.store,
    git: {
      repository: async (p: string) => p,
      resolve: async () => f.p.source!.baseCommit,
    },
    tick: async () => {
      ticks++;
    },
    create: Orchestrator.prototype.create,
  } as unknown as Orchestrator;
  f.ports.create = coreCreatePort(core);
  const service = f.make();
  const result = await service.run("fix1");
  assert.equal(result.blocker, null);
  assert.equal(result.attempts[0].state, "submitted");
  await f.make().run("fix1");
  assert.equal(ticks, 1);
  assert.equal(
    f.store.get(result.attempts[0].jobId!).baseCommit,
    f.p.source!.baseCommit,
  );
});

test("canonical path drift during async preparation is rejected before insertion", async (t) => {
  const f = fixture(t);
  const config = configSchema.parse({
    dataDir: f.dir,
    token: "x".repeat(32),
    maxRuntimeRetries: 0,
  });
  const core = {
    config,
    store: f.store,
    git: {
      repository: async () => `${f.dir}/changed`,
      resolve: async () => f.p.source!.baseCommit,
    },
    tick: async () => {
      assert.fail("Must not schedule");
    },
    create: Orchestrator.prototype.create,
  } as unknown as Orchestrator;
  f.ports.create = coreCreatePort(core);
  assert.match((await f.make().run("fix1")).blocker!, /source changed/);
  assert.equal(f.store.list().length, 1);
});

test("authorization revoked after reservation prevents submission", async (t) => {
  const f = fixture(t);
  const authorize = f.ports.authorize;
  let calls = 0;
  f.ports.authorize = async (id) => (++calls === 1 ? authorize(id) : null);
  assert.match((await f.make().run("fix1")).blocker!, /authorization missing/);
  assert.equal(f.calls(), 0);
});

test("authorization expiring during verification prevents reservation", async (t) => {
  const f = fixture(t);
  const g = (await f.ports.authorize("fix1")) as object;
  f.override({ ...g, expiresAt: 150000 });
  f.ports.verifySource = async () => {
    f.advance();
    return true;
  };
  assert.match(
    (await f.make().run("fix1")).blocker!,
    /expired during verification/,
  );
  assert.equal(f.make().report().attempts.length, 0);
  assert.equal(f.calls(), 0);
});

test("same instance sequences authorized tasks after occupied-lane and cooldown deferrals", async (t) => {
  const f = fixture(t);
  const service = f.make();
  const first = await service.run("fix1");
  assert.equal(first.blocker, null);
  assert.equal(f.calls(), 1);
  const occupied = await service.run("fix2");
  assert.match(occupied.blocker!, /Lane occupied/);
  assert.equal(occupied.attempts.length, 1);
  f.store.patch(first.attempts[0].jobId!, { status: "COMPLETED" });
  const cooling = await service.run("fix2");
  assert.match(cooling.blocker!, /cooldown/);
  assert.equal(cooling.attempts.length, 1);
  assert.equal(f.calls(), 1);
  f.advance();
  const second = await service.run("fix2");
  assert.equal(second.blocker, null);
  assert.equal(second.attempts.length, 2);
  assert.equal(second.attempts[1].state, "submitted");
  assert.equal(f.calls(), 2);
  await service.run("fix2");
  assert.equal(f.calls(), 2);
});

test("failed lane job remains fatal rather than becoming an ordinary deferral", async (t) => {
  const f = fixture(t);
  const service = f.make();
  const first = await service.run("fix1");
  f.store.patch(first.attempts[0].jobId!, { status: "FAILED" });
  assert.match((await service.run("fix2")).blocker!, /operator inspection/);
  f.store.patch(first.attempts[0].jobId!, { status: "COMPLETED" });
  f.advance();
  assert.match((await service.run("fix2")).blocker!, /operator inspection/);
  assert.equal(f.calls(), 1);
});

