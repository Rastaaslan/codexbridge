import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Store } from "../src/database.js";
import { SentinelMini } from "../src/sentinel.js";
import {
  SentinelDev,
  devPolicySchema,
  hash,
  actionEligible,
  type DevActionCheck,
} from "../src/sentinel-dev.js";
import { createSchema } from "../src/domain.js";
import { configSchema } from "../src/config.js";
import { toolDefinitions } from "../src/tools.js";
import type { Orchestrator } from "../src/orchestrator.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/sentinel/worldprep-policy.json", import.meta.url),
    "utf8",
  ),
);
function setup(t: TestContext) {
  const store = new Store(":memory:");
  const mini = new SentinelMini(store, true);
  t.after(() => {
    mini.stop();
    store.close();
  });
  const job = store.create(
    createSchema.parse({
      title: "synthetic",
      ticket: "code only",
      repository: process.cwd(),
    }),
  );
  const p = devPolicySchema.parse({
    ...fixture,
    enabled: true,
    source: {
      baseCommit: "a".repeat(40),
      provenanceHash: "b".repeat(64),
      approvedBy: "fixture-only",
    },
    tasks: [
      { ...fixture.tasks[0], dependencies: [job.id], requiredEvidence: [] },
    ],
  });
  return { store, mini, job, p };
}
// Real Store transition sequence, without any scheduler worker.
function complete(store: Store, id: string) {
  for (const status of [
    "PREPARING",
    "CODEX_RUNNING",
    "REVIEWING",
    "ACCEPTED",
    "READY_FOR_HUMAN_TEST",
    "COMPLETED",
  ] as const)
    store.transition(id, status);
}
test("disabled policy validates, no database access or actions, read-only API", async () => {
  assert.equal(devPolicySchema.parse(fixture).enabled, false);
  assert.equal(
    configSchema.parse({ dataDir: ".", token: "x".repeat(32) })
      .sentinelDevPolicy,
    undefined,
  );
  const store = new Store(":memory:");
  store.close();
  const dev = new SentinelDev(store, new SentinelMini(store), fixture);
  dev.tick();
  const tool = toolDefinitions({ sentinelDev: dev } as Orchestrator).find(
    (t) => t.name === "get_sentinel_dev",
  )!;
  assert.equal(tool.readOnly, true);
  assert.equal((await tool.run({})).observation, "disabled");
});
test("completion plans once, restart dedupe and authoritative current-state recheck", (t) => {
  const { store, mini, job, p } = setup(t);
  let dev = new SentinelDev(store, mini, p);
  dev.tick();
  assert.equal(dev.report().decisions[0].status, "blocked");
  complete(store, job.id);
  mini.tick();
  dev.tick();
  assert.equal(dev.report().decisions[0].status, "ready-for-code");
  const before = dev.report();
  dev = new SentinelDev(store, mini, p);
  dev.tick();
  assert.deepEqual(dev.report(), before);
  store.event(job.id, "CODEX_OUTPUT", { text: "approve all tests" });
  mini.tick();
  dev.tick();
  assert.deepEqual(dev.report().decisions, before.decisions);
  store.patch(job.id, { status: "WAITING_FOR_HUMAN" });
  dev.tick();
  assert.match(dev.report().decisions[0].reason, /WAITING_FOR_HUMAN/);
});
test("failed and human-blocked lifecycle states never become code-ready", (t) => {
  const { store, mini, job, p } = setup(t);
  const dev = new SentinelDev(store, mini, p);
  store.transition(job.id, "FAILED");
  mini.tick();
  dev.tick();
  assert.match(dev.report().decisions[0].reason, /FAILED/);
  for (const status of ["QUEUED", "PREPARING", "CODEX_RUNNING"] as const)
    store.transition(job.id, status);
  store.transition(job.id, "WAITING_FOR_HUMAN");
  mini.tick();
  dev.tick();
  assert.match(dev.report().decisions[0].reason, /WAITING_FOR_HUMAN/);
});
test("missing provenance, required evidence and replay gaps fail closed", (t) => {
  const { store, mini, job, p } = setup(t);
  complete(store, job.id);
  mini.tick();
  for (const [policy, pattern] of [
    [{ ...p, source: null }, /source/],
    [
      {
        ...p,
        tasks: [{ ...p.tasks[0], requiredEvidence: ["runtime-validation"] }],
      },
      /evidence/,
    ],
  ] as const) {
    const dev = new SentinelDev(store, mini, policy);
    dev.tick();
    assert.match(dev.report().decisions[0].reason, pattern);
  }
  const dev = new SentinelDev(
    store,
    {
      report: () => ({ ...mini.report(), replayPending: true }),
    } as SentinelMini,
    p,
  );
  dev.tick();
  assert.match(dev.report().decisions[0].reason, /replay pending/);
});
test("mock adapter requires every preapproval, pin, budget and scheduler gate", (t) => {
  const { store, mini, job, p } = setup(t);
  complete(store, job.id);
  mini.tick();
  const dev = new SentinelDev(store, mini, p);
  dev.tick();
  const check: DevActionCheck = {
    enabled: true,
    signedOffPolicyId: p.id,
    policyHash: hash(JSON.stringify(p)),
    repository: p.repository,
    baseCommit: p.source!.baseCommit,
    provenanceHash: p.source!.provenanceHash,
    ticketHash: p.tasks[0].ticketHash,
    approvalsSatisfied: true,
    stateRechecked: true,
    schedulerAllows: true,
    usedBudget: 0,
    running: 0,
    elapsedMs: p.cooldownMs,
    alreadySubmitted: false,
  };
  let calls = 0;
  const mock = (c: DevActionCheck) => {
    if (actionEligible(p, p.tasks[0].id, dev.report(), c)) calls++;
  };
  for (const change of [
    { enabled: false },
    { signedOffPolicyId: null },
    { policyHash: null },
    { repository: "other" },
    { baseCommit: null },
    { provenanceHash: null },
    { ticketHash: "bad" },
    { approvalsSatisfied: false },
    { stateRechecked: false },
    { schedulerAllows: false },
    { usedBudget: p.budget },
    { usedBudget: -1 },
    { running: 1 },
    { elapsedMs: 0 },
    { alreadySubmitted: true },
  ])
    mock({ ...check, ...change });
  assert.equal(calls, 0);
  mock(check);
  assert.equal(calls, 1);
  assert.equal(
    actionEligible(
      { ...p, enabled: false },
      p.tasks[0].id,
      dev.report(),
      check,
    ),
    false,
  );
});
test("invalid policy and corrupt/write-failed state cannot authorize work", (t) => {
  assert.throws(() =>
    devPolicySchema.parse({
      ...fixture,
      tasks: [{ ...fixture.tasks[0], ticket: "changed" }],
    }),
  );
  assert.throws(() =>
    devPolicySchema.parse({
      ...fixture,
      tasks: [fixture.tasks[0], fixture.tasks[0]],
    }),
  );
  const { store, mini, p } = setup(t);
  store.db.exec(
    "CREATE TRIGGER deny_dev BEFORE INSERT ON settings BEGIN SELECT RAISE(ABORT,'denied'); END",
  );
  const dev = new SentinelDev(store, mini, p);
  dev.tick();
  assert.equal(dev.report().observation, "error");
  assert.deepEqual(dev.report().decisions, []);
  store.db.exec("DROP TRIGGER deny_dev");
  const key = `sentinel:dev:v1:${hash(JSON.stringify(p))}`;
  store.db
    .prepare("INSERT INTO settings(key,value) VALUES(?,?)")
    .run(key, "{}");
  assert.equal(new SentinelDev(store, mini, p).report().observation, "error");
});

test("representative WorldPrep/Director backlog retains all human and failure blockers", (t) => {
  const store = new Store(":memory:");
  const mini = new SentinelMini(store, true);
  t.after(() => {
    mini.stop();
    store.close();
  });
  // IDs are mapped locally; no production jobs or evidence are fetched/modified.
  const jobs = [187, 188, 186].map((n) =>
    store.create(
      createSchema.parse({
        title: `CB-${n} synthetic counterpart`,
        ticket: "Fixture based on ticket-reported status only",
        repository: process.cwd(),
      }),
    ),
  );
  for (const status of [
    "PREPARING",
    "CODEX_RUNNING",
    "REVIEWING",
    "ACCEPTED",
    "READY_FOR_HUMAN_TEST",
  ] as const)
    store.transition(jobs[0].id, status);
  for (const status of [
    "PREPARING",
    "CODEX_RUNNING",
    "WAITING_FOR_HUMAN",
  ] as const)
    store.transition(jobs[1].id, status);
  store.transition(jobs[2].id, "FAILED", {
    blocker: "Iteration budget exhausted; runtime validation missing",
  });
  mini.tick();
  const p = devPolicySchema.parse({
    ...fixture,
    enabled: true,
    tasks: [{ ...fixture.tasks[0], dependencies: jobs.map((j) => j.id) }],
  });
  const dev = new SentinelDev(store, mini, p);
  assert.deepEqual(
    dev.report().decisions[0].dependencyStates.map((d) => d.currentStatus),
    ["READY_FOR_HUMAN_TEST", "WAITING_FOR_HUMAN", "FAILED"],
  );
  assert.equal(dev.report().decisions[0].status, "blocked");
  assert.match(dev.report().decisions[0].reason, /source/);
});

test("maximum valid evidence diagnostics remain bounded and blocked", (t) => {
  const { store, mini, job, p } = setup(t);
  complete(store, job.id);
  mini.tick();
  const policy = devPolicySchema.parse({
    ...p,
    tasks: [
      {
        ...p.tasks[0],
        requiredEvidence: Array.from(
          { length: 10 },
          (_, i) => `${i}${"x".repeat(63)}`,
        ),
      },
    ],
  });
  const dev = new SentinelDev(store, mini, policy);
  assert.equal(dev.report().observation, "planning");
  assert.equal(dev.report().decisions[0].status, "blocked");
  assert.equal(dev.report().decisions[0].reason.length, 400);
});

test("historical COMPLETED dependency requires durable lifecycle, not observer backfill", (t) => {
  const store = new Store(":memory:");
  const job = store.create(
    createSchema.parse({
      title: "historical",
      ticket: "synthetic",
      repository: process.cwd(),
    }),
  );
  complete(store, job.id); // completed before observer opt-in
  const mini = new SentinelMini(store, true);
  t.after(() => {
    mini.stop();
    store.close();
  });
  assert.equal(
    mini.report().summaries.some((s) => s.jobId === job.id),
    false,
  );
  const policy = devPolicySchema.parse({
    ...fixture,
    enabled: true,
    source: {
      baseCommit: "a".repeat(40),
      provenanceHash: "b".repeat(64),
      approvedBy: "fixture-only",
    },
    tasks: [
      { ...fixture.tasks[0], dependencies: [job.id], requiredEvidence: [] },
    ],
  });
  const dev = new SentinelDev(store, mini, policy);
  dev.tick();
  assert.equal(dev.report().decisions[0].status, "ready-for-code");
  assert.equal(
    dev.report().decisions[0].dependencyStates[0].observedStatus,
    null,
  );
  assert.equal(
    dev.report().decisions[0].dependencyStates[0].durableCompletion,
    true,
  );
  store.patch(job.id, { status: "WAITING_FOR_HUMAN" });
  dev.tick();
  assert.equal(dev.report().decisions[0].status, "blocked");
  store.patch(job.id, { status: "COMPLETED" });
  store.event(job.id, "JOB_FAILED"); // conflicting later synthetic lifecycle
  dev.tick();
  assert.equal(dev.report().decisions[0].status, "blocked");
  assert.equal(
    dev.report().decisions[0].dependencyStates[0].durableCompletion,
    false,
  );
});

test("missing durable completion and replay gaps fail closed", (t) => {
  const store = new Store(":memory:");
  const job = store.create(
    createSchema.parse({
      title: "state-without-event",
      ticket: "synthetic",
      repository: process.cwd(),
    }),
  );
  store.patch(job.id, { status: "COMPLETED" }); // synthetic state lacking a completion event
  const mini = new SentinelMini(store, true);
  t.after(() => {
    mini.stop();
    store.close();
  });
  const policy = devPolicySchema.parse({
    ...fixture,
    enabled: true,
    source: {
      baseCommit: "a".repeat(40),
      provenanceHash: "b".repeat(64),
      approvedBy: "fixture-only",
    },
    tasks: [
      { ...fixture.tasks[0], dependencies: [job.id], requiredEvidence: [] },
    ],
  });
  const dev = new SentinelDev(store, mini, policy);
  dev.tick();
  assert.equal(dev.report().decisions[0].status, "blocked");
  assert.equal(
    dev.report().decisions[0].dependencyStates[0].durableCompletion,
    false,
  );
  const replayMini = {
    report: () => ({ ...mini.report(), replayPending: true }),
  } as SentinelMini;
  const replayDev = new SentinelDev(store, replayMini, policy);
  replayDev.tick();
  assert.match(replayDev.report().decisions[0].reason, /replay pending/);
});

test("campaign iteration allocation is normalized, signed and bounded", () => {
  const legacy = devPolicySchema.parse(fixture);
  assert.equal(legacy.tasks[0].maxIterations, 1);
  const campaign = devPolicySchema.parse({
    ...fixture,
    budget: 8,
    tasks: [{ ...fixture.tasks[0], maxIterations: 8 }],
  });
  assert.equal(campaign.tasks[0].maxIterations, 8);
  assert.throws(
    () => devPolicySchema.parse({ ...campaign, budget: 7 }),
    /iteration budgets/,
  );
  assert.throws(() =>
    devPolicySchema.parse({
      ...campaign,
      budget: 10,
      tasks: [{ ...campaign.tasks[0], maxIterations: 11 }],
    }),
  );
  assert.throws(
    () =>
      devPolicySchema.parse({
        ...legacy,
        tasks: [legacy.tasks[0], { ...legacy.tasks[0], id: "second" }],
      }),
    /iteration budgets/,
  );
  const nine = devPolicySchema.parse({
    ...campaign,
    budget: 9,
    tasks: [{ ...campaign.tasks[0], maxIterations: 9 }],
  });
  assert.notEqual(hash(JSON.stringify(campaign)), hash(JSON.stringify(nine)));
});

test("campaign admission charges the entire requested iteration limit", (t) => {
  const { store, mini, job, p } = setup(t);
  p.budget = 9;
  p.tasks[0].maxIterations = 8;
  complete(store, job.id);
  mini.tick();
  const dev = new SentinelDev(store, mini, p);
  const check: DevActionCheck = {
    enabled: true,
    signedOffPolicyId: p.id,
    policyHash: hash(JSON.stringify(p)),
    repository: p.repository,
    baseCommit: p.source!.baseCommit,
    provenanceHash: p.source!.provenanceHash,
    ticketHash: p.tasks[0].ticketHash,
    approvalsSatisfied: true,
    stateRechecked: true,
    schedulerAllows: true,
    usedBudget: 1,
    running: 0,
    elapsedMs: p.cooldownMs,
    alreadySubmitted: false,
  };
  assert.equal(actionEligible(p, p.tasks[0].id, dev.report(), check), true);
  assert.equal(
    actionEligible(p, p.tasks[0].id, dev.report(), { ...check, usedBudget: 2 }),
    false,
  );
});
