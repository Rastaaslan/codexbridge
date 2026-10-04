// This runner is installed root-owned, but always executes as codexbridge, never root.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
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
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const exec = promisify(execFile);
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
export const UPDATER_VERSION = 1;
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
// Dependency-injected transaction: tests exercise the same ordering and failure paths.
export async function transaction(driver, ref) {
  validateRef(ref);
  let previous,
    candidate,
    activating = false,
    quiescing = false;
  const save = (phase, extra = {}) =>
    driver.save({
      phase,
      ref,
      previous,
      candidate,
      time: new Date().toISOString(),
      ...extra,
    });
  try {
    previous = await driver.current();
    await save("building");
    candidate = await driver.build(ref);
    await driver.validateRollback(previous, candidate);
    await save("prepared");
    quiescing = true;
    await driver.quiesce();
    // Durable intent precedes the atomic switch, so an interrupted activation is recoverable.
    await save("activating");
    activating = true;
    await driver.activate(candidate);
    await driver.restart();
    const health = await driver.health(candidate);
    await save("completed", { health });
    await driver.resume();
    return { phase: "completed", candidate };
  } catch (error) {
    if (activating) {
      try {
        await driver.restore(previous);
        await driver.restart();
        const health = await driver.health(previous);
        await save("rolled_back", {
          health,
          reason: "Previous release restored: " + safeError(error),
        });
        await driver.resume();
      } catch {
        await save("rollback_failed", {
          reason:
            "WAITING_FOR_HUMAN: inspect journald and restore the previous release; maintenance retained.",
        });
        throw Error(
          "Rollback failed; maintenance retained for operator intervention",
        );
      }
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
  await driver.hold();
  try {
    const health = await driver.health(state.previous);
    await driver.save({
      ...state,
      phase: "rolled_back",
      health,
      reason: "Restored release passed post-start health checks.",
    });
    await driver.resume();
  } catch (error) {
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
  if (
    ["activating", "rollback_failed", "boot_pending_health"].includes(
      state?.phase,
    )
  ) {
    // The boot unit must finish before the server can start. Keep scheduling
    // blocked until the separate post-start unit validates the restored release.
    await driver.hold();
    await driver.restore(state.previous);
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
  } else if (["building", "prepared"].includes(state?.phase)) {
    await driver.save({
      ...state,
      phase: "failed",
      reason: "Interrupted preparation; active release unchanged.",
    });
  }
  await driver.resume(true);
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
    const head = await git(release, ["rev-parse", "HEAD"]);
    const committedPolicy = JSON.parse(
      await git(release, ["show", `${head}:deploy/debian/release-policy.json`]),
    );
    if (
      !/^[0-9a-f]{40,64}$/.test(head) ||
      manifest.commit !== head ||
      manifest.runtimeSchema !== 1 ||
      manifest.sqliteSchema !== 4 ||
      policy.runtimeSchema !== 1 ||
      policy.sqliteSchema !== 4 ||
      committedPolicy.runtimeSchema !== 1 ||
      committedPolicy.sqliteSchema !== 4
    )
      throw Error(
        "A verified schema-v4 rollback baseline is required; cross-schema activation is forbidden: updater v1 has no durable database snapshot/restore contract",
      );
    const requirements = [manifest, policy, committedPolicy].map((metadata) =>
      validateUpdater(metadata, allowLegacy),
    );
    if (requirements.some((required) => required !== requirements[0]))
      throw Error("Updater compatibility metadata mismatch");
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
  let ownedMaintenance;
  const updateMarker = (marker) =>
    (marker?.owner === "codexbridge-update" ||
      (marker && Object.keys(marker).length === 1)) &&
    (marker.reason === "self-update" ||
      marker.reason === "recovery awaiting health");
  async function acquireMaintenance(reason, recovery = false) {
    const marker = JSON.stringify({
      reason,
      owner: "codexbridge-update",
      id: randomUUID(),
    });
    try {
      await publishMaintenance(maintenance, marker, maintenanceIO);
      ownedMaintenance = marker;
    } catch (error) {
      if (error.code !== "EEXIST" || !recovery) throw error;
      const existing = await readFile(maintenance, "utf8");
      if (!updateMarker(JSON.parse(existing)))
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
  return {
    save: (state) =>
      atomicJson(path.join(dataDir, "update-status.json"), state),
    current: () => realpath(current).then(releasePath),
    async validateRollback(previous, candidate) {
      await compatibleRelease(previous, true);
      await compatibleRelease(candidate);
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
    hold: () => acquireMaintenance("recovery awaiting health", true),
    async quiesce() {
      await acquireMaintenance("self-update");
      assertQuiescent(await api("operational_summary"));
    },
    async activate(release) {
      await compatibleRelease(release);
      // Also guard direct activation, before replacing the current symlink.
      const previous = await realpath(current).catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      if (previous && previous !== release)
        await compatibleRelease(previous, true);
      await switchCurrent(release);
    },
    async restore(release) {
      // Recovery trusts only the restoration target, never a damaged outgoing release.
      await compatibleRelease(release, true);
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
}
async function main() {
  if (process.platform !== "linux" || process.getuid?.() === 0)
    throw Error("Run only as the Debian service account");
  const root = "/opt/codexbridge",
    data = "/var/lib/codexbridge";
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
