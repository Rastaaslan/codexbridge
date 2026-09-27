import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { Store } from "../src/database.js";
import { GitWorkspace, git } from "../src/git.js";
import { configSchema } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
test("hard process kill retains SQLite WAL, worktree, thread and recovery diagnosis", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codexbridge-crash-")),
    repo = path.join(dir, "repo"),
    dataDir = path.join(dir, "state");
  await mkdir(repo);
  await mkdir(dataDir);
  await git(repo, ["init"]);
  await git(repo, ["config", "user.name", "test"]);
  await git(repo, ["config", "user.email", "test@example.invalid"]);
  await writeFile(path.join(repo, "add.js"), "export const add=(a,b)=>a+b+1");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "fixture"]);
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "tests/recovery-child.ts", dataDir, repo],
    {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(Error("child timeout"));
    }, 20000);
    child.stdout.on("data", (data) => {
      if (data.toString().includes("READY")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code) reject(Error("child exited " + code));
    });
  });
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  child.kill("SIGKILL");
  await exited;
  const config = configSchema.parse({
      dataDir,
      repositoryRoots: [repo],
      token: "r".repeat(64),
    }),
    store = new Store(path.join(dataDir, "codexbridge.db"));
  const core = new Orchestrator(
    config,
    store,
    new GitWorkspace(config),
    {
      async run() {
        throw Error("must not rerun silently");
      },
    },
    {
      async review() {
        throw Error("must not review silently");
      },
    },
  );
  try {
    assert.equal(store.get("CB-1").status, "CODEX_RUNNING");
    await core.recover();
    const job = store.get("CB-1");
    assert.equal(job.status, "FAILED");
    assert.equal(job.codexThreadId, "persisted-before-kill");
    assert.equal(job.iteration, 1);
    assert.match(job.blocker!, /Worktree intact/);
    assert.ok(store.events(job.id).some((e) => e.type === "RECOVERY"));
    const worktrees = await git(repo, ["worktree", "list", "--porcelain"]);
    assert.equal(worktrees.split("worktree ").length - 1, 2);
  } finally {
    await core.stop();
    store.close();
  }
});
