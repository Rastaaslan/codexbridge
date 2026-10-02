import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/database.js";
import { configSchema } from "../src/config.js";
import { GitWorkspace } from "../src/git.js";
import { Orchestrator } from "../src/orchestrator.js";
import { toolDefinitions } from "../src/tools.js";
const base = "a".repeat(40),
  integrated = "b".repeat(40);
const feature = (key: string, extra = {}) => ({
  key,
  title: key,
  ticket: `Implement ${key}`,
  ...extra,
});
const roadmap = (
  features = [
    feature("a"),
    feature("b"),
    feature("c", { dependencies: ["a", "b"], inheritFrom: "a" }),
  ],
) => ({ name: "Upgrade", repository: "/repo", startRef: "HEAD", features });
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cb-planner-"));
  const file = path.join(dir, "state.db");
  const config = configSchema.parse({
    dataDir: dir,
    token: "x".repeat(32),
    maxConcurrentJobs: 3,
  });
  const store = new Store(file),
    git = new GitWorkspace(config);
  git.repository = async (p) => p;
  git.resolve = async () => base;
  git.plan = async (j) => ({
    worktree: `/work/${j.id}`,
    branch: j.id,
    baseCommit: j.baseCommit!,
  });
  git.prepare = async () => {};
  const calls: string[] = [];
  const core = new Orchestrator(
    config,
    store,
    git,
    {
      async run(o) {
        calls.push(o.cwd);
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
  return {
    core,
    store,
    file,
    calls,
    async close() {
      await core.stop();
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
async function apply(
  f: Awaited<ReturnType<typeof fixture>>,
  input = roadmap(),
) {
  const { roadmap: p } = await f.core.planner.create(input);
  f.core.planner.validate(p.id, 1);
  return f.core.planner.apply(p.id, 1).roadmap;
}
function integration(
  store: Store,
  jobId: string,
  status = "SUCCEEDED",
  commit = integrated,
) {
  const data = {
    id: 1,
    jobId,
    repository: "/repo",
    ref: "refs/codexbridge/integration/roadmap",
    expectedBase: base,
    previousCommit: null,
    snapshot: {
      evidenceVersion: 2,
      baseCommit: base,
      sourceCommit: base,
      tree: integrated,
      diffIdentity: "fixture",
      status: "",
      iteration: store.get(jobId).iteration,
    },
    resultCommit: commit,
    status,
    commands: [],
    results: [],
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    failure: null,
  };
  store.db
    .prepare("INSERT OR REPLACE INTO reviewed_snapshots VALUES(?,?)")
    .run(jobId, JSON.stringify(data.snapshot));
  store.review(jobId, store.get(jobId).iteration, {
    decision: "ACCEPT",
    summary: "Reviewed",
    issues: [],
    requestedChanges: [],
    humanQuestion: null,
  });
  store.db
    .prepare(
      "INSERT INTO integrations(job_id,repository,status,data) VALUES(?,?,?,?)",
    )
    .run(jobId, "/repo", status, JSON.stringify(data));
}
test("roadmap dry-run, strict surfaces, graph errors, stable apply and restart persistence", async () => {
  const f = await fixture();
  try {
    const p = (await f.core.planner.create(roadmap())).roadmap;
    assert.equal(f.store.list().length, 0);
    assert.throws(() => f.core.planner.apply(p.id, 1), /Validate/);
    f.core.planner.validate(p.id, 1);
    assert.equal(f.store.projects().length, 0);
    const first = f.core.planner.apply(p.id, 1);
    assert.deepEqual(
      f.core.planner.apply(p.id, 1).roadmap.bindings,
      first.roadmap.bindings,
    );
    assert.equal(f.store.list().length, 3);
    assert.equal(f.store.projects().length, 1);
    assert.equal(f.store.features().length, 3);
    const reopened = new Store(f.file);
    try {
      assert.equal(
        reopened.db.prepare("SELECT count(*) AS n FROM roadmaps").get()!.n,
        1,
      );
    } finally {
      reopened.close();
    }
    for (const name of [
      "get_roadmap",
      "get_roadmap_summary",
      "validate_roadmap",
      "reconcile_roadmap",
    ]) {
      const t = toolDefinitions(f.core).find((t) => t.name === name)!;
      const input =
        name === "validate_roadmap" ? { id: p.id, version: 1 } : { id: p.id };
      t.output.parse(await t.run(t.input.parse(input)));
      assert.equal(
        t.input.safeParse({ ...input, surprise: true }).success,
        false,
      );
    }
    await assert.rejects(
      f.core.planner.create(
        roadmap([feature("a", { dependencies: ["missing"] })]),
      ),
      /Unknown/,
    );
    await assert.rejects(
      f.core.planner.create(roadmap([feature("a", { dependencies: ["a"] })])),
      /cycle/,
    );
    await assert.rejects(
      f.core.planner.create(roadmap([feature("a"), feature("a")])),
      /Duplicate/,
    );
    await assert.rejects(
      f.core.planner.create(roadmap([feature("a", { inheritFrom: "b" })])),
      /explicit dependency/,
    );
  } finally {
    await f.close();
  }
});
test("parallel features use P3 priority/cost while fan-in waits for all predecessors", async () => {
  const f = await fixture();
  try {
    const p = await apply(
      f,
      roadmap([
        feature("a", { priority: 50, executionCost: 2 }),
        feature("b"),
        feature("c", { dependencies: ["b", "a", "a"] }),
      ]),
    );
    await f.core.tick();
    await new Promise((r) => setImmediate(r));
    await f.core.tick();
    await new Promise((r) => setImmediate(r));
    assert.equal(f.calls.length, 2);
    assert.equal(f.store.get(p.bindings.a.jobId).priority, 50);
    assert.equal(f.store.get(p.bindings.a.jobId).executionCost, 2);
    const c = f.store.get(p.bindings.c.jobId);
    assert.deepEqual(
      c.dependencies,
      [p.bindings.a.jobId, p.bindings.b.jobId].sort(),
    );
    assert.equal(c.status, "QUEUED");
    assert.equal(
      f.core.planner.read(p.id).features[2].state,
      "waiting-for-dependency",
    );
  } finally {
    await f.close();
  }
});
test("explicit predecessor integration alone supplies downstream immutable startRef", async () => {
  const f = await fixture();
  try {
    const p = await apply(f);
    for (const k of ["a", "b"])
      f.store.patch(p.bindings[k].jobId, { status: "COMPLETED" });
    integration(f.store, p.bindings.b.jobId); // unrelated successful integration cannot release c
    integration(f.store, p.bindings.a.jobId, "FAILED");
    f.core.planner.reconcile(p.id);
    assert.equal(
      f.core.planner.read(p.id).features[2].state,
      "waiting-for-integration",
    );
    assert.equal(f.store.get(p.bindings.c.jobId).schedulingState, "WAITING");
    await f.core.tick();
    assert.equal(f.calls.length, 0);
    integration(f.store, p.bindings.a.jobId);
    f.core.planner.reconcile(p.id);
    const c = f.store.get(p.bindings.c.jobId);
    assert.equal(c.startRef, integrated);
    assert.equal(c.baseCommit, integrated);
    assert.deepEqual(f.core.planner.summary(p.id).nextRunnable, ["c"]);
    f.core.planner.reconcile(p.id);
    assert.equal(f.store.list().length, 3);
    await f.core.tick();
    await new Promise((r) => setImmediate(r));
    assert.equal(f.store.get(c.id).baseCommit, integrated);
    assert.equal(f.calls.length, 1);
  } finally {
    await f.close();
  }
});
test("safe future revisions require revalidation; started execution and legacy dependency bypass are refused", async () => {
  const f = await fixture();
  try {
    const p = await apply(f);
    f.store.patch(p.bindings.a.jobId, { status: "COMPLETED" });
    const next = structuredClone(p.input);
    next.features[1].priority = 88;
    next.features.push({ ...next.features[1], key: "d", dependencies: ["b"] });
    f.core.planner.revise(p.id, 1, next);
    assert.equal(f.store.get(p.bindings.b.jobId).schedulingState, "WAITING");
    assert.throws(() => f.core.planner.apply(p.id, 1), /Stale/);
    assert.throws(() => f.core.planner.apply(p.id, 2), /Validate/);
    f.core.planner.validate(p.id, 2);
    f.core.planner.apply(p.id, 2);
    assert.equal(f.store.list().length, 4);
    assert.equal(f.store.get(p.bindings.b.jobId).priority, 88);
    next.features[0].ticket = "Unsafe";
    assert.throws(() => f.core.planner.revise(p.id, 2, next), /started/);
    assert.throws(
      () => f.store.setDependencies(p.bindings.b.jobId, []),
      /roadmap revisions/,
    );
    assert.equal(f.core.planner.get(p.id).version, 2);
    assert.equal(
      f.store.db.prepare("SELECT count(*) AS n FROM roadmap_versions").get()!.n,
      2,
    );
  } finally {
    await f.close();
  }
});
test("atomic apply rolls back all records on failure and restart reconciles integration waits", async () => {
  const f = await fixture();
  try {
    const p = (await f.core.planner.create(roadmap())).roadmap;
    f.core.planner.validate(p.id, 1);
    const original = f.store.createFeature.bind(f.store);
    let count = 0;
    f.store.createFeature = (input) => {
      if (++count === 2) throw Error("injected failure");
      return original(input);
    };
    assert.throws(() => f.core.planner.apply(p.id, 1), /injected/);
    assert.equal(f.store.list().length, 0);
    assert.equal(f.store.projects().length, 0);
    f.store.createFeature = original;
    const applied = f.core.planner.apply(p.id, 1).roadmap;
    for (const k of ["a", "b"])
      f.store.patch(applied.bindings[k].jobId, { status: "COMPLETED" });
    integration(f.store, applied.bindings.a.jobId);
    const reopened = new Store(f.file);
    const { Planner } = await import("../src/planner.js");
    const { Integration } = await import("../src/integration.js");
    try {
      const planner = new Planner(
        reopened,
        f.core.git,
        new Integration(f.core.config, reopened, f.core.git),
      );
      planner.reconcileAll();
      planner.apply(p.id, 1);
      planner.reconcileAll();
      assert.equal(reopened.get(applied.bindings.c.jobId).startRef, integrated);
      assert.equal(reopened.list().length, 3);
    } finally {
      reopened.close();
    }
  } finally {
    await f.close();
  }
});
test("planner distinguishes review, exhausted failures, dependency blockers and completion", async () => {
  const f = await fixture();
  try {
    const p = await apply(f);
    f.store.patch(p.bindings.a.jobId, { status: "READY_FOR_HUMAN_TEST" });
    f.store.patch(p.bindings.b.jobId, {
      status: "FAILED",
      retry: {
        count: 3,
        nextRetryAt: null,
        exhausted: true,
        lastError: "transport",
      },
    });
    let summary = f.core.planner.summary(p.id);
    assert.equal(summary.failed[0].key, "b");
    assert.equal(summary.failed[0].exhausted, true);
    assert.equal(
      summary.humanAttention.find((f) => f.key === "a")!.state,
      "waiting-for-review",
    );
    assert.equal(summary.blockers.find((f) => f.key === "c")!.state, "blocked");
    for (const b of Object.values(p.bindings))
      f.store.patch(b.jobId, { status: "COMPLETED" });
    assert.equal(f.core.planner.reconcile(p.id).roadmap.state, "complete");
  } finally {
    await f.close();
  }
});

test("completion-only fan-in releases only after every predecessor and revision edges may reverse safely", async () => {
  const f = await fixture();
  try {
    const p = await apply(
      f,
      roadmap([
        feature("a"),
        feature("b"),
        feature("c", { dependencies: ["a", "b"] }),
      ]),
    );
    f.store.patch(p.bindings.a.jobId, { status: "COMPLETED" });
    f.core.planner.reconcile(p.id);
    assert.equal(f.store.get(p.bindings.c.jobId).schedulingState, "WAITING");
    f.store.patch(p.bindings.b.jobId, { status: "COMPLETED" });
    f.core.planner.reconcile(p.id);
    assert.equal(f.store.get(p.bindings.c.jobId).schedulingState, "READY");
    assert.equal(f.store.get(p.bindings.c.jobId).baseCommit, base);
    assert.equal(f.core.integration.history(p.bindings.a.jobId).length, 0);
    const other = await apply(
      f,
      roadmap([feature("a"), feature("b", { dependencies: ["a"] })]),
    );
    const next = structuredClone(other.input);
    next.features[0].dependencies = ["b"];
    next.features[1].dependencies = [];
    f.core.planner.revise(other.id, 1, next);
    f.core.planner.validate(other.id, 2);
    f.core.planner.apply(other.id, 2);
    assert.deepEqual(f.store.get(other.bindings.a.jobId).dependencies, [
      other.bindings.b.jobId,
    ]);
    assert.equal(f.store.get(other.bindings.b.jobId).schedulingState, "READY");
  } finally {
    await f.close();
  }
});

for (const reserved of ["constructor", "toString"]) {
  test(`prototype feature key ${reserved} survives creation, revision, apply and restart`, async () => {
    const f = await fixture();
    try {
      const input = roadmap([
        feature(reserved),
        feature("downstream", {
          dependencies: [reserved],
          inheritFrom: reserved,
        }),
      ]);
      const p = (await f.core.planner.create(input)).roadmap;
      assert.equal(f.core.planner.read(p.id).features[0].state, "planned");
      f.core.planner.reconcileAll();
      f.core.planner.reconcileAll();
      const next = structuredClone(p.input);
      next.features[0].priority = 42;
      f.core.planner.revise(p.id, 1, next);
      f.core.planner.validate(p.id, 2);
      const applied = f.core.planner.apply(p.id, 2).roadmap;
      assert.equal(f.store.list().length, 2);
      assert.deepEqual(
        f.core.planner.apply(p.id, 2).roadmap.bindings,
        applied.bindings,
      );
      f.store.patch(applied.bindings[reserved].jobId, { status: "COMPLETED" });
      integration(f.store, applied.bindings[reserved].jobId);
      const reopened = new Store(f.file);
      const resumed = new Orchestrator(
        f.core.config,
        reopened,
        f.core.git,
        {
          async run() {
            throw Error("Not dispatched during recovery");
          },
        },
        {
          async review() {
            throw Error("Unexpected review");
          },
        },
      );
      try {
        await resumed.recover();
        resumed.planner.reconcileAll();
        resumed.planner.reconcileAll();
        assert.equal(
          reopened.get(applied.bindings.downstream.jobId).startRef,
          integrated,
        );
        assert.deepEqual(resumed.planner.summary(p.id).nextRunnable, [
          "downstream",
        ]);
        const unrelated = await apply(f, roadmap([feature("unrelated")]));
        await f.core.tick();
        await new Promise((r) => setImmediate(r));
        await f.core.tick();
        await new Promise((r) => setImmediate(r));
        assert.equal(
          f.store.get(unrelated.bindings.unrelated.jobId).status,
          "CODEX_RUNNING",
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
