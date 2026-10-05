import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { createServer } from "node:net";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  symlink,
  rm,
  realpath,
  access,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import {
  makeDriver,
  transaction,
  historicalIdentity,
  guardStart,
  recover,
} from "../scripts/self-update.mjs";
import { Store as CandidateStore } from "../src/database.js";
const execute = promisify(execFile);
const SOURCE = "3a99deafb510a893e607204f3add8805599c69e7";

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "h-"));
  const data = dir;
  const root = path.join(dir, "root"),
    old = path.join(root, "releases", "old"),
    candidate = path.join(root, "releases", "candidate");
  await mkdir(path.dirname(old), { recursive: true });
  await execute("git", [
    "clone",
    "--shared",
    "--no-checkout",
    process.cwd(),
    old,
  ]);
  await execute("git", ["-C", old, "checkout", "--detach", SOURCE]);
  await symlink(
    path.join(process.cwd(), "node_modules"),
    path.join(old, "node_modules"),
  );
  await execute(process.execPath, [
    path.join(process.cwd(), "node_modules/typescript/bin/tsc"),
    "--project",
    path.join(old, "tsconfig.json"),
  ]);
  const manifest = JSON.stringify({ commit: SOURCE, runtimeSchema: 1 });
  await writeFile(path.join(old, "release.json"), manifest);
  await mkdir(path.join(candidate, "deploy/debian"), { recursive: true });
  const policy = {
    runtimeSchema: 2,
    sqliteSchema: 4,
    minimumUpdaterVersion: 2,
  };
  await writeFile(
    path.join(candidate, "deploy/debian/release-policy.json"),
    JSON.stringify(policy),
  );
  await execute("git", ["-C", candidate, "init"]);
  await execute("git", ["-C", candidate, "add", "."]);
  await execute("git", [
    "-C",
    candidate,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@localhost",
    "commit",
    "-m",
    "candidate",
  ]);
  const candidateCommit = (
    await execute("git", ["-C", candidate, "rev-parse", "HEAD"])
  ).stdout.trim();
  await writeFile(
    path.join(candidate, "release.json"),
    JSON.stringify({ commit: candidateCommit, ...policy }),
  );
  await symlink(old, path.join(root, "current"));
  const portServer = createServer();
  portServer.listen(0, "127.0.0.1");
  await once(portServer, "listening");
  const port = (portServer.address() as any).port;
  await new Promise<void>((resolve) => portServer.close(() => resolve()));
  const token = "historical-fixture-token".repeat(2);
  const config = JSON.stringify({
    dataDir: data,
    port,
    token,
    repositoryRoots: [old],
    codexCommand: "/usr/bin/true",
  });
  await writeFile(path.join(data, "config.json"), config);
  await mkdir(path.join(data, "codex"));
  await writeFile(
    path.join(data, "codex/auth.json"),
    "fixture credentials must survive",
  );
  const worktree = path.join(data, "worktrees", "job");
  await mkdir(worktree, { recursive: true });
  await writeFile(path.join(worktree, "retained.txt"), "uncommitted job work");
  const { Store } = await import(
    pathToFileURL(path.join(old, "dist/database.js")).href
  );
  const { createSchema } = await import(
    pathToFileURL(path.join(old, "dist/domain.js")).href
  );
  const file = path.join(data, "codexbridge.db");
  const sourceStore = new Store(file);
  const job = sourceStore.create(
    createSchema.parse({
      title: "Preserved legacy job",
      ticket: "Retain job, thread, worktree and feedback",
      repository: old,
    }),
  );
  sourceStore.patch(job.id, {
    status: "WAITING_FOR_HUMAN",
    worktree,
    codexThreadId: "original-thread",
    feedback: "original feedback",
  });
  sourceStore.db.exec(
    "INSERT INTO settings VALUES ('sentinel', 'source value')",
  );
  const originalJob = sourceStore.get(job.id);
  sourceStore.close();
  let child: ChildProcess | undefined,
    output = "";
  const api = (name: string, body: object = {}) =>
    fetch(`http://127.0.0.1:${port}/api/tools/${name}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  const stop = async (signal: NodeJS.Signals = "SIGTERM") => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill(signal);
      await exited;
    }
    child = undefined;
  };
  const start = async (bootstrap = true, injection?: string) => {
    const args = bootstrap
      ? ["--import", path.join(process.cwd(), "scripts/legacy-bootstrap.mjs")]
      : [];
    if (injection) args.push("--import", injection);
    child = spawn(
      process.execPath,
      [...args, path.join(old, "dist/cli.js"), "start"],
      {
        cwd: old,
        env: {
          PATH: process.env.PATH,
          HOME: data,
          CODEXBRIDGE_HOME: data,
          CODEXBRIDGE_MANAGED: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout!.on("data", (b) => {
      output += b;
    });
    child.stderr!.on("data", (b) => {
      output += b;
    });
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw Error(output);
      try {
        if (bootstrap) await access(path.join(data, "legacy-updater.sock"));
        if ((await api("server_doctor")).ok) return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw Error("Historical service did not start: " + output);
  };
  const driver = await makeDriver(
    root,
    data,
    {},
    async (command: string, args: string[], options: any) => {
      if (command === "git") return execute(command, args, options);
      assert.equal(command, "/usr/bin/systemctl");
      assert.deepEqual(args, ["is-active", "--quiet", "codexbridge.service"]);
      assert.ok(child && child.exitCode === null);
      return { stdout: "", stderr: "" };
    },
  );
  driver.legacyProcesses = async (status: any) => {
    // The disposable child is the service boundary here. The production driver
    // additionally enumerates the systemd cgroup, including orphan descendants.
    assert.equal(status.pid, child?.pid);
    assert.ok(child && child.exitCode === null);
  };
  driver.build = async () => candidate;
  driver.stop = () => stop();
  return {
    dir,
    data,
    root,
    old,
    candidate,
    manifest,
    config,
    file,
    Store,
    job,
    originalJob,
    api,
    start,
    stop,
    driver,
    async cleanup() {
      await stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("deployed 3a99dea original CLI/API/Store bootstraps, migrates and rolls back without persistent-state loss", async () => {
  const f = await fixture();
  try {
    assert.equal(
      await readFile(
        path.join(f.old, "deploy/debian/release-policy.json"),
        "utf8",
      ),
      '{"runtimeSchema":1}\n',
    );
    assert.equal((await historicalIdentity(f.old)).commit, SOURCE);
    // Original metadata is not rewritten to pretend the old application has v4 APIs.
    await f.start(false);
    assert.equal((await f.api("jobs_overview")).status, 200);
    assert.equal((await f.api("operational_summary")).status, 404);
    await f.driver.validateRollback(f.old, f.candidate);
    await assert.rejects(f.driver.quiesce(), /ENOENT|ECONNREFUSED/);
    await f.driver.resume();
    await f.stop();
    const walWriter = path.join(f.dir, "wal-writer.mjs");
    await writeFile(
      walWriter,
      `
      import { Orchestrator } from ${JSON.stringify(pathToFileURL(path.join(f.old, "dist/orchestrator.js")).href)};
      const start = Orchestrator.prototype.start;
      Orchestrator.prototype.start = function (...args) {
        const value = start.apply(this, args);
        this.store.db.exec("PRAGMA wal_autocheckpoint=0; INSERT INTO settings VALUES ('wal-sentinel', 'committed WAL');");
        return value;
      };
    `,
    );
    await f.start(true, walWriter);
    const preflight = await f.driver.bootstrapPreflight();
    assert.equal(preflight.source.commit, SOURCE);
    assert.equal(preflight.activationPermitted, false);
    await assert.rejects(readFile(path.join(f.data, "maintenance.json")));
    // Model a service that exits without checkpointing after quiescence. The
    // snapshot must retain the real historical Store's committed WAL and SHM.
    f.driver.stop = () => f.stop("SIGKILL");
    assert.equal((await f.api("operational_summary")).status, 404);
    let snapshotBytes: Buffer[] = [],
      sourceHealth = false;
    const files = [
      "codexbridge.db",
      "codexbridge.db-wal",
      "codexbridge.db-shm",
    ];
    const capture = f.driver.capture;
    f.driver.capture = async (state: any) => {
      // The service is gone, the bridge acknowledged all workers/operations idle,
      // and the production capture inspects the original Store's schema.
      const saved = files.map(async (name) =>
        readFile(path.join(f.data, name)).catch((e: any) => {
          if (e.code === "ENOENT") return null;
          throw e;
        }),
      );
      snapshotBytes = (await Promise.all(saved)) as any;
      const hash = await capture(state);
      const manifest = JSON.parse(
        await readFile(
          path.join(f.data, "rollback-snapshot/manifest.json"),
          "utf8",
        ),
      );
      assert.equal(manifest.source.commit, SOURCE);
      assert.equal(manifest.source.sqliteSchema, 1);
      assert.deepEqual(
        manifest.files.map((x: any) => x.name),
        files,
      );
      assert.ok(
        manifest.files.every((entry: any) => /^[a-f0-9]{64}$/.test(entry.hash)),
      );
      assert.ok(snapshotBytes[1].length > 0);
      return hash;
    };
    const quiesce = f.driver.quiesce;
    f.driver.quiesce = async () => {
      await quiesce();
      const before = await readFile(f.file);
      const response = await f.api("create_job", {
        title: "must not run",
        ticket: "blocked",
        repository: f.old,
      });
      assert.equal(response.status, 503);
      assert.equal((await f.api("retry_job", { id: f.job.id })).status, 503);
      assert.deepEqual(await readFile(f.file), before);
    };
    f.driver.restart = async () => {
      if ((await realpath(path.join(f.root, "current"))) === f.candidate) {
        const candidateStore = new CandidateStore(f.file);
        assert.equal(
          candidateStore.db.prepare("PRAGMA user_version").get()!.user_version,
          4,
        );
        candidateStore.db.exec(
          "UPDATE settings SET value='candidate mutation'",
        );
        candidateStore.close();
      } else {
        for (const [i, name] of files.entries()) {
          const bytes = await readFile(path.join(f.data, name)).catch(
            () => null,
          );
          assert.deepEqual(bytes, snapshotBytes[i]);
        }
        await guardStart(
          f.data,
          JSON.parse(
            await readFile(path.join(f.data, "update-status.json"), "utf8"),
          ),
        );
        await f.start(); // Real historical constructor rejects user_version > 1.
      }
    };
    const health = f.driver.health;
    f.driver.health = async (release: string) => {
      if (release === f.candidate)
        throw Error("candidate health failed after v4 migration");
      const result = await health(release); // Original authenticated doctor + exact identity.
      sourceHealth = true;
      return result;
    };
    await assert.rejects(
      transaction(f.driver, "HEAD"),
      /candidate health failed/,
    );
    assert.equal(sourceHealth, true);
    const doctor = (await (await f.api("server_doctor")).json()) as any;
    assert.equal(doctor.release, SOURCE);
    assert.equal(doctor.orchestratorOk, true);
    assert.equal(doctor.maintenance, false);
    await f.stop();
    const reopened = new f.Store(f.file);
    assert.equal(
      reopened.db.prepare("PRAGMA user_version").get().user_version,
      1,
    );
    assert.equal(
      reopened.db
        .prepare("SELECT value FROM settings WHERE key='sentinel'")
        .get().value,
      "source value",
    );
    assert.equal(
      reopened.db
        .prepare("SELECT value FROM settings WHERE key='wal-sentinel'")
        .get().value,
      "committed WAL",
    );
    assert.deepEqual(reopened.get(f.job.id), f.originalJob);
    reopened.close();
    assert.equal(
      await readFile(path.join(f.data, "config.json"), "utf8"),
      f.config,
    );
    assert.equal(
      await readFile(path.join(f.data, "codex/auth.json"), "utf8"),
      "fixture credentials must survive",
    );
    assert.equal(
      await readFile(path.join(f.data, "worktrees/job/retained.txt"), "utf8"),
      "uncommitted job work",
    );
    assert.equal(
      await readFile(path.join(f.old, "release.json"), "utf8"),
      f.manifest,
    );
    // Identity and source compatibility remain exact, even for the audited parents.
    for (const commit of [
      "316664ab48bb11c48aeccd060b83e9790f4b55bf",
      "7a153e8010ff577f00a23b208222d444f265bac7",
    ]) {
      await writeFile(
        path.join(f.old, "release.json"),
        JSON.stringify({ runtimeSchema: 1, commit }),
      );
      await assert.rejects(historicalIdentity(f.old), /Unreviewed/);
    }
    await writeFile(path.join(f.old, "release.json"), f.manifest);
    const compiled = path.join(f.old, "dist/database.js");
    const originalCompiled = await readFile(compiled);
    await writeFile(compiled, "unreviewed runtime");
    await assert.rejects(historicalIdentity(f.old), /Historical build/);
    await writeFile(compiled, originalCompiled);
    await writeFile(path.join(f.old, "src/database.ts"), "dirty source");
    await assert.rejects(historicalIdentity(f.old));
  } finally {
    await f.cleanup();
  }
});

test("3a99dea bootstrap rejects surviving workers, child PIDs and admitted operations even when jobs_overview says idle", async () => {
  const f = await fixture();
  try {
    for (const mode of ["worker", "child", "operation"]) {
      const injection = path.join(f.dir, `inject-${mode}.mjs`);
      await writeFile(
        injection,
        `
        import { Orchestrator } from ${JSON.stringify(pathToFileURL(path.join(f.old, "dist/orchestrator.js")).href)};
        const start = Orchestrator.prototype.start;
        Orchestrator.prototype.start = function (...args) {
          const value = start.apply(this, args);
          if (${JSON.stringify(mode)} === 'worker') {
            const controller = new AbortController();
            const promise = new Promise(resolve => controller.signal.addEventListener('abort', resolve));
            this.running.set(${JSON.stringify(f.job.id)}, { controller, promise });
          } else if (${JSON.stringify(mode)} === 'child') {
            this.store.patch(${JSON.stringify(f.job.id)}, { childPid: process.pid });
          } else {
            this.git.diff = () => new Promise(resolve => process.once('SIGTERM', () => resolve({})));
            void this.report(${JSON.stringify(f.job.id)});
          }
          return value;
        };
      `,
      );
      await f.start(true, injection);
      const overview = (await (await f.api("jobs_overview")).json()) as any;
      assert.equal(overview.counts.running, 0);
      let stopped = false,
        captured = false;
      f.driver.stop = async () => {
        stopped = true;
      };
      f.driver.capture = async () => {
        captured = true;
        throw Error("must not snapshot");
      };
      await assert.rejects(
        transaction(f.driver, "HEAD"),
        /Active jobs, child processes or integrations/,
      );
      assert.equal(stopped, false);
      assert.equal(captured, false);
      await recover(
        f.driver,
        JSON.parse(
          await readFile(path.join(f.data, "update-status.json"), "utf8"),
        ),
        true,
      );
      await f.stop();
      const store = new f.Store(f.file);
      store.patch(f.job.id, { childPid: null });
      store.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("legacy cgroup evidence includes orphan descendants and rejects malformed process lists", async () => {
  const { assertServiceCgroup } = await import("../scripts/self-update.mjs");
  const dir = await mkdtemp(path.join(os.tmpdir(), "cg-"));
  try {
    await writeFile(path.join(dir, "cgroup.procs"), "42\n");
    await assertServiceCgroup(dir, "42");
    await mkdir(path.join(dir, "worker"));
    await writeFile(path.join(dir, "worker/cgroup.procs"), "99\n");
    await assert.rejects(assertServiceCgroup(dir, "42"), /Surviving/);
    await writeFile(path.join(dir, "worker/cgroup.procs"), "");
    await assertServiceCgroup(dir, "42");
    await assert.rejects(assertServiceCgroup(dir, "43"), /Surviving/);
    await writeFile(path.join(dir, "worker/cgroup.procs"), "untrusted\n");
    await assert.rejects(assertServiceCgroup(dir, "42"), /Invalid cgroup/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
