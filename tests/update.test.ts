import { test } from "node:test";
import assert from "node:assert/strict";
import {
  transaction,
  recover,
  verifyRecovery,
  validateRef,
  atomicJson,
} from "../scripts/self-update.mjs";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function fixture(fail = "") {
  const events: string[] = [];
  let current = "old",
    maintenance = false;
  let state: any;
  const driver = {
    save: async (s: any) => {
      state = structuredClone(s);
      events.push("save:" + s.phase);
    },
    hold: async () => {
      maintenance = true;
      events.push("hold");
    },
    current: async () => current,
    build: async (ref: string) => {
      events.push("build:" + ref);
      if (fail === "build") throw Error("build failed");
      return "new";
    },
    quiesce: async () => {
      maintenance = true;
      events.push("quiesce");
      if (fail === "busy") throw Error("busy");
    },
    activate: async (release: string) => {
      events.push("activate:" + release);
      if (fail === "activate" && release === "new")
        throw Error("switch failed");
      current = release;
    },
    restart: async () => {
      events.push("restart:" + current);
      if (fail === "restart" && current === "new")
        throw Error("restart failed");
    },
    health: async (release: string) => {
      events.push("health:" + release);
      if ((fail === "health" && release === "new") || fail === "rollback")
        throw Error("unhealthy");
    },
    resume: async () => {
      maintenance = false;
      events.push("resume");
    },
  };
  return {
    driver,
    events,
    get current() {
      return current;
    },
    get maintenance() {
      return maintenance;
    },
    get state() {
      return state;
    },
  };
}
test("update prepares, journals, switches, restarts, checks health, then resumes", async () => {
  const f = fixture();
  await transaction(f.driver, "refs/tags/v2");
  assert.deepEqual(f.events, [
    "save:building",
    "build:refs/tags/v2",
    "save:prepared",
    "quiesce",
    "save:activating",
    "activate:new",
    "restart:new",
    "health:new",
    "save:completed",
    "resume",
  ]);
  assert.equal(f.current, "new");
  assert.equal(f.maintenance, false);
});
for (const stage of [
  "build",
  "busy",
  "activate",
  "restart",
  "health",
  "rollback",
])
  test(`update failure at ${stage} preserves old release or retains maintenance on failed rollback`, async () => {
    const f = fixture(stage);
    await assert.rejects(() => transaction(f.driver, "main"));
    assert.equal(f.current, "old");
    if (["build", "busy"].includes(stage)) {
      assert.equal(
        f.events.some((e) => e.startsWith("activate:")),
        false,
      );
      assert.equal(f.state.phase, "failed");
    } else {
      assert.ok(f.events.includes("activate:old"));
      assert.equal(
        f.state.phase,
        stage === "rollback" ? "rollback_failed" : "rolled_back",
      );
    }
    assert.equal(f.maintenance, stage === "rollback");
  });
for (const phase of [
  "building",
  "prepared",
  "activating",
  "rollback_failed",
  "completed",
])
  test(`restart recovers durable ${phase} state`, async () => {
    const f = fixture();
    await recover(f.driver, { phase, previous: "old", candidate: "new" });
    assert.equal(f.current, "old");
    assert.equal(f.maintenance, false);
    assert.equal(
      f.events.includes("health:old"),
      ["activating", "rollback_failed"].includes(phase),
    );
  });
test("boot recovery restores symlink before service starts without requesting a restart dependency cycle", async () => {
  const f = fixture();
  await recover(f.driver, { phase: "activating", previous: "old" }, true);
  assert.ok(f.events.includes("activate:old"));
  assert.equal(f.maintenance, true);
  assert.equal(f.state.phase, "boot_pending_health");
  assert.equal(f.events.includes("resume"), false);
  assert.equal(
    f.events.some((e) => e.startsWith("restart:")),
    false,
  );
});
test("update rejects options, controls and refspecs before side effects", async () => {
  for (const ref of ["", "--help", "main:other", "main\n", "../bad", null]) {
    const f = fixture();
    await assert.rejects(() => transaction(f.driver, ref));
    assert.deepEqual(f.events, []);
  }
  for (const ref of [
    "main",
    "feature/a,b",
    "main;id",
    "refs/tags/v1.0",
    "a".repeat(40),
    "HEAD~1",
  ])
    assert.equal(validateRef(ref), ref);
});
test("durable update journal changes never alter runtime DB, credentials or job worktrees", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cb-update-"));
  await mkdir(path.join(dir, "worktrees"));
  const sentinels = ["codexbridge.db", "config.json", "worktrees/job.txt"];
  for (const file of sentinels)
    await writeFile(path.join(dir, file), "preserve:" + file);
  await atomicJson(path.join(dir, "update-status.json"), {
    phase: "activating",
    previous: "old",
  });
  await atomicJson(path.join(dir, "update-status.json"), {
    phase: "rolled_back",
    previous: "old",
  });
  assert.equal(
    JSON.parse(await readFile(path.join(dir, "update-status.json"), "utf8"))
      .phase,
    "rolled_back",
  );
  for (const file of sentinels)
    assert.equal(
      await readFile(path.join(dir, file), "utf8"),
      "preserve:" + file,
    );
});

test("real fetch pins the requested tag and validates isolated candidate before activation", async () => {
  const { makeDriver } = await import("../scripts/self-update.mjs");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execute = promisify(execFile);
  const dir = await mkdtemp(path.join(os.tmpdir(), "cb-real-update-"));
  const repo = path.join(dir, "upstream"),
    root = path.join(dir, "installation"),
    data = path.join(dir, "runtime");
  await mkdir(path.join(repo, "deploy", "debian"), { recursive: true });
  await mkdir(root);
  await mkdir(data);
  const git = (args: string[]) =>
    execute("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: repo,
      windowsHide: true,
    });
  await git(["init"]);
  await git(["config", "user.name", "Test"]);
  await git(["config", "user.email", "test@example.invalid"]);
  await writeFile(
    path.join(repo, "deploy/debian/release-policy.json"),
    '{"runtimeSchema":1}',
  );
  await writeFile(path.join(repo, "version.txt"), "old");
  await git(["add", "."]);
  await git(["commit", "-m", "old"]);
  const commit = (await git(["rev-parse", "HEAD"])).stdout.trim();
  await git(["branch", "feature/a,b"]);
  await writeFile(path.join(repo, "version.txt"), "new");
  await git(["commit", "-am", "new"]);
  await writeFile(path.join(data, "codexbridge.db"), "runtime sentinel");
  const validation: string[][] = [];
  const driver = await makeDriver(
    root,
    data,
    { repository: repo },
    async (command: string, args: string[], options: any) => {
      if (command !== "npm") return execute(command, args, options);
      validation.push(args);
      assert.equal(options.env.CODEXBRIDGE_TOKEN, undefined);
      assert.equal(options.env.CONTROL_PLANE_API_KEY, undefined);
      assert.notEqual(options.env.CODEXBRIDGE_HOME, data);
      assert.equal(options.env.HOME, path.join(options.cwd, ".validation"));
      return { stdout: "validation fixture", stderr: "" };
    },
  );
  const candidate = await driver.build("refs/heads/feature/a,b");
  assert.equal(
    await readFile(path.join(candidate, "version.txt"), "utf8"),
    "old",
  );
  assert.equal(
    JSON.parse(await readFile(path.join(candidate, "release.json"), "utf8"))
      .commit,
    commit,
  );
  assert.deepEqual(
    validation.map((a) => a.slice(0, 2)),
    [["ci", "--ignore-scripts"], ["run", "build"], ["test"]],
  );
  assert.equal(
    await readFile(path.join(data, "codexbridge.db"), "utf8"),
    "runtime sentinel",
  );
  await assert.rejects(() => driver.build("not-a-real-ref"));
  assert.equal(validation.length, 3);
});
