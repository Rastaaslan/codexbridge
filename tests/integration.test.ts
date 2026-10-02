import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configSchema } from "../src/config.js";
import { Store } from "../src/database.js";
import { GitWorkspace, git } from "../src/git.js";
import { Orchestrator } from "../src/orchestrator.js";
import { createSchema } from "../src/domain.js";
import { Integration, integrationSchema } from "../src/integration.js";
import { toolDefinitions } from "../src/tools.js";

async function fixture(
  options: {
    edit?: (cwd: string) => Promise<void>;
    evidence?: (diff: { diff: string; changedFiles: string[] }) => void;
  } = {},
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cb-integration-"));
  const repo = path.join(dir, "repo"),
    dataDir = path.join(dir, "data");
  await mkdir(repo);
  await mkdir(dataDir);
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "Test"]);
  await git(repo, ["config", "user.email", "test@example.invalid"]);
  await writeFile(path.join(repo, "value"), "initial");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "initial"]);
  const base = await git(repo, ["rev-parse", "HEAD"]);
  // Any attempted push to the configured remote fails; refs are checked below too.
  await git(repo, ["remote", "add", "origin", path.join(dir, "nonexistent")]);
  const config = configSchema.parse({
    dataDir,
    repositoryRoots: [repo],
    token: "x".repeat(64),
    integrationCommands: [
      {
        command: process.execPath,
        args: [
          "-e",
          "if(require('fs').readFileSync('value','utf8')!=='reviewed')process.exit(1)",
        ],
      },
    ],
  });
  let store = new Store(path.join(dataDir, "db"));
  const workspace = new GitWorkspace(config);
  const core = new Orchestrator(
    config,
    store,
    workspace,
    {
      async run(o) {
        await writeFile(path.join(o.cwd, "value"), "reviewed");
        await options.edit?.(o.cwd);
        return {
          status: "completed",
          summary: "done",
          changedFiles: ["value"],
          testsExecuted: ["fixture"],
          testsPassed: true,
          remainingIssues: [],
          questions: [],
          requiresHumanDecision: false,
        };
      },
    },
    {
      async review({ diff }) {
        options.evidence?.(diff);
        return {
          decision: "ACCEPT",
          summary: "ok",
          issues: [],
          requestedChanges: [],
          humanQuestion: null,
        };
      },
    },
  );
  const job = await core.create({
    title: "source",
    ticket: "change",
    repository: repo,
  });
  for (
    let i = 0;
    i < 300 && store.get(job.id).status !== "READY_FOR_HUMAN_TEST";
    i++
  )
    await new Promise((r) => setTimeout(r, 20));
  assert.equal(store.get(job.id).status, "READY_FOR_HUMAN_TEST");
  return {
    dir,
    repo,
    base,
    config,
    core,
    workspace,
    get store() {
      return store;
    },
    job: store.get(job.id),
    reopen() {
      store.close();
      store = new Store(path.join(dataDir, "db"));
      return new Integration(config, store, workspace);
    },
    async cleanup() {
      await core.stop();
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("explicit integration, strict surfaces, idempotency, restart and downstream startRef", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.core.integration.history(f.job.id), []);
    assert.equal(
      await git(f.repo, ["for-each-ref", "refs/codexbridge/integration"]),
      "",
    );
    const action = toolDefinitions(f.core).find(
      (t) => t.name === "integrate_job",
    )!;
    assert.throws(() =>
      action.input.parse({
        id: f.job.id,
        target: "main",
        expectedBase: f.base,
        push: true,
      }),
    );
    const request = { id: f.job.id, target: "feature", expectedBase: f.base };
    const result = action.output.parse(await action.run(request)) as {
      integration: ReturnType<typeof integrationSchema.parse>;
    };
    const a = result.integration;
    assert.equal(a.status, "SUCCEEDED", a.failure ?? "");
    assert.equal(a.results[0].exitCode, 0);
    assert.equal(await git(f.repo, ["rev-parse", "main"]), f.base);
    assert.equal(await git(f.repo, ["for-each-ref", "refs/remotes"]), "");
    assert.equal(
      await git(f.repo, ["show", `${a.resultCommit}:value`]),
      "reviewed",
    );
    assert.equal(
      await git(f.repo, ["rev-parse", `${a.resultCommit}^`]),
      f.base,
    );
    assert.equal((await f.core.integration.integrate(request)).id, a.id);
    await assert.rejects(
      f.core.integration.integrate({ ...request, target: "other" }),
      /Conflicting duplicate/,
    );
    const reportTool = toolDefinitions(f.core).find(
      (t) => t.name === "get_job_report",
    )!;
    reportTool.output.parse(await f.core.report(f.job.id));
    await f.core.stop();
    const downstream = await f.core.create({
      title: "next",
      ticket: "next",
      repository: f.repo,
      startRef: a.ref,
    });
    assert.equal(downstream.baseCommit, a.resultCommit);
    const plan = await f.workspace.plan(downstream);
    const prepared = f.store.patch(downstream.id, plan);
    await f.workspace.prepare(prepared);
    assert.equal(
      await git(prepared.worktree!, ["rev-parse", "HEAD"]),
      a.resultCommit,
    );
    const reopened = f.reopen();
    assert.equal(
      (await reopened.integrate(request)).resultCommit,
      a.resultCommit,
    );
    assert.equal(reopened.history(f.job.id).length, 1);
  } finally {
    await f.cleanup();
  }
});

test("failed verification and drift never advance the previous successful baseline; retry succeeds", async () => {
  const f = await fixture();
  try {
    const request = { id: f.job.id, target: "chain", expectedBase: f.base };
    const first = await f.core.integration.integrate(request);
    assert.equal(first.status, "SUCCEEDED");
    const next = f.store.create(
      createSchema.parse({
        title: "next",
        ticket: "next",
        repository: f.repo,
        startRef: first.ref,
      }),
      first.resultCommit,
    );
    const prepared = f.store.patch(next.id, await f.workspace.plan(next));
    await f.workspace.prepare(prepared);
    await writeFile(path.join(prepared.worktree!, "new"), "content");
    f.store.patch(next.id, { status: "READY_FOR_HUMAN_TEST" });
    f.store.review(next.id, 0, {
      decision: "ACCEPT",
      summary: "ok",
      issues: [],
      requestedChanges: [],
      humanQuestion: null,
    });
    f.core.integration.seal(
      next.id,
      await f.core.integration.snapshot(f.store.get(next.id)),
    );
    const req = {
      id: next.id,
      target: "chain",
      expectedBase: first.resultCommit!,
    };
    f.config.integrationCommands = [
      {
        command: process.execPath,
        args: ["-e", "process.exit(7)"],
        timeoutMs: 1000,
      },
    ];
    const failed = await f.core.integration.integrate(req);
    assert.equal(failed.status, "FAILED");
    assert.equal(failed.results[0].exitCode, 7);
    assert.equal(
      await git(f.repo, ["rev-parse", first.ref]),
      first.resultCommit,
    );
    await writeFile(path.join(prepared.worktree!, "new"), "drift");
    assert.match((await f.core.integration.integrate(req)).failure!, /drift/);
    await writeFile(path.join(prepared.worktree!, "new"), "content");
    await writeFile(path.join(f.repo, "dirty"), "unexpected");
    assert.match((await f.core.integration.integrate(req)).failure!, /dirty/);
    await rm(path.join(f.repo, "dirty"));
    assert.match(
      (await f.core.integration.integrate({ ...req, expectedBase: f.base }))
        .failure!,
      /Stale/,
    );
    f.config.integrationCommands = [
      { command: process.execPath, args: ["-e", ""], timeoutMs: 1000 },
    ];
    const ok = await f.core.integration.integrate(req);
    assert.equal(ok.status, "SUCCEEDED", ok.failure ?? "");
    assert.equal(await git(f.repo, ["rev-parse", "main"]), f.base);
    const reopened = f.reopen();
    assert.equal(reopened.history(next.id).length, 5);
  } finally {
    await f.cleanup();
  }
});

test("concurrent duplicates conflict and verification mutations are rejected", async () => {
  const f = await fixture();
  try {
    f.config.integrationCommands = [
      {
        command: process.execPath,
        args: [
          "-e",
          "setTimeout(()=>require('fs').writeFileSync('extra','bad'),100)",
        ],
        timeoutMs: 1000,
      },
    ];
    const req = { id: f.job.id, target: "test", expectedBase: f.base };
    const running = f.core.integration.integrate(req);
    await assert.rejects(f.core.integration.integrate(req), /in progress/);
    await assert.rejects(
      f.core.action(f.job.id, "reject", "redo"),
      /Integration in progress/,
    );
    assert.match((await running).failure!, /candidate state/);
    assert.equal(
      await git(f.repo, ["for-each-ref", "refs/codexbridge/integration"]),
      "",
    );
  } finally {
    await f.cleanup();
  }
});

test("restart reconciles the ref publication boundary and retains interrupted attempts", async () => {
  const f = await fixture();
  try {
    const req = { id: f.job.id, target: "recovery", expectedBase: f.base };
    const a = await f.core.integration.integrate(req);
    assert.equal(a.status, "SUCCEEDED");
    a.status = "PUBLISHING";
    a.finishedAt = null;
    f.store.db
      .prepare("UPDATE integrations SET status=?,data=? WHERE id=?")
      .run(a.status, JSON.stringify(a), a.id);
    let reopened = f.reopen();
    await reopened.recover();
    assert.equal(reopened.history(f.job.id)[0].status, "SUCCEEDED");
    a.status = "VERIFYING";
    a.resultCommit = null;
    f.store.db
      .prepare("UPDATE integrations SET status=?,data=? WHERE id=?")
      .run(a.status, JSON.stringify(a), a.id);
    reopened = f.reopen();
    await reopened.recover();
    const interrupted = reopened.history(f.job.id)[0];
    assert.equal(interrupted.status, "FAILED");
    assert.match(interrupted.failure!, /Interrupted/);
    assert.equal(
      await git(f.repo, ["rev-parse", a.ref]),
      await git(f.repo, ["rev-parse", `${a.ref}^{commit}`]),
    );
  } finally {
    await f.cleanup();
  }
});

test("a symbolic integration ref cannot mutate main", async () => {
  const f = await fixture();
  try {
    await git(f.repo, [
      "symbolic-ref",
      "refs/codexbridge/integration/symbolic",
      "refs/heads/main",
    ]);
    const a = await f.core.integration.integrate({
      id: f.job.id,
      target: "symbolic",
      expectedBase: f.base,
    });
    assert.equal(await git(f.repo, ["rev-parse", "main"]), f.base);
    assert.equal(a.status, "FAILED");
    assert.match(a.failure!, /symbolic/);
  } finally {
    await f.cleanup();
  }
});

for (const kind of ["force-added ignored", "assume-unchanged"] as const) {
  test(`canonical review and integration preserve ${kind} content and reject drift`, async () => {
    let indexBefore: Buffer;
    let evidence: { diff: string; changedFiles: string[] } | undefined;
    const file = kind === "force-added ignored" ? "hidden.txt" : "value";
    const f = await fixture({
      async edit(cwd) {
        if (kind === "force-added ignored") {
          await writeFile(path.join(cwd, ".gitignore"), "hidden.txt\n");
          await writeFile(path.join(cwd, file), "reviewed addition\n");
          await git(cwd, ["add", "-f", "--", file]);
        } else {
          await git(cwd, ["update-index", "--assume-unchanged", "--", file]);
          assert.equal(await git(cwd, ["diff", "HEAD", "--", file]), "");
        }
        indexBefore = await readFile(
          path.resolve(
            cwd,
            await git(cwd, ["rev-parse", "--git-path", "index"]),
          ),
        );
      },
      evidence(diff) {
        evidence = diff;
      },
    });
    try {
      assert.ok(evidence);
      assert.ok(evidence.changedFiles.includes(file));
      assert.match(
        evidence.diff,
        kind === "force-added ignored" ? /\+reviewed addition/ : /\+reviewed/,
      );
      const indexPath = path.resolve(
        f.job.worktree!,
        await git(f.job.worktree!, ["rev-parse", "--git-path", "index"]),
      );
      assert.deepEqual(await readFile(indexPath), indexBefore!);
      const request = {
        id: f.job.id,
        target: "canonical",
        expectedBase: f.base,
      };
      const reviewedContent = await readFile(path.join(f.job.worktree!, file));
      await writeFile(path.join(f.job.worktree!, file), "unreviewed drift\n");
      const rejected = await f.core.integration.integrate(request);
      assert.equal(rejected.status, "FAILED");
      assert.match(rejected.failure!, /drift/);
      assert.equal(
        await git(f.repo, ["for-each-ref", "refs/codexbridge/integration"]),
        "",
      );
      await writeFile(path.join(f.job.worktree!, file), reviewedContent);
      const integrated = await f.core.integration.integrate(request);
      assert.equal(integrated.status, "SUCCEEDED", integrated.failure ?? "");
      const actualDiff = await git(f.repo, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--binary",
        "--full-index",
        f.base,
        integrated.resultCommit!,
        "--",
      ]);
      assert.equal(actualDiff, evidence.diff);
      assert.equal(
        await git(f.repo, ["show", `${integrated.resultCommit}:${file}`]),
        reviewedContent.toString().trimEnd(),
      );
      assert.deepEqual(await readFile(indexPath), indexBefore!);
    } finally {
      await f.cleanup();
    }
  });
}

test("legacy snapshots require canonical review evidence before integration", async () => {
  const f = await fixture();
  try {
    const row = f.store.db
      .prepare("SELECT data FROM reviewed_snapshots WHERE job_id=?")
      .get(f.job.id)!;
    const legacy = JSON.parse(String(row.data));
    delete legacy.evidenceVersion;
    f.store.db
      .prepare("UPDATE reviewed_snapshots SET data=? WHERE job_id=?")
      .run(JSON.stringify(legacy), f.job.id);
    const attempt = await f.core.integration.integrate({
      id: f.job.id,
      target: "legacy",
      expectedBase: f.base,
    });
    assert.equal(attempt.status, "FAILED");
    assert.match(attempt.failure!, /review the job again/);
    assert.equal(
      await git(f.repo, ["for-each-ref", "refs/codexbridge/integration"]),
      "",
    );
  } finally {
    await f.cleanup();
  }
});

test("planner refuses an integrated predecessor's obsolete review after rejection, rework and restart", async () => {
  let revision = 0;
  const f = await fixture({
    async edit(cwd) {
      await writeFile(path.join(cwd, "revision"), String(++revision));
    },
  });
  try {
    const p = (
      await f.core.planner.create({
        name: "Rework",
        repository: f.repo,
        startRef: "HEAD",
        features: [
          { key: "source", title: "Source", ticket: "Implement source" },
          {
            key: "next",
            title: "Next",
            ticket: "Use source",
            dependencies: ["source"],
            inheritFrom: "source",
          },
        ],
      })
    ).roadmap;
    f.core.planner.validate(p.id, 1);
    const applied = f.core.planner.apply(p.id, 1).roadmap;
    const source = applied.bindings.source.jobId,
      next = applied.bindings.next.jobId;
    const reviewed = async () => {
      for (
        let i = 0;
        i < 300 && f.store.get(source).status !== "READY_FOR_HUMAN_TEST";
        i++
      ) {
        await f.core.tick();
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(f.store.get(source).status, "READY_FOR_HUMAN_TEST");
    };
    await reviewed();
    const request = { id: source, target: "rework", expectedBase: f.base };
    const original = await f.core.integrate(request);
    assert.equal(original.status, "SUCCEEDED", original.failure ?? "");
    await f.core.action(source, "reject", "Revise the implementation");
    await reviewed();
    assert.notEqual(
      (await f.core.integration.snapshot(f.store.get(source))).tree,
      original.snapshot!.tree,
    );
    await f.core.action(source, "approve");
    await f.core.tick();
    f.core.planner.reconcileAll();
    assert.equal(f.store.get(next).schedulingState, "WAITING");
    assert.equal(f.store.get(next).worktree, null);
    assert.notEqual(f.store.get(next).startRef, original.resultCommit);
    assert.match(
      f.core.planner.summary(p.id).integrationWaits[0].reason!,
      /current sealed accepted review/,
    );
    await assert.rejects(f.core.integrate(request), /review changed/);
    await f.core.stop();
    const integration = f.reopen();
    const { Planner } = await import("../src/planner.js");
    const planner = new Planner(f.store, f.workspace, integration);
    await integration.recover();
    planner.reconcileAll();
    planner.reconcileAll();
    assert.equal(f.store.get(next).schedulingState, "WAITING");
    assert.equal(f.store.get(next).metadata.integrationId, null);
    assert.equal(planner.summary(p.id).nextRunnable.length, 0);
    assert.match(
      planner.read(p.id).features[1].reason!,
      /explicitly integrate/,
    );
    assert.equal(
      await git(f.repo, ["rev-parse", original.ref]),
      original.resultCommit,
    );
  } finally {
    await f.cleanup();
  }
});
