// This runner is installed root-owned, but always executes as codexbridge, never root.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import {
  readFile,
  mkdir,
  rename,
  link,
  symlink,
  readlink,
  unlink,
  open,
  realpath,
  mkdtemp,
  rm,
  lstat,
  copyFile,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const exec = promisify(execFile);
// Audited deployed v1 tree: no integrations, no modern readiness API.
// Never infer legacy compatibility from missing metadata or a failed API call.
export const HISTORICAL_V1 = ["3a99deafb510a893e607204f3add8805599c69e7"];
// TypeScript 5.9.3 output from the pinned source and its committed tsconfig.
// Verify running modules too: a clean source checkout cannot attest stale dist.
const historicalRuntime = {
  "cli.js": "b741d5d9a63e8e7a016a28797db74929dc820d8176c52f6f3eb0b89d205ec678",
  "codex.js":
    "3be8661da7f244dd7ad4d4f711a41fd35132861ba61735caf7e28baee38173bc",
  "config.js":
    "1a47ac366af2310e521540f06ee35fd29d23a9027c6135d720ec432dab2db46b",
  "database.js":
    "2ec14f6d02e29ed71af23b8c5cbdd7cd817592546f33b767b834ff62cd178d87",
  "domain.js":
    "09e2ae853e3a7861a0653482bc7b17b798a0caa793ad39394639507bc9ac2d72",
  "git.js": "a89b9940652bd12d892c6152dc5057264fb88ba0191471fbeb3618471356e4e6",
  "headless.js":
    "d5b74ed1938647ec09c6cf8324b8794ee74a63e46c470b9491e71f8e0a2fbbe1",
  "log.js": "1d164404272087ad3185482c02eadc8bdfd75fb3ceb53c3eab0930518c04c1d6",
  "orchestrator.js":
    "badc7417aaef43d2aacb91295905290ac1171eda34a33eada907d8f2de697dcf",
  "reviewer.js":
    "b635e5174cdbb156bdb6fd075ae1975e2541746073f451e367d4cb70461734d3",
  "server.js":
    "d1da1ef4c413f5225954b008775e70681ba3b8d52c8086df5e3ecd19eb0aad8b",
  "stdio.js":
    "cd0ab1cae888864a944d0b785e2f9be201109fc3d3fb269c8b2c8b17c45ba0a6",
  "tools.js":
    "35a7d6990498fba6c743002b4278c8f5d1f2aaf96b76de2a41da5617c9512870",
};
export async function historicalIdentity(release, execute = exec) {
  const git = async (args) =>
    (
      await execute(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.fsmonitor=false",
          ...args,
        ],
        { cwd: release, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" } },
      )
    ).stdout.trim();
  const manifest = JSON.parse(
    await readFile(path.join(release, "release.json"), "utf8"),
  );
  if (!HISTORICAL_V1.includes(manifest.commit))
    throw Error("Unreviewed historical release");
  if ((await git(["rev-parse", "HEAD"])) !== manifest.commit)
    throw Error("Historical release identity mismatch");
  const tree = await git([
    "ls-tree",
    "-rz",
    manifest.commit,
    "--",
    "src",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "deploy/debian/release-policy.json",
  ]);
  for (const entry of tree.split("\0").filter(Boolean)) {
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/.exec(entry);
    if (!match) throw Error("Unexpected historical source entry");
    const bytes = await regularBytes(path.join(release, match[3]));
    const hash = createHash("sha1")
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex");
    if (hash !== match[2])
      throw Error("Historical source differs from pinned commit");
  }
  for (const [name, hash] of Object.entries(historicalRuntime)) {
    if (digest(await regularBytes(path.join(release, "dist", name))) !== hash)
      throw Error(
        "Historical build differs from reviewed runtime; rebuild pinned source with locked compiler",
      );
  }
  const policy = JSON.parse(
    await git(["show", `${manifest.commit}:deploy/debian/release-policy.json`]),
  );
  if (
    JSON.stringify(policy) !== '{"runtimeSchema":1}' ||
    manifest.runtimeSchema !== 1 ||
    manifest.sqliteSchema !== undefined ||
    manifest.minimumUpdaterVersion !== undefined
  )
    throw Error("Historical release metadata mismatch");
  return { ...manifest, sqliteSchema: 1, historicalBootstrap: 1 };
}
export async function assertServiceCgroup(directory, main) {
  const pids = new Set();
  const visit = async (dir) => {
    for (const value of (await readFile(path.join(dir, "cgroup.procs"), "utf8"))
      .trim()
      .split(/\s+/)
      .filter(Boolean)) {
      if (!/^[1-9][0-9]*$/.test(value))
        throw Error("Invalid cgroup process evidence");
      pids.add(value);
    }
    for (const entry of await readdir(dir, { withFileTypes: true }))
      if (entry.isDirectory()) await visit(path.join(dir, entry.name));
  };
  await visit(directory);
  if (pids.size !== 1 || !pids.has(main))
    throw Error("Surviving historical service child processes; update refused");
}
async function legacyStatus(data, source) {
  const lock = JSON.parse(
    await readFile(path.join(data, "server.lock"), "utf8"),
  );
  return new Promise((resolve, reject) => {
    const socket = connect(path.join(data, "legacy-updater.sock"));
    let bytes = "";
    socket.setTimeout(5000, () =>
      socket.destroy(Error("Legacy bootstrap deadline exceeded")),
    );
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      bytes += chunk;
      if (bytes.length > 16384)
        socket.destroy(Error("Invalid legacy bootstrap evidence"));
    });
    socket.on("end", () => {
      try {
        const status = JSON.parse(bytes);
        if (
          status.bootstrap !== 1 ||
          status.release !== source.commit ||
          !Number.isSafeInteger(lock.pid) ||
          status.pid !== lock.pid
        )
          throw Error("Legacy bootstrap identity mismatch");
        resolve(status);
      } catch (e) {
        reject(e);
      }
    });
  });
}
// Only explicit, well-formed idle evidence permits activation. Job status
// counts alone omit surviving child processes and integration operations.
export function assertQuiescent(status) {
  const count = (value) => Number.isSafeInteger(value) && value >= 0;
  const integrations = status?.integrations;
  if (
    status?.health?.orchestratorOk !== true ||
    status.health.maintenance !== true ||
    !count(status?.scheduler?.runningJobs) ||
    !count(status?.scheduler?.usedCapacity) ||
    !count(status?.activeIntegrationOperations) ||
    !integrations ||
    typeof integrations !== "object" ||
    Array.isArray(integrations) ||
    Object.entries(integrations).some(
      ([state, value]) =>
        !["VERIFYING", "PUBLISHING", "SUCCEEDED", "FAILED"].includes(state) ||
        !count(value),
    )
  )
    throw Error("Untrusted quiescence status; update refused.");
  if (
    status.scheduler.runningJobs > 0 ||
    status.scheduler.usedCapacity > 0 ||
    status.activeIntegrationOperations > 0 ||
    (integrations.VERIFYING ?? 0) > 0 ||
    (integrations.PUBLISHING ?? 0) > 0
  )
    throw Error(
      "Active jobs, child processes or integrations; update refused. Wait or cancel explicitly.",
    );
}
// Monotonic activation/recovery contract, independent of runtime/database schemas.
// Bump when releases start depending on new updater behavior; never read the
// supported version from candidate code or metadata.
export const UPDATER_VERSION = 2;
export function validateUpdater(policy, allowLegacy = false) {
  const required = policy?.minimumUpdaterVersion;
  if (required === undefined && allowLegacy) return 0;
  if (!Number.isSafeInteger(required) || required < 1)
    throw Error("Invalid or missing minimumUpdaterVersion in release metadata");
  if (required > UPDATER_VERSION)
    throw Error(
      `Release requires updater version ${required}; invoking updater supports ${UPDATER_VERSION}. Install the matching reviewed updater first.`,
    );
  return required;
}
export function validateRef(ref) {
  if (
    typeof ref !== "string" ||
    !ref.length ||
    ref.length > 256 ||
    ref.startsWith("-") ||
    ref.includes("..") ||
    /[\s\u0000-\u001f\u007f:]/u.test(ref)
  )
    throw Error("Invalid explicit Git ref");
  return ref;
}
export async function atomicJson(file, value) {
  const temp = file + ".tmp";
  const h = await open(temp, "w", 0o600);
  try {
    await h.writeFile(JSON.stringify(value));
    await h.sync();
  } finally {
    await h.close();
  }
  await rename(temp, file);
  if (process.platform !== "win32") {
    const dir = await open(path.dirname(file), "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }
}
// Publish only complete, synced bytes, with link's atomic no-replace semantics.
// A crash can leave an unused temporary file, never a partial live marker.
export async function publishMaintenance(
  file,
  marker,
  io = { open, link, unlink },
) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await io.open(temp, "wx", 0o600);
    try {
      await handle.writeFile(marker);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await io.link(temp, file);
    const dir = await io.open(path.dirname(file), "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } finally {
    await io.unlink(temp).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
export function safeError(error) {
  let text = error instanceof Error ? error.message : String(error);
  for (const [name, value] of Object.entries(process.env))
    if (/TOKEN|SECRET|KEY|PASSWORD/i.test(name) && value && value.length > 7)
      text = text.split(value).join("[REDACTED]");
  return text
    .replace(/Bearer\s+[\w.\-]+/gi, "[REDACTED]")
    .replace(/https:\/\/[^/\s@]+@/g, "https://[REDACTED]@")
    .slice(0, 600);
}

// Accept the legacy doctor's check list for rollback/first upgrade as well as
// the new explicit summary. Only the external tunnel is non-blocking.
export function releaseHealth(status, expected) {
  const required = [
    "node",
    "database",
    "git",
    "codexAuth",
    "repositories",
    "tunnel",
  ];
  const checks = status?.checks;
  if (
    typeof expected !== "string" ||
    !expected.length ||
    status?.managed !== true ||
    status.release !== expected ||
    !Array.isArray(checks) ||
    checks.some(
      (c) => !c || typeof c.name !== "string" || typeof c.ok !== "boolean",
    ) ||
    new Set(checks.map((c) => c.name)).size !== checks.length ||
    required.some((name) => !checks.some((c) => c.name === name)) ||
    checks.some((c) => c.name !== "tunnel" && c.ok !== true) ||
    status.ok !== checks.every((c) => c.ok) ||
    ("orchestratorOk" in status && status.orchestratorOk !== true)
  )
    throw Error("Doctor or release identity mismatch");
  const tunnel = checks.find((c) => c.name === "tunnel").ok
    ? "ready"
    : "degraded";
  if (
    ("availability" in status && status.availability !== tunnel) ||
    ("tunnel" in status && status.tunnel !== tunnel)
  )
    throw Error("Inconsistent doctor availability");
  return { orchestratorOk: true, availability: tunnel, tunnel };
}
// Only Store-owned SQLite files are reverted. Configuration, credentials, job
// worktrees and release manifests are never overwritten by database recovery.
const databaseFiles = [
  "codexbridge.db",
  "codexbridge.db-wal",
  "codexbridge.db-shm",
];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function syncDirectory(dir) {
  const h = await open(dir, "r");
  try {
    await h.sync();
  } finally {
    await h.close();
  }
}
async function regularBytes(file, optional = false) {
  try {
    if (!(await lstat(file)).isFile())
      throw Error("Snapshot path is not a regular file");
    return await readFile(file);
  } catch (e) {
    if (optional && e.code === "ENOENT") return null;
    throw e;
  }
}
function snapshotPath(data, state) {
  if (!state?.cold || !/^[0-9a-f-]{36}$/.test(state.id ?? ""))
    throw Error("Missing transaction-bound snapshot evidence");
  return path.join(data, "rollback-snapshot");
}
export async function captureSnapshot(
  data,
  state,
  source,
  boundary = async () => {},
) {
  const dir = snapshotPath(data, state);
  const initializing = dir + ".init-" + state.id;
  // A single slot bounds retention and refuses evidence from any prior operation.
  await mkdir(initializing, { mode: 0o700 });
  await syncDirectory(data);
  await boundary("before-owner");
  await atomicJson(path.join(initializing, "owner.json"), { id: state.id });
  await boundary("owner-synced");
  // Refuse even an empty foreign canonical slot; the updater entrypoint is flock-serialized.
  try {
    await lstat(dir);
    throw Error("Existing snapshot slot");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  await rename(initializing, dir);
  await syncDirectory(data);
  await boundary("owner-published");
  const files = [];
  for (const name of databaseFiles) {
    const bytes = await regularBytes(
      path.join(data, name),
      name !== databaseFiles[0],
    );
    files.push({ name, hash: bytes === null ? null : digest(bytes) });
    if (bytes !== null) {
      const h = await open(path.join(dir, name), "wx", 0o600);
      try {
        await h.writeFile(bytes);
        await h.sync();
      } finally {
        await h.close();
      }
    }
  }
  await boundary("files-synced");
  // Inspect a disposable copy: opening SQLite can recover/checkpoint a WAL and
  // must never modify either the live files or the immutable rollback evidence.
  const probe = path.join(dir, "probe");
  await mkdir(probe);
  try {
    for (const f of files)
      if (f.hash !== null)
        await copyFile(path.join(dir, f.name), path.join(probe, f.name));
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(probe, databaseFiles[0]));
    try {
      if (
        db.prepare("PRAGMA user_version").get().user_version !==
          source.sqliteSchema ||
        db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok"
      )
        throw Error("Source database schema/integrity mismatch");
    } finally {
      db.close();
    }
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
  const manifest = {
    version: 1,
    id: state.id,
    previous: state.previous,
    candidate: state.candidate,
    source,
    files,
  };
  await atomicJson(path.join(dir, "manifest.json"), manifest);
  await syncDirectory(data);
  await boundary("manifest-synced");
  return digest(Buffer.from(JSON.stringify(manifest)));
}
export async function verifySnapshot(data, state, source) {
  const dir = snapshotPath(data, state);
  const raw = await regularBytes(path.join(dir, "manifest.json"));
  if (digest(raw) !== state.snapshotHash)
    throw Error("Snapshot manifest integrity mismatch");
  const m = JSON.parse(raw);
  if (
    m.version !== 1 ||
    m.id !== state.id ||
    m.previous !== state.previous ||
    m.candidate !== state.candidate ||
    m.source?.sqliteSchema !== 1 ||
    !Array.isArray(m.files) ||
    m.files.length !== databaseFiles.length
  )
    throw Error("Wrong transaction snapshot");
  if (source && JSON.stringify(m.source) !== JSON.stringify(source))
    throw Error("Snapshot source release mismatch");
  // Validate the entire set before the first live write. A crash between file
  // replacements is safe: the journal blocks startup and repeats this whole set.
  const bytes = [];
  for (const [i, name] of databaseFiles.entries()) {
    const f = m.files[i];
    if (f.name !== name || (i === 0 && f.hash === null))
      throw Error("Invalid snapshot file set");
    const b = await regularBytes(path.join(dir, name), true);
    if ((b === null ? null : digest(b)) !== f.hash)
      throw Error("Snapshot file integrity mismatch");
    bytes.push(b);
  }
  return { bytes, source: m.source };
}
export async function restoreSnapshot(
  data,
  state,
  source,
  boundary = async () => {},
) {
  const { bytes, source: original } = await verifySnapshot(data, state, source);
  for (const [i, name] of databaseFiles.entries()) {
    const target = path.join(data, name);
    if (bytes[i] === null)
      await unlink(target).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
    else {
      const temp = target + ".restore";
      const h = await open(temp, "w", 0o600);
      try {
        await h.writeFile(bytes[i]);
        await h.sync();
      } finally {
        await h.close();
      }
      await rename(temp, target);
    }
    await syncDirectory(data);
    await boundary(name);
  }
  return original;
}
export async function cleanupSnapshot(data, state, boundary = async () => {}) {
  const dir = snapshotPath(data, state);
  // Terminal journal is durable before cleanup. Missing files after a crash
  // during cleanup are harmless; no future rollback may use this snapshot.
  const discarded = dir + ".discard-" + state.id;
  try {
    const owner = JSON.parse(
      await readFile(path.join(dir, "owner.json"), "utf8"),
    );
    if (owner.id !== state.id)
      throw Error("Snapshot belongs to another transaction");
    await rename(dir, discarded);
    await syncDirectory(data);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    // An existing directory without its owner is ambiguous, never discard it.
    try {
      await lstat(dir);
      throw Error("Missing snapshot owner");
    } catch (missing) {
      if (missing.code !== "ENOENT") throw missing;
    }
  }
  await boundary("discard-published");
  await unlink(path.join(discarded, "owner.json")).catch((e) => {
    if (e.code !== "ENOENT") throw e;
  });
  await boundary("discard-owner-removed");
  await rm(discarded, { recursive: true, force: true });
  await syncDirectory(data);
  await boundary("discard-removed");
  // The durable journal reserves this UUID path before mkdir. Even a death
  // before owner publication cannot make its empty staging directory foreign.
  const initializing = dir + ".init-" + state.id;
  try {
    const owner = JSON.parse(
      await readFile(path.join(initializing, "owner.json"), "utf8"),
    );
    if (owner.id !== state.id) throw Error("Foreign initialization owner");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  await rm(initializing, { recursive: true, force: true });
  await syncDirectory(data);
}
// Dependency-injected transaction: tests exercise the same ordering and failure paths.
export async function transaction(driver, ref) {
  validateRef(ref);
  let previous,
    candidate,
    activating = false,
    quiescing = false,
    cold = false,
    snapshotHash,
    terminal = false;
  const id = randomUUID();
  const save = (phase, extra = {}) =>
    driver.save({
      phase,
      id,
      cold,
      snapshotHash,
      ref,
      previous,
      candidate,
      time: new Date().toISOString(),
      ...extra,
    });
  await driver.checkIdle?.();
  try {
    previous = await driver.current();
    await save("building");
    candidate = await driver.build(ref);
    cold = (await driver.validateRollback(previous, candidate)) === true;
    await save("prepared");
    quiescing = true;
    await driver.quiesce();
    if (cold) {
      await save("snapshotting");
      await driver.stop();
      snapshotHash = await driver.capture({ id, cold, previous, candidate });
    }
    // Durable intent precedes the atomic switch, so an interrupted activation is recoverable.
    await save("activating");
    activating = true;
    await driver.activate(candidate, {
      id,
      cold,
      previous,
      candidate,
      snapshotHash,
    });
    await driver.restart();
    const health = await driver.health(candidate);
    await save("completed", { health });
    terminal = true;
    await driver.resume();
    if (cold) await driver.cleanup({ id, cold });
    return { phase: "completed", candidate };
  } catch (error) {
    if (terminal) throw error;
    if (activating) {
      try {
        if (cold) {
          await save("restoring");
          await driver.stop();
        }
        await driver.restore(previous, {
          id,
          cold,
          previous,
          candidate,
          snapshotHash,
        });
        if (cold) await save("boot_pending_health");
        await driver.restart();
        const health = await driver.health(previous);
        await save("rolled_back", {
          health,
          reason: "Previous release restored: " + safeError(error),
        });
        terminal = true;
        await driver.resume();
        if (cold) await driver.cleanup({ id, cold });
      } catch (rollbackError) {
        if (terminal) throw rollbackError;
        await save("rollback_failed", {
          reason:
            "WAITING_FOR_HUMAN: inspect journald and restore the previous release; maintenance retained.",
        });
        throw Error(
          "Rollback failed; maintenance retained for operator intervention",
        );
      }
    } else if (cold && quiescing) {
      // No candidate has started; recovery restarts the unchanged source.
      throw error;
    } else {
      await save("failed", {
        reason:
          "Preparation failed; active release unchanged: " + safeError(error),
      });
      if (quiescing) await driver.resume();
    }
    throw error;
  }
}
export async function verifyRecovery(driver, state) {
  if (!["boot_pending_health", "rollback_failed"].includes(state?.phase))
    return;
  await driver.hold(state);
  let terminal = false;
  try {
    await driver.verifyEvidence?.(state);
    const health = await driver.health(state.previous);
    await driver.save({
      ...state,
      phase: "rolled_back",
      health,
      reason: "Restored release passed post-start health checks.",
    });
    terminal = true;
    await driver.resume();
    if (state.cold) await driver.cleanup(state);
  } catch (error) {
    if (terminal) throw error;
    await driver.save({
      ...state,
      phase: "rollback_failed",
      reason:
        "WAITING_FOR_HUMAN: restored release unhealthy; maintenance retained: " +
        safeError(error),
    });
    throw error;
  }
}
export async function recover(driver, state, boot = false) {
  await driver.checkJournal?.(state);
  if (
    state?.cold &&
    ![
      "building",
      "prepared",
      "snapshotting",
      "activating",
      "restoring",
      "rollback_failed",
      "boot_pending_health",
      "completed",
      "rolled_back",
      "failed",
    ].includes(state.phase)
  )
    throw Error("Ambiguous database transaction phase");
  if (
    [
      "activating",
      "restoring",
      "rollback_failed",
      "boot_pending_health",
    ].includes(state?.phase)
  ) {
    // The boot unit must finish before the server can start. Keep scheduling
    // blocked until the separate post-start unit validates the restored release.
    await driver.hold(state);
    if (state.cold) {
      await driver.save({ ...state, phase: "restoring" });
      await driver.stop(boot);
    }
    if (!state.snapshotAborted)
      await driver.restore(state.previous, state, boot);
    const pending = {
      ...state,
      phase: "boot_pending_health",
      reason:
        "Restored release awaiting post-start health checks; maintenance retained.",
    };
    await driver.save(pending);
    if (boot) return;
    await driver.restart();
    await verifyRecovery(driver, pending);
    return;
  } else if (state?.phase === "snapshotting") {
    await driver.hold(state);
    // Activation intent was never published: live source bytes are unchanged.
    const pending = {
      ...state,
      phase: "boot_pending_health",
      snapshotAborted: true,
    };
    await driver.save(pending);
    if (!boot) {
      await driver.restart();
      await verifyRecovery(driver, pending);
    }
    return;
  } else if (["building", "prepared"].includes(state?.phase)) {
    await driver.save({
      ...state,
      phase: "failed",
      reason: "Interrupted preparation; active release unchanged.",
    });
  }
  if (state?.cold) {
    await driver.hold(state);
    await driver.resume();
    await driver.cleanup(state);
  } else await driver.resume(true);
}
export async function makeDriver(
  root,
  dataDir,
  config,
  execute = exec,
  request = fetch,
  maintenanceIO,
) {
  const releases = path.join(root, "releases");
  const maintenance = path.join(dataDir, "maintenance.json");
  const current = path.join(root, "current");
  const run = (command, args, cwd, env = process.env, timeout = 900000) =>
    execute(command, args, { cwd, env, timeout, maxBuffer: 16 * 1024 * 1024 });
  const git = async (cwd, args) =>
    (
      await run("git", ["-c", "core.hooksPath=/dev/null", ...args], cwd, {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_NO_REPLACE_OBJECTS: "1",
      })
    ).stdout.trim();
  const releasePath = async (value) => {
    const resolved = await realpath(value);
    if (path.dirname(resolved) !== (await realpath(releases)))
      throw Error("Release must be directly inside releases directory");
    return resolved;
  };
  async function compatibleRelease(release, allowLegacy = false) {
    await releasePath(release);
    const policy = JSON.parse(
      await readFile(
        path.join(release, "deploy/debian/release-policy.json"),
        "utf8",
      ),
    );
    const manifest = JSON.parse(
      await readFile(path.join(release, "release.json"), "utf8"),
    );
    if (
      allowLegacy &&
      manifest.sqliteSchema === undefined &&
      HISTORICAL_V1.includes(manifest.commit)
    )
      return historicalIdentity(release, execute);
    const head = await git(release, ["rev-parse", "HEAD"]);
    const committedPolicy = JSON.parse(
      await git(release, ["show", `${head}:deploy/debian/release-policy.json`]),
    );
    if (
      !/^[0-9a-f]{40,64}$/.test(head) ||
      manifest.commit !== head ||
      manifest.runtimeSchema !== 1 ||
      ![4, ...(allowLegacy ? [1] : [])].includes(manifest.sqliteSchema) ||
      policy.runtimeSchema !== 1 ||
      policy.sqliteSchema !== manifest.sqliteSchema ||
      committedPolicy.runtimeSchema !== 1 ||
      committedPolicy.sqliteSchema !== manifest.sqliteSchema
    )
      throw Error(
        "A verified schema-v4 rollback baseline or schema-v1 snapshot source is required",
      );
    const requirements = [manifest, policy, committedPolicy].map((metadata) =>
      validateUpdater(metadata, allowLegacy),
    );
    if (requirements.some((required) => required !== requirements[0]))
      throw Error("Updater compatibility metadata mismatch");
    return manifest;
  }
  async function switchCurrent(release) {
    const temp = current + ".next";
    await unlink(temp).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
    await symlink(release, temp, "dir");
    await rename(temp, current);
    const dir = await open(root, "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }
  let ownedMaintenance, transactionId, historicalSource;
  const updateMarker = (marker) =>
    (marker?.owner === "codexbridge-update" ||
      (marker && Object.keys(marker).length === 1)) &&
    (marker.reason === "self-update" ||
      marker.reason === "recovery awaiting health");
  async function acquireMaintenance(reason, recovery = false) {
    const marker = JSON.stringify({
      reason,
      owner: "codexbridge-update",
      id: transactionId ?? randomUUID(),
    });
    try {
      await publishMaintenance(maintenance, marker, maintenanceIO);
      ownedMaintenance = marker;
    } catch (error) {
      if (error.code !== "EEXIST" || !recovery) throw error;
      const existing = await readFile(maintenance, "utf8");
      if (
        !updateMarker(JSON.parse(existing)) ||
        (transactionId && JSON.parse(existing).id !== transactionId)
      )
        throw Error("Maintenance belongs to another operation");
      ownedMaintenance = existing;
    }
  }
  async function api(name) {
    const c = JSON.parse(
      await readFile(path.join(dataDir, "config.json"), "utf8"),
    );
    const r = await request(
      `http://127.0.0.1:${c.port ?? 3847}/api/tools/${name}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.CODEXBRIDGE_TOKEN || c.token}`,
          "Content-Type": "application/json",
        },
        body: "{}",
        signal: AbortSignal.timeout(20000),
      },
    );
    if (!r.ok) throw Error("Authenticated service check failed");
    return r.json();
  }
  const driver = {
    checkJournal: (state) => checkSnapshotJournal(dataDir, state),
    async bootstrapPreflight() {
      const source = await compatibleRelease(await realpath(current), true);
      if (!source.historicalBootstrap)
        throw Error(
          "Bootstrap preflight requires the pinned historical source",
        );
      const health = releaseHealth(await api("server_doctor"), source.commit);
      const status = await legacyStatus(dataDir, source);
      await driver.legacyProcesses(status);
      return {
        source,
        health,
        status,
        activationPermitted: false,
        detail:
          "Identity and bootstrap checked read-only; transaction maintenance, quiescence, stop and snapshot still required.",
      };
    },
    async checkIdle() {
      await checkSnapshotJournal(dataDir);
      try {
        await lstat(maintenance);
        throw Error("Existing maintenance; update refused");
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    },
    async verifyEvidence(state) {
      const source = await compatibleRelease(state.previous, true);
      if (source.sqliteSchema === 1 && !state.snapshotAborted)
        await verifySnapshot(dataDir, state, source);
    },
    save: async (state) => {
      if (state.cold) transactionId = state.id;
      await atomicJson(path.join(dataDir, "update-status.json"), state);
    },
    current: () => realpath(current).then(releasePath),
    async validateRollback(previous, candidate) {
      const source = await compatibleRelease(previous, true);
      const target = await compatibleRelease(candidate);
      if (source.sqliteSchema === 1 && target.minimumUpdaterVersion !== 2)
        throw Error("Cross-schema activation requires updater contract 2");
      historicalSource = source.historicalBootstrap ? source : undefined;
      return source.sqliteSchema === 1;
    },
    async build(ref) {
      // Repository URL is chosen by the administrator, never by the MCP caller.
      const cache = path.join(root, "upstream.git");
      await mkdir(releases, { recursive: true });
      try {
        await readFile(path.join(cache, "HEAD"));
      } catch {
        await git(root, ["init", "--bare", cache]);
      }
      await git(cache, [
        "fetch",
        "--no-tags",
        "--force",
        "--",
        config.repository,
        validateRef(ref),
      ]);
      const commit = await git(cache, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        "FETCH_HEAD^{commit}",
      ]);
      if (!/^[0-9a-f]{40,64}$/.test(commit))
        throw Error("Invalid fetched commit");
      const candidate = path.join(releases, `${commit}-${Date.now()}`);
      await git(root, [
        "clone",
        "--no-hardlinks",
        "--no-checkout",
        "--",
        cache,
        candidate,
      ]);
      await git(candidate, ["checkout", "--detach", commit]);
      const manifest = JSON.parse(
        await readFile(
          path.join(candidate, "deploy/debian/release-policy.json"),
          "utf8",
        ),
      );
      if (manifest.runtimeSchema !== 1 || manifest.sqliteSchema !== 4)
        throw Error("Incompatible runtime schema; manual migration required");
      validateUpdater(manifest);
      // Build/test subprocesses receive no production secrets or runtime path.
      const scratch = path.join(candidate, ".validation");
      await mkdir(scratch);
      // tsx creates an IPC Unix socket below TMPDIR. Release paths can exceed
      // the AF_UNIX path limit, so keep only temporary IPC files in short /tmp.
      const ipcTmp = await mkdtemp(
        path.join(tmpdir(), "codexbridge-validation-"),
      );
      const env = {
        PATH: process.env.PATH,
        HOME: scratch,
        TMPDIR: ipcTmp,
        TEMP: ipcTmp,
        TMP: ipcTmp,
        CODEXBRIDGE_HOME: path.join(scratch, "runtime"),
        CI: "1",
      };
      try {
        await run(
          "npm",
          ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
          candidate,
          env,
        );
        await run("npm", ["run", "build"], candidate, env);
        await run("npm", ["test"], candidate, env);
        await atomicJson(path.join(candidate, "release.json"), {
          commit,
          runtimeSchema: 1,
          sqliteSchema: 4,
          minimumUpdaterVersion: manifest.minimumUpdaterVersion,
        });
        return candidate;
      } finally {
        await rm(ipcTmp, { recursive: true, force: true });
      }
    },
    hold: (state) => {
      transactionId = state?.cold ? state.id : undefined;
      return acquireMaintenance("recovery awaiting health", true);
    },
    async stop(boot = false) {
      const guard = await run(
        "/usr/bin/systemctl",
        ["show", "codexbridge.service", "--property=ExecStartPre", "--value"],
        root,
      );
      if (
        !guard.stdout.includes(
          "/usr/local/lib/codexbridge/self-update.mjs --guard-start",
        )
      )
        throw Error("Updater contract 2 startup guard is not installed");
      const entry = await run(
        "/usr/bin/systemctl",
        ["show", "codexbridge.service", "--property=ExecStart", "--value"],
        root,
      );
      if (
        !entry.stdout.includes(
          "--import /usr/local/lib/codexbridge/legacy-bootstrap.mjs",
        )
      )
        throw Error(
          "Updater contract 2 legacy bootstrap is not installed in the service unit",
        );
      if (!boot)
        await run(
          "/usr/bin/sudo",
          ["-n", "/usr/local/sbin/codexbridge-control", "stop"],
          root,
        );
      const deadline = Date.now() + 120000;
      do {
        const result = await run(
          "/usr/bin/systemctl",
          [
            "show",
            "codexbridge.service",
            "codexbridge-tunnel.service",
            "--property=ActiveState,MainPID,ControlPID",
            "--value",
          ],
          root,
        );
        const values = result.stdout.trim().split(/\s+/);
        if (
          values.length === 6 &&
          values.filter((v) => v === "0").length === 4 &&
          values.filter((v) => ["inactive", "failed"].includes(v)).length === 2
        )
          return;
        if (boot) throw Error("Boot recovery requires stopped services");
        await new Promise((resolve) => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      throw Error("Service stop deadline exceeded; snapshot/restore refused");
    },
    capture: async (state) =>
      captureSnapshot(
        dataDir,
        state,
        await compatibleRelease(state.previous, true),
      ),
    cleanup: (state) => cleanupSnapshot(dataDir, state),
    async legacyProcesses(status) {
      const main = (
        await run(
          "/usr/bin/systemctl",
          ["show", "codexbridge.service", "--property=MainPID", "--value"],
          root,
        )
      ).stdout.trim();
      const group = (
        await run(
          "/usr/bin/systemctl",
          ["show", "codexbridge.service", "--property=ControlGroup", "--value"],
          root,
        )
      ).stdout.trim();
      if (
        main !== String(status.pid) ||
        !group.startsWith("/") ||
        !group.endsWith("/codexbridge.service") ||
        path.posix.normalize(group) !== group
      )
        throw Error("Untrusted historical service process identity");
      await assertServiceCgroup(path.join("/sys/fs/cgroup", group), main);
    },
    async quiesce() {
      await acquireMaintenance("self-update");
      if (historicalSource) {
        const doctor = await api("server_doctor");
        releaseHealth(doctor, historicalSource.commit);
        if (doctor.maintenance !== true)
          throw Error("Historical maintenance not acknowledged");
        const status = await legacyStatus(dataDir, historicalSource);
        assertQuiescent(status);
        await driver.legacyProcesses(status);
      } else assertQuiescent(await api("operational_summary"));
    },
    async activate(release, state) {
      await compatibleRelease(release);
      // Also guard direct activation, before replacing the current symlink.
      const previous = await realpath(current).catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      if (previous && previous !== release) {
        const source = await compatibleRelease(previous, true);
        if (source.sqliteSchema === 1) {
          if (
            !state?.cold ||
            state.previous !== previous ||
            state.candidate !== release ||
            !state.snapshotHash
          )
            throw Error(
              "Cross-schema activation requires transaction-bound snapshot",
            );
          // Validate bytes without changing the live set.
          await verifySnapshot(dataDir, state, source);
        }
      }
      await switchCurrent(release);
    },
    async restore(release, state) {
      // Recovery trusts only the restoration target, never a damaged outgoing release.
      const source = await compatibleRelease(release, true);
      if (source.sqliteSchema === 1) {
        const restored = await restoreSnapshot(dataDir, state, source);
        if (restored.commit !== source.commit)
          throw Error("Snapshot source release mismatch");
      }
      await switchCurrent(release);
    },
    restart: () =>
      run(
        "/usr/bin/sudo",
        ["-n", "/usr/local/sbin/codexbridge-control", "restart"],
        root,
      ),
    async health(release) {
      const expected = JSON.parse(
        await readFile(path.join(release, "release.json"), "utf8"),
      ).commit;
      const deadline = Date.now() + 90000;
      do {
        try {
          const status = await api("server_doctor");
          const health = releaseHealth(status, expected);
          await run(
            "/usr/bin/systemctl",
            ["is-active", "--quiet", "codexbridge.service"],
            root,
            process.env,
            5000,
          );
          return health;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      } while (Date.now() < deadline);
      throw Error("Release health deadline exceeded");
    },
    async resume(recovery = false) {
      try {
        const existing = await readFile(maintenance, "utf8");
        if (
          existing === ownedMaintenance ||
          (recovery && updateMarker(JSON.parse(existing)))
        ) {
          await unlink(maintenance);
          ownedMaintenance = undefined;
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    },
  };
  return driver;
}
async function checkSnapshotJournal(data, state) {
  if (state?.cold) {
    snapshotPath(data, state); // Validate identity even before snapshot publication.
    return;
  }
  try {
    if (
      (await readdir(data)).some((name) =>
        name.startsWith("rollback-snapshot.init-"),
      )
    )
      throw Error(
        "Snapshot initialization exists without its transaction journal",
      );
    await lstat(path.join(data, "rollback-snapshot"));
    throw Error("Snapshot exists without its transaction journal");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}
export async function guardStart(data, state) {
  await checkSnapshotJournal(data, state);
  if (
    state?.cold &&
    ![
      "activating",
      "boot_pending_health",
      "completed",
      "rolled_back",
      "failed",
      "building",
      "prepared",
    ].includes(state.phase)
  )
    throw Error("Database transaction prohibits service startup");
  if (
    state?.cold &&
    ["activating", "boot_pending_health"].includes(state.phase) &&
    !state.snapshotAborted
  )
    await verifySnapshot(data, state);
}
async function main() {
  if (process.platform !== "linux" || process.getuid?.() === 0)
    throw Error("Run only as the Debian service account");
  const root = "/opt/codexbridge",
    data = "/var/lib/codexbridge";
  if (process.argv.includes("--guard-start")) {
    let state;
    try {
      state = JSON.parse(
        await readFile(path.join(data, "update-status.json"), "utf8"),
      );
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    await guardStart(data, state);
    return;
  }
  const config = JSON.parse(
    await readFile("/etc/codexbridge/update.json", "utf8"),
  );
  if (
    typeof config.repository !== "string" ||
    !/^(https:\/\/|ssh:\/\/|git@)/.test(config.repository) ||
    config.repository.startsWith("-")
  )
    throw Error(
      "Administrator must configure an explicit HTTPS/SSH repository",
    );
  if (process.argv.includes("--bootstrap-preflight")) {
    const driver = await makeDriver(root, data, config);
    console.log(JSON.stringify(await driver.bootstrapPreflight()));
    return;
  }
  if (!process.argv.includes("--locked")) {
    await exec("/usr/bin/flock", [
      "--exclusive",
      "--nonblock",
      path.join(data, "update.lock"),
      process.execPath,
      fileURLToPath(import.meta.url),
      "--locked",
      ...process.argv.slice(2),
    ]);
    return;
  }
  const driver = await makeDriver(root, data, config);
  let state;
  try {
    state = JSON.parse(
      await readFile(path.join(data, "update-status.json"), "utf8"),
    );
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (process.argv.includes("--verify-recovery")) {
    await verifyRecovery(driver, state);
    return;
  }
  await recover(driver, state, process.argv.includes("--recover"));
  if (process.argv.includes("--recover")) {
    await unlink(path.join(data, "update-request.json")).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
    return;
  }
  const request = path.join(data, "update-request.json");
  let input;
  try {
    input = JSON.parse(await readFile(request, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return;
    throw e;
  }
  try {
    await transaction(driver, input.ref);
  } finally {
    await unlink(request);
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch(() => {
    console.error(
      "Self-update failed. Read update-status.json and journalctl -u codexbridge-update.",
    );
    process.exitCode = 1;
  });
