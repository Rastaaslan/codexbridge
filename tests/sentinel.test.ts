import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { Store } from "../src/database.js";
import {
  SentinelMini,
  sentinelReplayQuery,
  sentinelTailQuery,
} from "../src/sentinel.js";
import { createSchema } from "../src/domain.js";
import { configSchema } from "../src/config.js";
import { toolDefinitions } from "../src/tools.js";
import type { Orchestrator } from "../src/orchestrator.js";

function job(store: Store) {
  return store.create(
    createSchema.parse({
      title: "Sentinel fixture",
      ticket: "Observe only",
      repository: process.cwd(),
    }),
  );
}

test("disabled by default, no reads/listeners/writes; canonical tool is read-only", async () => {
  assert.equal(
    configSchema.parse({ dataDir: ".", token: "x".repeat(32) }).sentinelEnabled,
    false,
  );
  const store = new Store(":memory:");
  store.close(); // Disabled observer must even tolerate an unavailable DB.
  const sentinel = new SentinelMini(store);
  sentinel.tick();
  assert.equal(store.listenerCount("event"), 0);
  const tool = toolDefinitions({ sentinel } as Orchestrator).find(
    (t) => t.name === "get_sentinel",
  )!;
  assert.equal(tool.readOnly, true);
  assert.equal(tool.output.parse(await tool.run({})).observation, "disabled");
  sentinel.stop();
});

test("event-driven summaries preserve transitions, sanitize details, ignore token events", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const store = new Store(":memory:");
  const sentinel = new SentinelMini(store, true);
  t.after(() => {
    sentinel.stop();
    store.close();
  });
  const j = job(store);
  store.transition(j.id, "FAILED", {
    blocker: "password="[REDACTED]" inspect",
  });
  await Promise.resolve();
  t.mock.timers.tick(1000);
  const report = sentinel.report();
  assert.equal(report.summaries.length, 1);
  assert.equal(report.summaries[0].status, "FAILED");
  assert.equal(report.summaries[0].jobId, j.id);
  assert.match(report.summaries[0].blocker!, /REDACTED/);
  assert.doesNotMatch(report.summaries[0].blocker!, /private-value|\n/);
  assert.equal(store.get(j.id).status, "FAILED");
  const event = store.events(j.id).find((e) => e.type === "JOB_FAILED")!;
  assert.equal(report.summaries[0].time, event.time);
  for (let n = 0; n < 200; n++)
    store.event(j.id, "CODEX_OUTPUT", { text: "ignored" });
  await Promise.resolve();
  t.mock.timers.tick(1000);
  assert.equal(sentinel.report().cursor, report.cursor); // No token-triggered pass.
  t.mock.timers.tick(28000);
  assert.equal(sentinel.report().cursor, report.cursor + 200);
  assert.equal(sentinel.report().summaries.length, 1);
});

test("durable cursor, missed-event fallback, bounded retention and restart dedupe", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const dir = mkdtempSync(path.join(process.cwd(), ".sentinel-test-"));
  let store = new Store(path.join(dir, "state.db"));
  let sentinel = new SentinelMini(store, true);
  t.after(() => {
    sentinel.stop();
    store.close();
    rmSync(dir, { recursive: true });
  });
  const j = job(store);
  // Insert fixtures directly to simulate missed notifications, without scheduler work.
  const insert = store.db.prepare(
    "INSERT INTO job_events(job_id,time,type,data) VALUES(?,?,?,?)",
  );
  const statuses = [
    "READY_FOR_HUMAN_TEST",
    "WAITING_FOR_HUMAN",
    "FAILED",
    "COMPLETED",
  ];
  for (let i = 0; i < 140; i++)
    insert.run(
      j.id,
      "2026-10-12T00:00:00Z",
      `JOB_${statuses[i % 4]}`,
      '{"blocker":null}',
    );
  sentinel.tick();
  assert.equal(sentinel.report().cursor, 129);
  assert.equal(sentinel.report().summaries.length, 100);
  sentinel.stop();
  await Promise.resolve();
  store.close();
  store = new Store(path.join(dir, "state.db"));
  sentinel = new SentinelMini(store, true);
  t.mock.timers.tick(1000);
  const report = sentinel.report();
  assert.equal(report.cursor, 141);
  assert.equal(report.summaries.length, 100);
  assert.equal(new Set(report.summaries.map((s) => s.eventId)).size, 100);
  assert.deepEqual(
    new Set(report.summaries.map((s) => s.status)),
    new Set(statuses),
  );
  store.db
    .prepare("INSERT INTO job_events(job_id,time,type,data) VALUES(?,?,?,?)")
    .run(j.id, "later", "JOB_COMPLETED", "{}");
  t.mock.timers.tick(29000);
  assert.equal(sentinel.report().cursor, 142);
  sentinel.tick();
  assert.equal(sentinel.report().summaries.at(-1)!.eventId, 142);
  assert.equal(store.get(j.id).status, "QUEUED");
});

test("write failure rolls back checkpoint and summaries, fails closed, replays on restart", async (t) => {
  const store = new Store(":memory:");
  const sentinel = new SentinelMini(store, true);
  t.after(() => {
    sentinel.stop();
    store.close();
  });
  const j = job(store);
  store.db.exec(
    "CREATE TRIGGER deny_sentinel BEFORE INSERT ON settings BEGIN SELECT RAISE(ABORT,'sensitive failure'); END",
  );
  store.transition(j.id, "FAILED");
  sentinel.tick();
  assert.equal(sentinel.report().observation, "error");
  assert.equal(sentinel.report().cursor, 0);
  assert.deepEqual(sentinel.report().summaries, []);
  assert.equal(store.listenerCount("event"), 0);
  assert.equal(store.get(j.id).status, "FAILED");
  store.db.exec("DROP TRIGGER deny_sentinel");
  const restarted = new SentinelMini(store, true);
  restarted.tick();
  assert.equal(restarted.report().summaries.length, 1);
  restarted.stop();
  await Promise.resolve();
});

test("rolled-back lifecycle events produce no attention", async (t) => {
  const store = new Store(":memory:");
  const sentinel = new SentinelMini(store, true);
  t.after(() => {
    sentinel.stop();
    store.close();
  });
  const j = job(store);
  assert.throws(() =>
    store.transaction(() => {
      store.transition(j.id, "FAILED");
      throw Error("rollback");
    }),
  );
  await Promise.resolve();
  sentinel.tick();
  assert.deepEqual(sentinel.report().summaries, []);
  assert.equal(store.get(j.id).status, "QUEUED");
});

test("oversized details are omitted; invalid checkpoints fail closed without replay", async (t) => {
  const store = new Store(":memory:");
  const sentinel = new SentinelMini(store, true);
  t.after(() => {
    sentinel.stop();
    store.close();
  });
  const j = job(store);
  store.event(j.id, "JOB_WAITING_FOR_HUMAN", { blocker: "x".repeat(5000) });
  await Promise.resolve();
  sentinel.tick();
  assert.equal(
    sentinel.report().summaries[0].blocker,
    "Detail omitted; inspect the job event.",
  );
  sentinel.stop();
  store.db
    .prepare("UPDATE settings SET value=? WHERE key='sentinel:mini:v0'")
    .run('{"cursor":-1,"summaries":[]}');
  const broken = new SentinelMini(store, true);
  assert.equal(broken.report().observation, "error");
  assert.equal(store.listenerCount("event"), 0);
  broken.stop();
});

test("first opt-in checkpoints the current journal tip before any tick", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const store = new Store(":memory:");
  let sentinel: SentinelMini;
  t.after(() => {
    sentinel?.stop();
    store.close();
  });
  const j = job(store);
  const insert = store.db.prepare(
    "INSERT INTO job_events(job_id,time,type,data) VALUES(?,?,?,?)",
  );
  store.transaction(() => {
    for (let i = 0; i < 2048; i++)
      insert.run(j.id, "historical", "CODEX_OUTPUT", "{}");
    insert.run(j.id, "historical", "JOB_COMPLETED", "{}");
    store.db
      .prepare(
        "INSERT INTO job_events(id,job_id,time,type,data) VALUES(613044,?,?,?,?)",
      )
      .run(j.id, "historical", "CODEX_MESSAGE", "{}");
  });
  sentinel = new SentinelMini(store, true);
  assert.equal(sentinel.report().cursor, 613044);
  assert.deepEqual(sentinel.report().summaries, []);
  assert.equal(
    JSON.parse(
      String(
        store.db
          .prepare("SELECT value FROM settings WHERE key='sentinel:mini:v0'")
          .get()!.value,
      ),
    ).cursor,
    613044,
  );
  sentinel.stop(); // Crash/restart before the initial callback: bootstrap is durable.
  store.transaction(() => {
    for (let i = 0; i < 2048; i++)
      insert.run(j.id, "after opt-in", "CODEX_MESSAGE", "{}");
  });
  store.transition(j.id, "FAILED", { blocker: "new failure" });
  await Promise.resolve();
  sentinel = new SentinelMini(store, true);
  t.mock.timers.tick(1000);
  assert.deepEqual(
    sentinel.report().summaries.map((s) => s.status),
    ["FAILED"],
  );
  assert.equal(sentinel.report().replayPending, false);
  sentinel.tick();
  assert.equal(sentinel.report().summaries.length, 1);
});

test("large token backlog: fresh tail, complete ordered replay, bounded SQL and restart dedupe", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const store = new Store(":memory:");
  const j = job(store);
  // Old-format checkpoint must retain its replay position, not bootstrap again.
  store.db
    .prepare("INSERT INTO settings(key,value) VALUES('sentinel:mini:v0',?)")
    .run(JSON.stringify({ cursor: 1, summaries: [] }));
  const insert = store.db.prepare(
    "INSERT INTO job_events(job_id,time,type,data) VALUES(?,?,?,?)",
  );
  const expected: number[] = [];
  const seedStart = performance.now();
  store.transaction(() => {
    for (let i = 0; i < 20000; i++) {
      insert.run(
        j.id,
        "tokens",
        i % 2 ? "CODEX_MESSAGE" : "CODEX_OUTPUT",
        '{"text":"unused"}',
      );
      if (i === 6000 || i === 12000)
        expected.push(
          Number(
            insert.run(
              j.id,
              "gap",
              i === 6000 ? "JOB_WAITING_FOR_HUMAN" : "JOB_READY_FOR_HUMAN_TEST",
              "{}",
            ).lastInsertRowid,
          ),
        );
    }
    expected.push(
      Number(insert.run(j.id, "latest", "JOB_COMPLETED", "{}").lastInsertRowid),
    );
  });
  const seedMs = performance.now() - seedStart;
  let sentinel = new SentinelMini(store, true);
  t.after(() => {
    sentinel.stop();
    store.close();
  });
  assert.equal(sentinel.report().cursor, 1);
  const tickStart = performance.now();
  t.mock.timers.tick(1000);
  const tickMs = performance.now() - tickStart;
  assert.deepEqual(
    sentinel.report().summaries.map((s) => s.eventId),
    [expected[2]],
  );
  assert.equal(sentinel.report().replayPending, true);
  assert.equal(sentinel.report().cursor, 4097);
  // Persisted recent attention survives restart while the replay gap is retained.
  sentinel.stop();
  sentinel = new SentinelMini(store, true);
  for (let i = 0; i < 5; i++) sentinel.tick();
  assert.deepEqual(
    sentinel.report().summaries.map((s) => s.eventId),
    expected,
  );
  assert.equal(sentinel.report().replayPending, false);
  sentinel.tick();
  assert.deepEqual(
    sentinel.report().summaries.map((s) => s.eventId),
    expected,
  );
  // Missed event stream: fallback also sees the new status across 5000 tokens.
  t.mock.timers.tick(1000); // Clear the startup debounce before fallback scenario.
  store.transaction(() => {
    for (let i = 0; i < 5000; i++)
      insert.run(j.id, "tokens", "CODEX_OUTPUT", "{}");
    expected.push(
      Number(insert.run(j.id, "fallback", "JOB_FAILED", "{}").lastInsertRowid),
    );
  });
  t.mock.timers.tick(29000);
  assert.deepEqual(
    sentinel.report().summaries.map((s) => s.eventId),
    expected,
  );
  // Event-driven path remains fresh across a further token flood.
  store.transaction(() => {
    for (let i = 0; i < 5000; i++)
      insert.run(j.id, "tokens", "CODEX_OUTPUT", "{}");
  });
  store.transition(j.id, "FAILED");
  expected.push(
    Number(store.db.prepare("SELECT MAX(id) AS id FROM job_events").get()!.id),
  );
  await Promise.resolve();
  t.mock.timers.tick(1000);
  assert.deepEqual(
    sentinel.report().summaries.map((s) => s.eventId),
    expected,
  );
  for (const query of [sentinelReplayQuery, sentinelTailQuery]) {
    const plan = store.db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(1, 4097);
    assert.match(
      String(plan[0].detail),
      /SEARCH job_events USING INTEGER PRIMARY KEY \(rowid>\? AND rowid<\?\)/,
    );
    assert.equal(plan.length, 1); // No temporary sort or full-table scan.
    t.diagnostic(String(plan[0].detail));
  }
  t.diagnostic(
    `In-memory 20,000-token fixture seed: ${seedMs.toFixed(2)} ms; first bounded observation: ${tickMs.toFixed(2)} ms`,
  );
});

test("bootstrap write failure cannot block lifecycle transitions", async (t) => {
  const store = new Store(":memory:");
  const j = job(store);
  store.db.exec(
    "CREATE TRIGGER deny_sentinel BEFORE INSERT ON settings BEGIN SELECT RAISE(ABORT,'denied'); END",
  );
  const sentinel = new SentinelMini(store, true);
  t.after(() => {
    sentinel.stop();
    store.close();
  });
  assert.equal(sentinel.report().observation, "error");
  assert.equal(store.listenerCount("event"), 0);
  store.transition(j.id, "FAILED");
  assert.equal(store.get(j.id).status, "FAILED");
  await Promise.resolve();
});

