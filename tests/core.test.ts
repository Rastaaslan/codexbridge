import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Store } from "../src/database.js";
import { GitWorkspace, git, inside } from "../src/git.js";
import { Orchestrator } from "../src/orchestrator.js";
import {
  assertTransition,
  createSchema,
  resultSchema,
  reviewSchema,
} from "../src/domain.js";
import { configSchema } from "../src/config.js";
import { redact } from "../src/log.js";
import {
  HumanRequired,
  type CodexAdapter,
  type RunOptions,
} from "../src/codex.js";
import type { Reviewer } from "../src/reviewer.js";
import { AutomaticReviewer } from "../src/reviewer.js";
import { toolDefinitions } from "../src/tools.js";

export const successful = {
  status: "completed",
  summary: "Fixed addition",
  changedFiles: ["add.js"],
  testsExecuted: ["node --test"],
  testsPassed: true,
  remainingIssues: [],
  questions: [],
  requiresHumanDecision: false,
} as const;
const accept = {
  decision: "ACCEPT",
  summary: "Criteria satisfied",
  issues: [],
  requestedChanges: [],
  humanQuestion: null,
} as const;
async function fixture(adapter?: CodexAdapter, reviewer?: Reviewer) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codexbridge-test-"));
  const repo = path.join(dir, "repo"),
    dataDir = path.join(dir, "state");
  await mkdir(repo);
  await mkdir(dataDir);
  await git(repo, ["init"]);
  await git(repo, ["config", "user.name", "CodexBridge Tests"]);
  await git(repo, ["config", "user.email", "tests@example.invalid"]);
  await writeFile(
    path.join(repo, "add.js"),
    "export const add = (a,b) => a+b+1;\n",
  );
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "fixture"]);
  const config = configSchema.parse({
    dataDir,
    repositoryRoots: [repo],
    token: "x".repeat(64),
  });
  const store = new Store(path.join(dataDir, "codexbridge.db"));
  const calls: RunOptions[] = [];
  const worker = adapter ?? {
    async run(o: RunOptions) {
      calls.push(o);
      o.onThread(o.threadId || "thread-one");
      await writeFile(
        path.join(o.cwd, "add.js"),
        "export const add = (a,b) => a+b;\n",
      );
      return { ...successful };
    },
  };
  const core = new Orchestrator(
    config,
    store,
    new GitWorkspace(config),
    worker,
    reviewer ?? {
      async review() {
        return { ...accept, issues: [], requestedChanges: [] };
      },
    },
  );
  return {
    core,
    store,
    repo,
    dir,
    config,
    calls,
    async cleanup() {
      await core.stop();
      store.close();
    },
  };
}
async function settle(core: Orchestrator, id: string) {
  for (let i = 0; i < 300; i++) {
    const job = core.store.get(id);
    if (
      [
        "READY_FOR_HUMAN_TEST",
        "WAITING_FOR_HUMAN",
        "FAILED",
        "CANCELLED",
      ].includes(job.status)
    )
      return job;
    await core.tick();
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error("Job did not settle");
}
const ticket = (repository: string) => ({
  title: "Fix add",
  ticket: "Return the sum",
  repository,
  acceptanceCriteria: ["2+2=4"],
  options: { maxIterations: 3 },
});

test("state machine rejects skipping review and terminal changes", () => {
  assertTransition("REVIEWING", "ACCEPTED");
  assert.throws(() => assertTransition("CODEX_RUNNING", "COMPLETED"));
  assert.throws(() => assertTransition("COMPLETED", "QUEUED"));
});
test("strict input, results and reviews", () => {
  assert.throws(() => createSchema.parse({ ...ticket("/tmp"), shell: "rm" }));
  assert.throws(() => resultSchema.parse({ summary: "ok" }));
  assert.throws(() => reviewSchema.parse({ ...accept, decision: "APPROVED" }));
  assert.equal(inside("/repo", "/repo-other"), false);
});
test("redaction masks environment credentials and bearer tokens", () => {
  process.env.CODEXBRIDGE_TEST_SECRET = "secret-super-long-value";
  assert.ok(
    !redact({
      text: "secret-super-long-value Bearer abcdefghijklmnop sk-abcdefghijklmnop",
    }).includes("secret-super-long-value"),
  );
  delete process.env.CODEXBRIDGE_TEST_SECRET;
});
test("redaction preserves valid structured JSON and masks nested credential fields", () => {
  const clean = JSON.parse(
    redact({
      authorization: "Bearer abc",
      nested: { password: "a long password" },
      ticket: 'password="multi word secret"',
      id: "CB-1",
    }),
  );
  assert.equal(clean.authorization, "[REDACTED]");
  assert.equal(clean.nested.password, "[REDACTED]");
  assert.ok(!clean.ticket.includes("multi word secret"));
  assert.equal(clean.id, "CB-1");
});
test("SQLite migrations, idempotency, events and reopen", async () => {
  const f = await fixture();
  try {
    const input = createSchema.parse({
      ...ticket(f.repo),
      options: { maxIterations: 3, idempotencyKey: "unique" },
    });
    const j = f.store.create(input);
    assert.equal(f.store.create(input).id, j.id);
    assert.throws(() => f.store.create({ ...input, ticket: "different" }));
    f.store.event(j.id, "TEST", { x: 1 });
    const second = new Store(path.join(f.config.dataDir, "codexbridge.db"));
    assert.equal(second.get(j.id).ticket, input.ticket);
    assert.equal(second.events(j.id).length, 2);
    second.close();
  } finally {
    await f.cleanup();
  }
});
test("real Git isolation, loop REQUEST_CHANGES resumes same thread and report persists", async () => {
  let reviews = 0;
  const f = await fixture(undefined, {
    async review() {
      return ++reviews === 1
        ? {
            decision: "REQUEST_CHANGES",
            summary: "More tests",
            issues: ["coverage"],
            requestedChanges: ["Add edge case"],
            humanQuestion: null,
          }
        : { ...accept, issues: [], requestedChanges: [] };
    },
  });
  try {
    const j = await f.core.create(ticket(f.repo));
    const done = await settle(f.core, j.id);
    assert.equal(done.status, "READY_FOR_HUMAN_TEST");
    assert.equal(done.iteration, 2);
    assert.equal(f.calls[1].threadId, "thread-one");
    assert.match(f.calls[1].prompt, /Add edge case/);
    assert.match(
      await readFile(path.join(f.repo, "add.js"), "utf8"),
      /a\+b\+1/,
    );
    assert.equal(await git(f.repo, ["status", "--porcelain"]), "");
    const report = await f.core.report(j.id);
    assert.equal(report.reviews.length, 2);
    assert.match(JSON.stringify(report.changes), /add.js/);
    await f.core.action(j.id, "approve");
    assert.equal(f.store.get(j.id).status, "COMPLETED");
  } finally {
    await f.cleanup();
  }
});
test("human question persists and resumes the existing thread after decision", async () => {
  let n = 0;
  const f = await fixture({
    async run(o) {
      o.onThread(o.threadId || "human-thread");
      return ++n === 1
        ? {
            ...successful,
            status: "blocked",
            requiresHumanDecision: true,
            questions: ["Choose A or B"],
          }
        : { ...successful };
    },
  });
  try {
    const j = await f.core.create(ticket(f.repo));
    assert.equal((await settle(f.core, j.id)).status, "WAITING_FOR_HUMAN");
    await f.core.action(j.id, "send_instruction", "A");
    assert.equal((await settle(f.core, j.id)).status, "READY_FOR_HUMAN_TEST");
    assert.equal(f.store.get(j.id).codexThreadId, "human-thread");
    assert.equal(f.store.decisions(j.id).length, 1);
  } finally {
    await f.cleanup();
  }
});
test("iteration budget stops correction loop without inventing human decision", async () => {
  const f = await fixture(undefined, {
    async review() {
      return {
        decision: "REQUEST_CHANGES",
        summary: "Fix it",
        issues: ["bug"],
        requestedChanges: ["Fix bug"],
        humanQuestion: null,
      };
    },
  });
  try {
    const j = await f.core.create({
      ...ticket(f.repo),
      options: { maxIterations: 1 },
    });
    const done = await settle(f.core, j.id);
    assert.equal(done.status, "FAILED");
    assert.match(done.blocker!, /budget/);
    assert.equal(done.iteration, 1);
  } finally {
    await f.cleanup();
  }
});
for (const kind of [
  "worker",
  "reviewer",
  "invalid-output",
  "human-review",
  "missing-credential",
  "failed-tests",
] as const)
  test(`handles ${kind} without global crash`, async () => {
    const f = await fixture(
      {
        async run(o) {
          o.onThread("thread");
          if (kind === "worker") throw Error("Codex unavailable");
          if (kind === "missing-credential")
            throw new HumanRequired("Authenticate locally");
          if (kind === "invalid-output") return {};
          return { ...successful, testsPassed: kind !== "failed-tests" };
        },
      },
      {
        async review() {
          if (kind === "reviewer") throw Error("OpenAI unavailable");
          return kind === "human-review"
            ? {
                decision: "HUMAN_REQUIRED",
                summary: "UX",
                issues: [],
                requestedChanges: [],
                humanQuestion: "A or B?",
              }
            : { ...accept, issues: [], requestedChanges: [] };
        },
      },
    );
    try {
      const j = await f.core.create({
        ...ticket(f.repo),
        options: { maxIterations: 1 },
      });
      assert.equal(
        (await settle(f.core, j.id)).status,
        ["human-review", "missing-credential"].includes(kind)
          ? "WAITING_FOR_HUMAN"
          : "FAILED",
      );
    } finally {
      await f.cleanup();
    }
  });
test("cancel interrupts worker and cannot be overwritten by late result", async () => {
  let started!: () => void;
  const ready = new Promise<void>((r) => (started = r));
  const f = await fixture({
    async run(o) {
      o.onThread("cancel-thread");
      started();
      await new Promise<void>((_, reject) =>
        o.signal.addEventListener("abort", () => reject(Error("cancelled"))),
      );
      return successful;
    },
  });
  try {
    const j = await f.core.create(ticket(f.repo));
    await ready;
    await f.core.action(j.id, "cancel");
    assert.equal(f.store.get(j.id).status, "CANCELLED");
    assert.equal(f.store.get(j.id).codexThreadId, "cancel-thread");
  } finally {
    await f.cleanup();
  }
});
test("recovery preserves worktree, thread, history and blocks duplicate work", async () => {
  const f = await fixture();
  try {
    const j = f.store.create(createSchema.parse(ticket(f.repo)));
    f.store.transition(j.id, "PREPARING");
    const plan = await f.core.git.plan(j);
    f.store.patch(j.id, plan);
    await f.core.git.prepare(f.store.get(j.id));
    f.store.transition(j.id, "CODEX_RUNNING", {
      iteration: 1,
      codexThreadId: "recover-thread",
      childPid: process.pid,
    });
    await f.core.recover();
    assert.equal(f.store.get(j.id).status, "FAILED");
    await assert.rejects(() => f.core.action(j.id, "retry"), /still alive/);
    f.store.patch(j.id, { childPid: null });
    await f.core.action(j.id, "retry");
    assert.equal((await settle(f.core, j.id)).status, "READY_FOR_HUMAN_TEST");
    assert.equal(f.calls[0].threadId, "recover-thread");
    assert.equal(f.store.get(j.id).worktree, plan.worktree);
  } finally {
    await f.cleanup();
  }
});
test("allowed roots and repository locks enforce isolation", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () => f.core.git.repository(path.dirname(f.repo)),
      /outside/,
    );
    await assert.rejects(() => f.core.git.repository("../repo"), /absolute/);
    f.store.lock(f.repo, "CB-1");
    assert.throws(() => f.store.lock(f.repo, "CB-2"));
    f.store.unlock("CB-1");
    f.store.lock(f.repo, "CB-2");
  } finally {
    await f.cleanup();
  }
});
test("every MCP tool declares strict input and structured output", async () => {
  const f = await fixture();
  try {
    const definitions = toolDefinitions(f.core);
    assert.equal(definitions.length, 16);
    for (const t of definitions)
      assert.equal(t.input.safeParse({ unexpected: true }).success, false);
    const create = definitions.find((t) => t.name === "create_job")!;
    const output = await create.run(ticket(f.repo));
    assert.equal(create.output.safeParse(output).success, true);
    await settle(f.core, (output as any).job.id);
  } finally {
    await f.cleanup();
  }
});
test("OpenAI reviewer fails explicitly without API credentials", async () => {
  const f = await fixture();
  const prior = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const j = f.store.create(createSchema.parse(ticket(f.repo)));
    const reviewer = new AutomaticReviewer(
      { ...f.config, reviewer: "openai" },
      {} as CodexAdapter,
    );
    await assert.rejects(
      () =>
        reviewer.review(
          { job: j, diff: "", history: [] },
          { signal: new AbortController().signal, onEvent() {}, onPid() {} },
        ),
      HumanRequired,
    );
  } finally {
    if (prior) process.env.OPENAI_API_KEY = prior;
    await f.cleanup();
  }
});

test("startRef freezes branch/tag/SHA and survives idempotent replay and database reopen", async () => {
  const f = await fixture();
  await f.core.stop();
  try {
    const original = await git(f.repo, ["rev-parse", "HEAD"]);
    await git(f.repo, ["branch", "feature/a,b"]);
    await git(f.repo, ["tag", "-a", "v-test", "-m", "tag fixture"]);
    const input = {
      ...ticket(f.repo),
      startRef: "feature/a,b",
      options: { idempotencyKey: "frozen" },
    };
    const j = await f.core.create(input);
    assert.equal(j.baseCommit, original);
    for (const startRef of ["v-test", original, "refs/heads/feature/a,b"]) {
      const other = await f.core.create({ ...ticket(f.repo), startRef });
      assert.equal(other.baseCommit, original);
    }
    await writeFile(path.join(f.repo, "new.txt"), "new commit");
    await git(f.repo, ["add", "."]);
    await git(f.repo, ["commit", "-m", "advance branch"]);
    await git(f.repo, ["branch", "-f", "feature/a,b", "HEAD"]);
    const replay = await f.core.create(input);
    assert.equal(replay.id, j.id);
    assert.equal(replay.baseCommit, original);
    const plan = await f.core.git.plan(replay);
    assert.equal(plan.baseCommit, original);
    const prepared = f.store.patch(j.id, plan);
    await f.core.git.prepare(prepared);
    assert.equal(
      await git(prepared.worktree!, ["rev-parse", "HEAD"]),
      original,
    );
    const reopened = new Store(path.join(f.config.dataDir, "codexbridge.db"));
    try {
      assert.equal(reopened.get(j.id).baseCommit, original);
    } finally {
      reopened.close();
    }
    await assert.rejects(
      () => f.core.create({ ...input, startRef: "v-test" }),
      /different input/,
    );
    await git(f.repo, ["branch", "-D", "feature/a,b"]);
    assert.equal((await f.core.create(input)).baseCommit, original);
  } finally {
    await f.cleanup();
  }
});

test("startRef fails closed without inserting a job; absent ref keeps preparation-time HEAD", async () => {
  const f = await fixture();
  await f.core.stop();
  try {
    const blob = await git(f.repo, ["rev-parse", "HEAD:add.js"]);
    for (const startRef of [
      "missing-branch",
      "--help",
      "",
      "HEAD\n",
      "HEAD;echo",
      blob,
    ]) {
      await assert.rejects(() =>
        f.core.create({ ...ticket(f.repo), startRef }),
      );
      assert.equal(f.store.list().length, 0);
    }
    const j = await f.core.create(ticket(f.repo));
    assert.equal(j.baseCommit, null);
    await writeFile(path.join(f.repo, "advance.txt"), "advance");
    await git(f.repo, ["add", "."]);
    await git(f.repo, ["commit", "-m", "advance before prepare"]);
    assert.equal(
      (await f.core.git.plan(j)).baseCommit,
      await git(f.repo, ["rev-parse", "HEAD"]),
    );
  } finally {
    await f.cleanup();
  }
});

test("headless summaries, bounded redacted logs, strict tools and maintenance preserve queued jobs", async () => {
  const f = await fixture();
  await f.core.stop();
  try {
    const { overview, recentLogs, doctor, maintenanceFile } =
      await import("../src/headless.js");
    const j = await f.core.create(ticket(f.repo));
    f.store.patch(j.id, {
      status: "WAITING_FOR_HUMAN",
      blocker: "Choose the target",
    });
    const queued = await f.core.create(ticket(f.repo));
    assert.equal(overview(f.core).counts.waiting, 1);
    assert.equal(overview(f.core).counts.queued, 1);
    assert.equal(overview(f.core).attention[0].blocker, "Choose the target");
    await writeFile(maintenanceFile(f.config.dataDir), "{}");
    await assert.rejects(() => f.core.create(ticket(f.repo)), /maintenance/);
    f.core.start();
    await f.core.tick();
    assert.equal(f.store.get(queued.id).status, "QUEUED");
    await f.core.stop();
    const file = path.join(
      f.config.dataDir,
      "logs",
      `${new Date().toISOString().slice(0, 10)}.jsonl`,
    );
    await writeFile(
      file,
      "old line\n".repeat(10000) + "Bearer sensitive_test_value\nlast\n",
    );
    const logs = await recentLogs(f.core, 2);
    assert.equal(logs.truncated, true);
    assert.deepEqual(logs.lines, ["[REDACTED]", "last"]);
    f.config.codexCommand = "codexbridge-missing-test-command";
    const health = await doctor(f.core);
    assert.equal(health.ok, false);
    assert.equal(health.maintenance, true);
    assert.equal(health.checks.find((c) => c.name === "database")?.ok, true);
    const tools = toolDefinitions(f.core);
    const update = tools.find((t) => t.name === "self_update")!;
    assert.equal(update.input.safeParse({}).success, false);
    assert.equal(
      update.input.safeParse({ ref: "main", startRef: "main" }).success,
      false,
    );
    assert.equal(
      update.input.safeParse({ ref: "--upload-pack=evil" }).success,
      false,
    );
    assert.equal(
      update.input.safeParse({ startRef: "refs/tags/v1" }).success,
      true,
    );
    await assert.rejects(
      () => update.run({ ref: "main" }),
      /Maintenance in progress/,
    );
    for (const name of ["server_doctor", "jobs_overview", "server_logs"]) {
      const tool = tools.find((t) => t.name === name)!;
      assert.equal(
        tool.output.safeParse(await tool.run(tool.input.parse({}))).success,
        true,
      );
    }
  } finally {
    await f.cleanup();
  }
});

for (const phase of ["activating", "rollback_failed"]) {
  for (const healthy of [true, false]) {
    test(`boot ${phase} keeps jobs queued until restored health is ${healthy}`, async () => {
      const f = await fixture();
      await f.core.stop();
      const { recover, verifyRecovery } =
        await import("../scripts/self-update.mjs");
      const { maintenanceFile } = await import("../src/headless.js");
      const { unlink } = await import("node:fs/promises");
      let state: any = { phase, previous: "old", candidate: "new" };
      const queued = await f.core.create(ticket(f.repo));
      const driver = {
        hold: () => writeFile(maintenanceFile(f.config.dataDir), "{}"),
        activate: async (release: string) => {
          assert.equal(release, "old");
        },
        save: async (next: any) => {
          state = next;
        },
        restart: async () => {
          throw Error("Boot recovery must not restart systemd dependencies");
        },
        health: async () => {
          assert.equal(f.store.get(queued.id).status, "QUEUED");
          if (!healthy) throw Error("restored service unhealthy");
        },
        resume: () => unlink(maintenanceFile(f.config.dataDir)),
      };
      try {
        await recover(driver, state, true);
        assert.equal(state.phase, "boot_pending_health");
        // A second reboot before validation must retain the gate too.
        await recover(driver, state, true);
        f.core.start();
        await f.core.tick();
        assert.equal(f.store.get(queued.id).status, "QUEUED");
        await assert.rejects(
          () => f.core.create(ticket(f.repo)),
          /maintenance/,
        );
        if (healthy) {
          await verifyRecovery(driver, state);
          assert.equal(state.phase, "rolled_back");
          assert.equal(
            (await settle(f.core, queued.id)).status,
            "READY_FOR_HUMAN_TEST",
          );
        } else {
          await assert.rejects(
            () => verifyRecovery(driver, state),
            /unhealthy/,
          );
          assert.equal(state.phase, "rollback_failed");
          await f.core.tick();
          assert.equal(f.store.get(queued.id).status, "QUEUED");
          await assert.rejects(
            () => f.core.create(ticket(f.repo)),
            /maintenance/,
          );
        }
      } finally {
        await f.cleanup();
      }
    });
  }
}
