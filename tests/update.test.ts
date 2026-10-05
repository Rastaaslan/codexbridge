import { test } from "node:test";
import assert from "node:assert/strict";
import {
  transaction,
  recover,
  verifyRecovery,
  validateRef,
  atomicJson,
} from "../scripts/self-update.mjs";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  symlink,
  realpath,
} from "node:fs/promises";
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
    validateRollback: async () => {
      events.push("validateRollback");
      if (fail === "baseline") throw Error("Incompatible rollback baseline");
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
  const recoveryDriver = { ...driver, restore: driver.activate };
  return {
    driver: recoveryDriver,
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
    "validateRollback",
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
  "baseline",
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
    if (["build", "baseline", "busy"].includes(stage)) {
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
    '{"runtimeSchema":1,"sqliteSchema":4,"minimumUpdaterVersion":1}',
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
    JSON.parse(await readFile(path.join(candidate, "release.json"), "utf8")),
    { commit, runtimeSchema: 1, sqliteSchema: 4, minimumUpdaterVersion: 1 },
  );
  assert.deepEqual(
    validation.map((a) => a.slice(0, 2)),
    [["ci", "--ignore-scripts"], ["run", "build"], ["test"]],
  );
  assert.equal(
    await readFile(path.join(data, "codexbridge.db"), "utf8"),
    "runtime sentinel",
  );
  await driver.validateRollback(candidate, candidate);
  const previous = path.join(root, "releases", "legacy");
  await execute("git", ["clone", candidate, previous]);
  const previousGit = (args: string[]) =>
    execute("git", ["-C", previous, ...args]);
  await writeFile(
    path.join(previous, "deploy/debian/release-policy.json"),
    '{"runtimeSchema":1,"sqliteSchema":3}',
  );
  await previousGit(["add", "."]);
  await previousGit([
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "legacy schema",
  ]);
  await writeFile(
    path.join(previous, "release.json"),
    JSON.stringify({
      commit: (await previousGit(["rev-parse", "HEAD"])).stdout.trim(),
      runtimeSchema: 1,
      sqliteSchema: 4,
    }),
  );
  await symlink(previous, path.join(root, "current"));
  await assert.rejects(
    () => driver.validateRollback(previous, candidate),
    /schema-v4 rollback baseline/,
  );
  await assert.rejects(
    () => driver.activate(candidate),
    /schema-v4 rollback baseline/,
  );
  assert.equal(await realpath(path.join(root, "current")), previous);
  // Merely editing the policy cannot fabricate a compatible committed baseline.
  await writeFile(
    path.join(previous, "deploy/debian/release-policy.json"),
    '{"runtimeSchema":1,"sqliteSchema":4,"minimumUpdaterVersion":1}',
  );
  await assert.rejects(
    () => driver.validateRollback(previous, candidate),
    /schema-v4 rollback baseline/,
  );
  await writeFile(
    path.join(candidate, "release.json"),
    JSON.stringify({ commit: "0".repeat(40) }),
  );
  await assert.rejects(
    () => driver.activate(candidate),
    /schema-v4 rollback baseline/,
  );
  assert.equal(await realpath(path.join(root, "current")), previous);
  assert.equal(
    await readFile(path.join(data, "codexbridge.db"), "utf8"),
    "runtime sentinel",
  );
  await assert.rejects(() => driver.build("not-a-real-ref"));
  assert.equal(validation.length, 3);
  for (const minimumUpdaterVersion of [3, undefined, 0, "1", null]) {
    await writeFile(
      path.join(repo, "deploy/debian/release-policy.json"),
      JSON.stringify({
        runtimeSchema: 1,
        sqliteSchema: 4,
        minimumUpdaterVersion,
      }),
    );
    await git(["commit", "-am", "unsupported updater requirement"]);
    await assert.rejects(driver.build("HEAD"), /updater|minimumUpdaterVersion/);
    assert.equal(validation.length, 3, "reject before npm validation");
    assert.equal(await realpath(path.join(root, "current")), previous);
  }
});

// Real Git policies and real filesystem activation; only service operations are stubbed.
const idleStatus = {
  health: { orchestratorOk: true, maintenance: true },
  scheduler: { runningJobs: 0, usedCapacity: 0 },
  integrations: {},
  activeIntegrationOperations: 0,
};

async function compatibilityFixture(
  request = async () => Response.json(idleStatus),
) {
  const { makeDriver } = await import("../scripts/self-update.mjs");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execute = promisify(execFile);
  const dir = await mkdtemp(path.join(os.tmpdir(), "cb-compat-"));
  const root = path.join(dir, "installation"),
    data = path.join(dir, "data");
  await mkdir(data);
  const policy = {
    runtimeSchema: 1,
    sqliteSchema: 4,
    minimumUpdaterVersion: 1,
  };
  const git = async (cwd: string, args: string[]) =>
    (
      await execute(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          ...args,
        ],
        { cwd },
      )
    ).stdout.trim();
  const manifest = async (release: string, fields = policy) =>
    writeFile(
      path.join(release, "release.json"),
      JSON.stringify({
        commit: await git(release, ["rev-parse", "HEAD"]),
        ...fields,
      }),
    );
  const commitPolicy = async (release: string, fields: object) => {
    await writeFile(
      path.join(release, "deploy/debian/release-policy.json"),
      JSON.stringify(fields),
    );
    await git(release, ["add", "deploy/debian/release-policy.json"]);
    await git(release, ["commit", "--allow-empty", "-m", "fixture policy"]);
    await manifest(release);
  };
  const old = path.join(root, "releases", "old"),
    candidate = path.join(root, "releases", "candidate");
  for (const release of [old, candidate]) {
    await mkdir(path.join(release, "deploy/debian"), { recursive: true });
    await git(release, ["init"]);
    await commitPolicy(release, policy);
  }
  const current = path.join(root, "current"),
    maintenance = path.join(data, "maintenance.json");
  await symlink(old, current);
  await writeFile(path.join(data, "codexbridge.db"), "untouched database");
  await writeFile(
    path.join(data, "config.json"),
    JSON.stringify({ token: "fixture" }),
  );
  const driver = await makeDriver(root, data, {}, undefined, request);
  driver.build = async () => candidate;
  driver.restart = async () => {};
  driver.health = async () => ({ orchestratorOk: true });
  return {
    dir,
    root,
    data,
    old,
    candidate,
    current,
    maintenance,
    driver,
    policy,
    git,
    manifest,
    commitPolicy,
  };
}

test("quiescence rejects active work and untrusted evidence before activation", async () => {
  let response: () => Promise<Response> = async () => Response.json(idleStatus);
  const f = await compatibilityFixture(async () => response());
  const { rm, access } = await import("node:fs/promises");
  let activations = 0,
    restarts = 0;
  f.driver.activate = async () => {
    activations++;
  };
  f.driver.restart = async () => {
    restarts++;
  };
  try {
    const statuses = [
      ...[undefined, null, "0", -1, 0.5, 1].map(
        (activeIntegrationOperations) => ({
          ...idleStatus,
          activeIntegrationOperations,
        }),
      ),
      { ...idleStatus, scheduler: { runningJobs: 1, usedCapacity: 0 } },
      { ...idleStatus, scheduler: { runningJobs: 0, usedCapacity: 1 } },
      ...["VERIFYING", "PUBLISHING"].map((state) => ({
        ...idleStatus,
        integrations: { [state]: 1 },
      })),
      null,
      {},
      { counts: { running: 0 } },
      ...[undefined, null, "0", -1, 0.5].map((runningJobs) => ({
        ...idleStatus,
        scheduler: { runningJobs, usedCapacity: 0 },
      })),
      ...[
        undefined,
        null,
        [],
        { VERIFYING: "0" },
        { PUBLISHING: -1 },
        { UNKNOWN: 0 },
      ].map((integrations) => ({ ...idleStatus, integrations })),
      { ...idleStatus, health: { orchestratorOk: true, maintenance: false } },
      { ...idleStatus, health: { orchestratorOk: "true", maintenance: true } },
    ];
    for (const status of statuses) {
      response = async () => Response.json(status);
      await assert.rejects(transaction(f.driver, "HEAD"), /update refused/);
      assert.equal(await realpath(f.current), f.old);
      await assert.rejects(access(f.maintenance));
    }
    for (const unavailable of [
      async () => {
        throw Error("connection unavailable");
      },
      async () => new Response("unavailable", { status: 503 }),
      async () => new Response("not JSON"),
    ]) {
      response = unavailable;
      await assert.rejects(transaction(f.driver, "HEAD"));
      assert.equal(await realpath(f.current), f.old);
      await assert.rejects(access(f.maintenance));
    }
    assert.equal(activations, 0);
    assert.equal(restarts, 0);
    response = async () =>
      Response.json({
        ...idleStatus,
        integrations: { SUCCEEDED: 2, FAILED: 1 },
      });
    await transaction(f.driver, "HEAD");
    assert.equal(activations, 1);
    assert.equal(restarts, 1);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("v4 compatibility rejects every metadata mismatch on either side before activation", async () => {
  const f = await compatibilityFixture();
  const { rm, access } = await import("node:fs/promises");
  let quiesces = 0,
    activations = 0;
  const quiesce = f.driver.quiesce,
    activate = f.driver.activate;
  f.driver.quiesce = async () => {
    quiesces++;
    await quiesce();
  };
  f.driver.activate = async (release: string) => {
    activations++;
    await activate(release);
  };
  try {
    for (const release of [f.old, f.candidate]) {
      for (const source of ["manifest", "policy", "committedPolicy"]) {
        for (const fields of [
          { runtimeSchema: 99, sqliteSchema: 4 },
          { runtimeSchema: 1, sqliteSchema: 1 },
          { runtimeSchema: 1 },
          { sqliteSchema: 4 },
          { runtimeSchema: 1, sqliteSchema: "4" },
          { runtimeSchema: "1", sqliteSchema: 4 },
        ]) {
          const policyFile = path.join(
            release,
            "deploy/debian/release-policy.json",
          );
          if (source === "manifest")
            await writeFile(
              path.join(release, "release.json"),
              JSON.stringify({
                commit: await f.git(release, ["rev-parse", "HEAD"]),
                ...fields,
              }),
            );
          else {
            if (source === "committedPolicy")
              await f.commitPolicy(release, fields);
            await writeFile(
              policyFile,
              JSON.stringify(source === "committedPolicy" ? f.policy : fields),
            );
          }
          await assert.rejects(
            f.driver.validateRollback(f.old, f.candidate),
            /schema-v4/,
          );
          await assert.rejects(f.driver.activate(f.candidate), /schema-v4/);
          const before = activations;
          await assert.rejects(transaction(f.driver, "main"), /schema-v4/);
          assert.equal(quiesces, 0);
          assert.equal(activations, before);
          assert.equal(await realpath(f.current), f.old);
          await assert.rejects(access(f.current + ".next"));
          await assert.rejects(access(f.maintenance));
          await f.commitPolicy(release, f.policy);
        }
      }
      await writeFile(
        path.join(release, "release.json"),
        JSON.stringify({ commit: "0".repeat(40), ...f.policy }),
      );
      await assert.rejects(
        f.driver.validateRollback(f.old, f.candidate),
        /schema-v4/,
      );
      await assert.rejects(f.driver.activate(f.candidate), /schema-v4/);
      await f.manifest(release);
      await f.git(release, ["commit", "--allow-empty", "-m", "HEAD drift"]);
      await assert.rejects(
        f.driver.validateRollback(f.old, f.candidate),
        /schema-v4/,
      );
      await f.manifest(release);
    }
    assert.equal((await transaction(f.driver, "main")).phase, "completed");
    assert.equal(await realpath(f.current), f.candidate);
    assert.equal(
      await readFile(path.join(f.data, "codexbridge.db"), "utf8"),
      "untouched database",
    );
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

for (const boot of [false, true])
  test(`damaged outgoing manifest does not prevent validated v4 restoration (boot=${boot})`, async () => {
    const f = await compatibilityFixture();
    const { rm, access } = await import("node:fs/promises");
    try {
      if (boot) {
        await f.driver.activate(f.candidate);
        await writeFile(path.join(f.candidate, "release.json"), "corrupt");
        await recover(
          f.driver,
          { phase: "activating", previous: f.old, candidate: f.candidate },
          true,
        );
        assert.equal(
          JSON.parse(
            await readFile(path.join(f.data, "update-status.json"), "utf8"),
          ).phase,
          "boot_pending_health",
        );
        await access(f.maintenance);
        await verifyRecovery(
          f.driver,
          JSON.parse(
            await readFile(path.join(f.data, "update-status.json"), "utf8"),
          ),
        );
      } else {
        f.driver.health = async (release: string) => {
          if (release === f.candidate) {
            await writeFile(path.join(release, "release.json"), "corrupt");
            throw Error("candidate unhealthy");
          }
          return { orchestratorOk: true };
        };
        await assert.rejects(
          transaction(f.driver, "main"),
          /candidate unhealthy/,
        );
      }
      assert.equal(await realpath(f.current), f.old);
      assert.equal(
        JSON.parse(
          await readFile(path.join(f.data, "update-status.json"), "utf8"),
        ).phase,
        "rolled_back",
      );
      await assert.rejects(access(f.maintenance));
      await assert.rejects(f.driver.restore(f.candidate));
      assert.equal(await realpath(f.current), f.old);
      await writeFile(path.join(f.old, "release.json"), "corrupt target");
      await assert.rejects(f.driver.restore(f.old));
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

test("preparation rejection, occupied maintenance and startup cleanup preserve another operation's marker", async () => {
  const f = await compatibilityFixture();
  const { rm } = await import("node:fs/promises");
  try {
    const sentinel = JSON.stringify({
      reason: "operator maintenance",
      detail: "preserve bytes",
    });
    await writeFile(f.maintenance, sentinel);
    await f.commitPolicy(f.old, { runtimeSchema: 1 });
    await assert.rejects(transaction(f.driver, "main"), /maintenance/);
    assert.equal(await readFile(f.maintenance, "utf8"), sentinel);
    await f.commitPolicy(f.old, f.policy);
    await assert.rejects(transaction(f.driver, "main"), /maintenance/);
    assert.equal(await readFile(f.maintenance, "utf8"), sentinel);
    await recover(f.driver, { phase: "prepared" });
    await recover(f.driver, undefined);
    assert.equal(await readFile(f.maintenance, "utf8"), sentinel);
    await assert.rejects(
      recover(f.driver, { phase: "activating", previous: f.old }, true),
      /another operation/,
    );
    assert.equal(await readFile(f.maintenance, "utf8"), sentinel);
    assert.equal(await realpath(f.current), f.old);
    await writeFile(f.maintenance, JSON.stringify({ reason: "self-update" }));
    await recover(f.driver, { phase: "prepared" });
    await assert.rejects(readFile(f.maintenance), { code: "ENOENT" });
    await f.driver.quiesce();
    await writeFile(f.maintenance, sentinel);
    await f.driver.resume();
    assert.equal(await readFile(f.maintenance, "utf8"), sentinel);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

for (const fault of [
  "write-failure",
  "partial-write",
  "before-link",
  "after-link",
  "directory-sync",
]) {
  test(`maintenance acquisition survives ${fault} with a fresh recovery driver`, async () => {
    const f = await compatibilityFixture();
    const { rm, readdir } = await import("node:fs/promises");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { makeDriver } = await import("../scripts/self-update.mjs");
    // Exit the child during publication so finally blocks cannot mask crash behavior.
    const script = `
      import * as fs from 'node:fs/promises';
      import { makeDriver } from ${JSON.stringify(new URL("../scripts/self-update.mjs", import.meta.url).href)};
      const fault = ${JSON.stringify(fault)};
      const io = {
        ...fs,
        async open(file, flags, mode) {
          const h = await fs.open(file, flags, mode);
          return {
            async writeFile(bytes) {
              await h.writeFile(bytes.slice(0, 10));
              if (fault === 'partial-write') process.exit(73);
              if (fault === 'write-failure') throw Error('injected write failure');
              await h.writeFile(bytes.slice(10));
            },
            async sync() {
              if (flags === 'r' && fault === 'directory-sync') throw Error('injected directory sync failure');
              await h.sync();
            },
            close: () => h.close(),
          };
        },
        async link(from, to) {
          if (fault === 'before-link') process.exit(73);
          await fs.link(from, to);
          if (fault === 'after-link') process.exit(73);
        },
      };
      const driver = await makeDriver(${JSON.stringify(f.root)}, ${JSON.stringify(f.data)}, {}, undefined,
        async () => Response.json(${JSON.stringify(idleStatus)}), io);
      try { await driver.quiesce(); process.exit(74); }
      catch (e) {
        if (!e.message.startsWith('injected')) throw e;
        process.exit(73);
      }
    `;
    try {
      await assert.rejects(
        promisify(execFile)(process.execPath, [
          "--input-type=module",
          "-e",
          script,
        ]),
        (error: any) => error.code === 73,
      );
      const published = fault === "after-link" || fault === "directory-sync";
      if (published) {
        const marker = JSON.parse(await readFile(f.maintenance, "utf8"));
        assert.equal(marker.owner, "codexbridge-update");
        assert.equal(marker.reason, "self-update");
        assert.ok(marker.id);
      } else await assert.rejects(readFile(f.maintenance), { code: "ENOENT" });
      if (fault === "write-failure" || fault === "directory-sync")
        assert.equal(
          (await readdir(f.data)).some((name) => name.endsWith(".tmp")),
          false,
        );
      // Fresh startup cleans unpublished acquisitions; boot recovery adopts any
      // complete marker left by a crash without relying on in-memory ownership.
      const fresh = () => makeDriver(f.root, f.data, {});
      if (!published) {
        await recover(await fresh(), { phase: "prepared" });
        await assert.rejects(readFile(f.maintenance), { code: "ENOENT" });
      }
      await recover(
        await fresh(),
        { phase: "activating", previous: f.old },
        true,
      );
      assert.equal(
        JSON.parse(await readFile(f.maintenance, "utf8")).reason,
        published ? "self-update" : "recovery awaiting health",
      );
      const verifier = await fresh();
      verifier.health = async () => ({ orchestratorOk: true });
      await verifyRecovery(verifier, {
        phase: "boot_pending_health",
        previous: f.old,
      });
      await assert.rejects(readFile(f.maintenance), { code: "ENOENT" });
      assert.equal(await realpath(f.current), f.old);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
}

test("concurrent maintenance publication has exactly one owner and never replaces bytes", async () => {
  const { publishMaintenance } = await import("../scripts/self-update.mjs");
  const { rm, readdir } = await import("node:fs/promises");
  const dir = await mkdtemp(path.join(os.tmpdir(), "cb-marker-"));
  const file = path.join(dir, "maintenance.json");
  const markers = Array.from({ length: 8 }, (_, id) => JSON.stringify({ id }));
  try {
    const results = await Promise.allSettled(
      markers.map((marker) => publishMaintenance(file, marker)),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    for (const result of results)
      if (result.status === "rejected")
        assert.equal(result.reason.code, "EEXIST");
    assert.equal(
      await readFile(file, "utf8"),
      markers[results.findIndex((r) => r.status === "fulfilled")],
    );
    assert.deepEqual(await readdir(dir), ["maintenance.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("updater contract rejects unsupported, invalid and inconsistent metadata before activation or recovery", async () => {
  const f = await compatibilityFixture();
  const { rm, access } = await import("node:fs/promises");
  let quiesces = 0;
  f.driver.quiesce = async () => {
    quiesces++;
  };
  try {
    for (const release of [f.old, f.candidate]) {
      for (const source of ["manifest", "policy", "committedPolicy"]) {
        for (const required of [3, 0, -1, 1.5, "1", null, undefined]) {
          const fields = { ...f.policy, minimumUpdaterVersion: required };
          if (source === "committedPolicy")
            await f.commitPolicy(release, fields);
          const file = path.join(
            release,
            source === "manifest"
              ? "release.json"
              : "deploy/debian/release-policy.json",
          );
          await writeFile(
            file,
            JSON.stringify(
              source === "manifest"
                ? {
                    commit: await f.git(release, ["rev-parse", "HEAD"]),
                    ...fields,
                  }
                : source === "committedPolicy"
                  ? f.policy
                  : fields,
            ),
          );
          await assert.rejects(
            transaction(f.driver, "main"),
            /updater|Updater/,
          );
          await assert.rejects(
            f.driver.activate(f.candidate),
            /updater|Updater/,
          );
          await assert.rejects(f.driver.restore(release), /updater|Updater/);
          assert.equal(await realpath(f.current), f.old);
          await assert.rejects(access(f.current + ".next"));
          await assert.rejects(access(f.maintenance));
          await f.commitPolicy(release, f.policy);
        }
      }
    }
    assert.equal(quiesces, 0);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("legacy schema-v4 baseline remains recoverable but new candidates require an explicit updater contract", async () => {
  const f = await compatibilityFixture();
  const { rm } = await import("node:fs/promises");
  try {
    const legacy = { runtimeSchema: 1, sqliteSchema: 4 };
    await f.commitPolicy(f.old, legacy);
    await f.manifest(f.old, legacy);
    assert.equal((await transaction(f.driver, "main")).phase, "completed");
    await recover(f.driver, { phase: "activating", previous: f.old }, true);
    assert.equal(await realpath(f.current), f.old);
    await f.commitPolicy(f.candidate, legacy);
    await f.manifest(f.candidate, legacy);
    await assert.rejects(
      f.driver.validateRollback(f.old, f.candidate),
      /minimumUpdaterVersion/,
    );
    await assert.rejects(
      f.driver.activate(f.candidate),
      /minimumUpdaterVersion/,
    );
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("repository release policy is supported by its matching updater", async () => {
  const { validateUpdater, UPDATER_VERSION } =
    await import("../scripts/self-update.mjs");
  const policy = JSON.parse(
    await readFile(
      new URL("../deploy/debian/release-policy.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(validateUpdater(policy), UPDATER_VERSION);
});

// Counterexample for relaxing the schema gate: idle scheduling is not a cold DB.
test("v1 WAL state survives rejected activation; copying only the main DB loses committed state", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { Store } = await import("../src/database.js");
  const { copyFile, rm } = await import("node:fs/promises");
  const f = await compatibilityFixture();
  const file = path.join(f.data, "codexbridge.db");
  await rm(file);
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
      CREATE TABLE jobs (id TEXT PRIMARY KEY);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version=1; PRAGMA wal_checkpoint(TRUNCATE);`);
    db.prepare("INSERT INTO settings VALUES (?, ?)").run(
      "queued-state",
      "keep",
    );
    assert.ok((await readFile(file + "-wal")).length > 0);
    const copy = path.join(f.dir, "main-only.db");
    await copyFile(file, copy);
    const incomplete = new DatabaseSync(copy);
    try {
      assert.equal(
        incomplete.prepare("SELECT count(*) AS n FROM settings").get()!.n,
        0,
      );
      assert.equal(
        db.prepare("SELECT count(*) AS n FROM settings").get()!.n,
        1,
      );
    } finally {
      incomplete.close();
    }
    const legacy = { runtimeSchema: 1, sqliteSchema: 1 };
    await f.commitPolicy(f.old, legacy);
    await f.manifest(f.old, legacy);
    await mkdir(path.join(f.data, "worktrees"));
    await writeFile(path.join(f.data, "worktrees/job.txt"), "unrelated job");
    const files = [
      "codexbridge.db",
      "codexbridge.db-wal",
      "codexbridge.db-shm",
      "config.json",
      "worktrees/job.txt",
    ];
    const before = await Promise.all(
      files.map((name) => readFile(path.join(f.data, name))),
    );
    let lifecycleCalls = 0;
    f.driver.quiesce = f.driver.restart = async () => {
      lifecycleCalls++;
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(
        transaction(f.driver, "main"),
        /snapshot|contract 2/i,
      );
      await assert.rejects(
        f.driver.activate(f.candidate),
        /snapshot|contract 2/i,
      );
      assert.equal(await realpath(f.current), f.old);
      for (const [index, name] of files.entries())
        assert.deepEqual(
          await readFile(path.join(f.data, name)),
          before[index],
        );
    }
    assert.equal(lifecycleCalls, 0);
    // In this disposable fixture only, demonstrate what opening the candidate
    // Store would do even with maintenance held, before any health check.
    await f.driver.hold();
    const migrated = new Store(file);
    try {
      assert.equal(
        migrated.db.prepare("PRAGMA user_version").get()!.user_version,
        4,
      );
      assert.equal(
        migrated.db.prepare("SELECT value FROM settings").get()!.value,
        "keep",
      );
      await assert.rejects(f.driver.restore(f.old), /snapshot|contract 2/i);
      assert.equal(
        migrated.db.prepare("PRAGMA user_version").get()!.user_version,
        4,
      );
      assert.equal(
        await realpath(f.current),
        f.old,
        "old code selection cannot undo migration",
      );
    } finally {
      migrated.close();
    }
  } finally {
    db.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

for (const phase of ["activating", "rollback_failed", "boot_pending_health"]) {
  test(`incompatible ${phase} recovery repeatedly fails closed without touching runtime state`, async () => {
    const { makeDriver } = await import("../scripts/self-update.mjs");
    const { rm, unlink } = await import("node:fs/promises");
    const f = await compatibilityFixture();
    try {
      const legacy = { runtimeSchema: 1, sqliteSchema: 1 };
      await f.commitPolicy(f.old, legacy);
      await f.manifest(f.old, legacy);
      // Model an inherited interrupted journal, never bypass the real gate.
      await unlink(f.current);
      await symlink(f.candidate, f.current);
      const state = { phase, previous: f.old, candidate: f.candidate };
      await f.driver.save(state);
      const journal = await readFile(path.join(f.data, "update-status.json"));
      for (const boot of [true, false, true]) {
        const fresh = await makeDriver(f.root, f.data, {}, async () => {
          throw Error("unexpected external command");
        });
        // Git validation uses disposable repositories; no lifecycle commands.
        fresh.restore = f.driver.restore;
        await assert.rejects(
          recover(fresh, state, boot),
          /snapshot|contract 2/i,
        );
        assert.equal(await realpath(f.current), f.candidate);
        assert.deepEqual(
          await readFile(path.join(f.data, "update-status.json")),
          journal,
        );
        assert.equal(
          await readFile(path.join(f.data, "codexbridge.db"), "utf8"),
          "untouched database",
        );
        assert.equal(
          JSON.parse(await readFile(f.maintenance, "utf8")).owner,
          "codexbridge-update",
        );
      }
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
}

test("restore failure retains maintenance and recovery health failure never resumes scheduling", async () => {
  const f = fixture("health");
  f.driver.restore = async () => {
    throw Error("injected restore failure");
  };
  await assert.rejects(transaction(f.driver, "main"), /Rollback failed/);
  assert.equal(f.state.phase, "rollback_failed");
  assert.equal(f.current, "new");
  assert.equal(f.maintenance, true);
  assert.equal(f.events.includes("resume"), false);
  const unhealthy = fixture("rollback");
  await recover(
    unhealthy.driver,
    { phase: "activating", previous: "old" },
    true,
  );
  await assert.rejects(
    verifyRecovery(unhealthy.driver, unhealthy.state),
    /unhealthy/,
  );
  assert.equal(unhealthy.state.phase, "rollback_failed");
  assert.equal(unhealthy.maintenance, true);
  assert.equal(unhealthy.events.includes("resume"), false);
});

async function coldFixture() {
  const f = await compatibilityFixture();
  const { rm } = await import("node:fs/promises");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await f.commitPolicy(f.old, { runtimeSchema: 1, sqliteSchema: 1 });
  await f.manifest(f.old, { runtimeSchema: 1, sqliteSchema: 1 } as any);
  const target = { ...f.policy, minimumUpdaterVersion: 2 };
  await f.commitPolicy(f.candidate, target);
  await f.manifest(f.candidate, target);
  const file = path.join(f.data, "codexbridge.db");
  await rm(file);
  // Process exit without SQLite close leaves committed data exclusively in WAL.
  await promisify(execFile)(process.execPath, [
    "--input-type=module",
    "-e",
    `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(${JSON.stringify(file)});
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE jobs (id TEXT PRIMARY KEY); CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); PRAGMA user_version=1; PRAGMA wal_checkpoint(TRUNCATE);');
    db.prepare('INSERT INTO settings VALUES (?, ?)').run('queued-state', 'keep');
    process.exit(0);
  `,
  ]);
  const names = ["codexbridge.db", "codexbridge.db-wal", "codexbridge.db-shm"];
  const before = await Promise.all(
    names.map((n) => readFile(path.join(f.data, n))),
  );
  assert.ok(before[1].length > 0);
  f.driver.stop = async () => {};
  return { ...f, file, names, before };
}

test("cold v1 WAL snapshot restores exact bytes after real Store migration and failed candidate health", async () => {
  const f = await coldFixture();
  const { Store } = await import("../src/database.js");
  const { DatabaseSync } = await import("node:sqlite");
  const { rm, access } = await import("node:fs/promises");
  const events: string[] = [];
  const config = await readFile(path.join(f.data, "config.json"));
  let previousHealthy = false;
  f.driver.stop = async () => {
    events.push("stopped");
  };
  const capture = f.driver.capture;
  f.driver.capture = async (state: any) => {
    assert.equal(events.at(-1), "stopped");
    events.push("capture");
    return capture(state);
  };
  f.driver.restart = async () => {
    const release = await realpath(f.current);
    if (release === f.candidate) {
      const migrated = new Store(f.file);
      assert.equal(
        migrated.db.prepare("PRAGMA user_version").get()!.user_version,
        4,
      );
      migrated.db
        .prepare("UPDATE settings SET value='candidate mutation'")
        .run();
      migrated.close();
    } else {
      for (const [i, name] of f.names.entries())
        assert.deepEqual(await readFile(path.join(f.data, name)), f.before[i]);
      const old = new DatabaseSync(f.file);
      assert.equal(old.prepare("PRAGMA user_version").get()!.user_version, 1);
      assert.equal(
        old.prepare("SELECT value FROM settings").get()!.value,
        "keep",
      );
      assert.equal(
        old
          .prepare(
            "SELECT count(*) AS n FROM sqlite_master WHERE name='roadmaps'",
          )
          .get()!.n,
        0,
      );
      old.close();
      previousHealthy = true;
    }
  };
  f.driver.health = async (release: string) => {
    if (release === f.candidate)
      throw Error("candidate unhealthy after migration");
    assert.ok(previousHealthy);
    return { orchestratorOk: true };
  };
  try {
    await assert.rejects(transaction(f.driver, "main"), /candidate unhealthy/);
    assert.equal(await realpath(f.current), f.old);
    assert.equal(
      JSON.parse(
        await readFile(path.join(f.data, "update-status.json"), "utf8"),
      ).phase,
      "rolled_back",
    );
    assert.deepEqual(await readFile(path.join(f.data, "config.json")), config);
    await assert.rejects(access(path.join(f.data, "rollback-snapshot")));
    await assert.rejects(access(f.maintenance));
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("successful v4 activation commits health before retiring snapshot", async () => {
  const f = await coldFixture();
  const { Store } = await import("../src/database.js");
  const { rm, access } = await import("node:fs/promises");
  f.driver.restart = async () => {
    new Store(f.file).close();
  };
  f.driver.health = async () => {
    await access(path.join(f.data, "rollback-snapshot", "manifest.json"));
    return { orchestratorOk: true };
  };
  try {
    await transaction(f.driver, "main");
    assert.equal(await realpath(f.current), f.candidate);
    await assert.rejects(access(path.join(f.data, "rollback-snapshot")));
    await assert.rejects(access(f.maintenance));
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

for (const corruption of [
  "missing",
  "manifest",
  "database",
  "wrong-id",
  "wrong-owner",
]) {
  test(`cold recovery fails closed on ${corruption} evidence`, async () => {
    const f = await coldFixture();
    const { rm } = await import("node:fs/promises");
    const { randomUUID } = await import("node:crypto");
    const state: any = {
      id: randomUUID(),
      cold: true,
      phase: "activating",
      previous: f.old,
      candidate: f.candidate,
    };
    try {
      await f.driver.save(state);
      await f.driver.quiesce();
      state.snapshotHash = await f.driver.capture(state);
      const dir = path.join(f.data, "rollback-snapshot");
      if (corruption === "missing") await rm(path.join(dir, "manifest.json"));
      if (corruption === "manifest")
        await writeFile(path.join(dir, "manifest.json"), "{}");
      if (corruption === "database")
        await writeFile(path.join(dir, "codexbridge.db"), "corrupt");
      if (corruption === "wrong-id") {
        state.id = randomUUID();
        // Matching maintenance must not let a different transaction borrow the
        // original manifest and its valid hash.
        await writeFile(
          f.maintenance,
          JSON.stringify({
            owner: "codexbridge-update",
            reason: "self-update",
            id: state.id,
          }),
        );
      }
      if (corruption === "wrong-owner")
        await writeFile(
          f.maintenance,
          JSON.stringify({
            owner: "codexbridge-update",
            reason: "self-update",
            id: randomUUID(),
          }),
        );
      let restarted = false;
      f.driver.restart = async () => {
        restarted = true;
      };
      await assert.rejects(
        recover(f.driver, state, true),
        /integrity|ENOENT|transaction|another operation/,
      );
      assert.equal(restarted, false);
      for (const [i, name] of f.names.entries())
        assert.deepEqual(await readFile(path.join(f.data, name)), f.before[i]);
      assert.ok(await readFile(f.maintenance));
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
}

for (const boundary of [
  "codexbridge.db",
  "codexbridge.db-wal",
  "codexbridge.db-shm",
]) {
  test(`process death after restoring ${boundary} is repeatable from immutable snapshot`, async () => {
    const f = await coldFixture();
    const { Store } = await import("../src/database.js");
    const { rm } = await import("node:fs/promises");
    const { randomUUID } = await import("node:crypto");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const state: any = {
      id: randomUUID(),
      cold: true,
      phase: "restoring",
      previous: f.old,
      candidate: f.candidate,
    };
    try {
      await f.driver.save(state);
      await f.driver.quiesce();
      state.snapshotHash = await f.driver.capture(state);
      new Store(f.file).close();
      await f.driver.save(state);
      await assert.rejects(
        promisify(execFile)(process.execPath, [
          "--input-type=module",
          "-e",
          `
        import { restoreSnapshot } from ${JSON.stringify(new URL("../scripts/self-update.mjs", import.meta.url).href)};
        await restoreSnapshot(${JSON.stringify(f.data)}, ${JSON.stringify(state)}, undefined,
          async name => { if (name === ${JSON.stringify(boundary)}) process.exit(73); });
      `,
        ]),
        (e: any) => e.code === 73,
      );
      await recover(f.driver, state, true);
      for (const [i, name] of f.names.entries())
        assert.deepEqual(await readFile(path.join(f.data, name)), f.before[i]);
      const pending = JSON.parse(
        await readFile(path.join(f.data, "update-status.json"), "utf8"),
      );
      assert.equal(pending.phase, "boot_pending_health");
      await verifyRecovery(f.driver, pending);
      await assert.rejects(readFile(f.maintenance));
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
}

for (const fault of [
  "before-owner",
  "owner-synced",
  "owner-published",
  "snapshotting",
  "files-synced",
  "manifest-synced",
  "activating",
  "switched",
  "migrated",
  "completed",
]) {
  test(`cold transaction recovers process death at ${fault}`, async () => {
    const f = await coldFixture();
    const { rm } = await import("node:fs/promises");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { DatabaseSync } = await import("node:sqlite");
    const script = `
      import { makeDriver, transaction, captureSnapshot } from ${JSON.stringify(new URL("../scripts/self-update.mjs", import.meta.url).href)};
      import { readFile } from 'node:fs/promises';
      import { DatabaseSync } from 'node:sqlite';
      const fault = ${JSON.stringify(fault)};
      const die = name => { if (name === fault) process.exit(73); };
      const d = await makeDriver(${JSON.stringify(f.root)}, ${JSON.stringify(f.data)}, {}, undefined,
        async () => Response.json(${JSON.stringify(idleStatus)}));
      d.build = async () => ${JSON.stringify(f.candidate)};
      d.stop = async () => {};
      const save = d.save, activate = d.activate;
      d.save = async s => { await save(s); die(s.phase); };
      d.capture = async s => captureSnapshot(${JSON.stringify(f.data)}, s,
        JSON.parse(await readFile(${JSON.stringify(path.join(f.old, "release.json"))}, 'utf8')), async name => die(name));
      d.activate = async (...args) => { await activate(...args); die('switched'); };
      d.restart = async () => {
        const db = new DatabaseSync(${JSON.stringify(f.file)});
        db.exec("PRAGMA user_version=4; UPDATE settings SET value='migrated';"); db.close(); die('migrated');
      };
      d.health = async () => ({ orchestratorOk: true });
      await transaction(d, 'main');
    `;
    try {
      await assert.rejects(
        promisify(execFile)(process.execPath, [
          "--input-type=module",
          "-e",
          script,
        ]),
        (e: any) => e.code === 73,
      );
      const state = JSON.parse(
        await readFile(path.join(f.data, "update-status.json"), "utf8"),
      );
      const { makeDriver } = await import("../scripts/self-update.mjs");
      const fresh = await makeDriver(f.root, f.data, {});
      fresh.stop = async () => {};
      fresh.health = async () => ({ orchestratorOk: true });
      await recover(fresh, state, true);
      const recovered = JSON.parse(
        await readFile(path.join(f.data, "update-status.json"), "utf8"),
      );
      if (fault !== "completed") {
        assert.equal(recovered.phase, "boot_pending_health");
        assert.equal(await realpath(f.current), f.old);
        await verifyRecovery(fresh, recovered);
      }
      const db = new DatabaseSync(f.file);
      assert.equal(
        db.prepare("PRAGMA user_version").get()!.user_version,
        fault === "completed" ? 4 : 1,
      );
      assert.equal(
        db.prepare("SELECT value FROM settings").get()!.value,
        fault === "completed" ? "migrated" : "keep",
      );
      db.close();
      await assert.rejects(readFile(f.maintenance));
      await assert.rejects(
        readFile(path.join(f.data, "rollback-snapshot", "manifest.json")),
      );
      // A recovered initialization must not poison the single snapshot slot.
      if (["before-owner", "owner-synced", "owner-published"].includes(fault)) {
        assert.equal((await transaction(f.driver, "main")).phase, "completed");
      }
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
}

test("cold stop requires installed startup guard and exited service processes", async () => {
  const { makeDriver } = await import("../scripts/self-update.mjs");
  const f = await compatibilityFixture();
  const { rm } = await import("node:fs/promises");
  try {
    for (const response of [
      "active\n42\n0\ninactive\n0\n0",
      "inactive\n0\n0",
      "inactive\n0\n0\ninactive\n0\n0",
    ]) {
      const commands: string[][] = [];
      const driver = await makeDriver(
        f.root,
        f.data,
        {},
        async (cmd: string, args: string[]) => {
          commands.push([cmd, ...args]);
          return {
            stdout: args.includes("--property=ExecStartPre")
              ? "/usr/local/lib/codexbridge/self-update.mjs --guard-start"
              : args.includes("--property=ExecStart")
                ? "/usr/bin/node --import /usr/local/lib/codexbridge/legacy-bootstrap.mjs /opt/codexbridge/current/dist/cli.js start"
                : response,
          };
        },
      );
      if (response.split("\n").length === 6 && !response.includes("42"))
        await driver.stop(true);
      else await assert.rejects(driver.stop(true), /stopped services/);
      assert.ok(commands.every((c) => c[0] === "/usr/bin/systemctl"));
    }
    const driver = await makeDriver(f.root, f.data, {}, async () => ({
      stdout: "",
    }));
    await assert.rejects(driver.stop(), /startup guard/);
    const guardOnly = await makeDriver(f.root, f.data, {}, async () => ({
      stdout: "/usr/local/lib/codexbridge/self-update.mjs --guard-start",
    }));
    await assert.rejects(guardOnly.stop(true), /legacy bootstrap/);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("startup guard blocks incomplete/restoring/ambiguous state and validates snapshot before opening Store", async () => {
  const { guardStart } = await import("../scripts/self-update.mjs");
  const { randomUUID } = await import("node:crypto");
  const { rm } = await import("node:fs/promises");
  const f = await coldFixture();
  const state: any = {
    cold: true,
    id: randomUUID(),
    previous: f.old,
    candidate: f.candidate,
  };
  try {
    for (const phase of [
      "snapshotting",
      "restoring",
      "rollback_failed",
      "unknown",
    ])
      await assert.rejects(
        guardStart(f.data, { ...state, phase }),
        /prohibits/,
      );
    for (const phase of ["activating", "boot_pending_health"])
      await assert.rejects(guardStart(f.data, { ...state, phase }), /ENOENT/);
    state.snapshotHash = await f.driver.capture(state);
    await guardStart(f.data, { ...state, phase: "activating" });
    await guardStart(f.data, { ...state, phase: "boot_pending_health" });
    await writeFile(
      path.join(f.data, "rollback-snapshot", "codexbridge.db-wal"),
      "corrupt",
    );
    await assert.rejects(
      guardStart(f.data, { ...state, phase: "activating" }),
      /integrity/,
    );
    await assert.rejects(
      recover(f.driver, { ...state, phase: "unknown" }),
      /Ambiguous/,
    );
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("absent source sidecars are removed during rollback; orphan snapshots block startup and new transactions", async () => {
  const f = await coldFixture();
  const { DatabaseSync } = await import("node:sqlite");
  const { randomUUID } = await import("node:crypto");
  const { rm } = await import("node:fs/promises");
  const { restoreSnapshot, guardStart } =
    await import("../scripts/self-update.mjs");
  const state: any = {
    cold: true,
    id: randomUUID(),
    previous: f.old,
    candidate: f.candidate,
  };
  try {
    const checkpoint = new DatabaseSync(f.file);
    checkpoint.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    checkpoint.close();
    state.snapshotHash = await f.driver.capture(state);
    await writeFile(f.file + "-wal", "candidate wal");
    await writeFile(f.file + "-shm", "candidate shm");
    await restoreSnapshot(f.data, state);
    await assert.rejects(readFile(f.file + "-wal"));
    await assert.rejects(readFile(f.file + "-shm"));
    await assert.rejects(
      guardStart(f.data, undefined),
      /without its transaction/,
    );
    await assert.rejects(
      recover(f.driver, undefined, true),
      /without its transaction/,
    );
    await assert.rejects(
      transaction(f.driver, "main"),
      /without its transaction/,
    );
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

for (const fault of [
  "discard-published",
  "discard-owner-removed",
  "discard-removed",
]) {
  test(`process death during ${fault} cleanup is recoverable and permits another transaction`, async () => {
    const f = await coldFixture();
    const { randomUUID } = await import("node:crypto");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { rm, readdir } = await import("node:fs/promises");
    const state: any = {
      cold: true,
      id: randomUUID(),
      phase: "rolled_back",
      previous: f.old,
      candidate: f.candidate,
    };
    try {
      await f.driver.save(state);
      state.snapshotHash = await f.driver.capture(state);
      await f.driver.save(state);
      await assert.rejects(
        promisify(execFile)(process.execPath, [
          "--input-type=module",
          "-e",
          `
        import { cleanupSnapshot } from ${JSON.stringify(new URL("../scripts/self-update.mjs", import.meta.url).href)};
        await cleanupSnapshot(${JSON.stringify(f.data)}, ${JSON.stringify(state)},
          async phase => { if (phase === ${JSON.stringify(fault)}) process.exit(73); });
      `,
        ]),
        (e: any) => e.code === 73,
      );
      await recover(f.driver, state, true);
      assert.equal(
        (await readdir(f.data)).some((name) =>
          name.startsWith("rollback-snapshot"),
        ),
        false,
      );
      assert.equal((await transaction(f.driver, "main")).phase, "completed");
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
}
