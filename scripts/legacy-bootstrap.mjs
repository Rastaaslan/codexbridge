// Root-owned Node --import hook. The historical application and its Store remain
// unchanged. Modern releases use their own operational_summary endpoint.
import { createServer } from "node:net";
import { Server } from "node:http";
import { existsSync, unlinkSync, chmodSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { HISTORICAL_V1, historicalIdentity } from "./self-update.mjs";

export function installLegacyBridge(Orchestrator, GitWorkspace, source) {
  let core,
    operations = 0;
  const maintained = () =>
    core && existsSync(path.join(core.config.dataDir, "maintenance.json"));
  // Track promises, not persisted statuses; terminal jobs can still own workers.
  for (const name of ["create", "action", "recover", "report"]) {
    const original = Orchestrator.prototype[name];
    Orchestrator.prototype[name] = async function (...args) {
      core = this;
      if (name !== "recover" && maintained())
        throw Error("Update maintenance in progress");
      operations++;
      try {
        return await original.apply(this, args);
      } finally {
        operations--;
      }
    };
  }
  for (const name of Object.getOwnPropertyNames(GitWorkspace.prototype)) {
    if (name === "constructor") continue;
    const original = GitWorkspace.prototype[name];
    if (typeof original !== "function") continue;
    GitWorkspace.prototype[name] = async function (...args) {
      operations++;
      try {
        return await original.apply(this, args);
      } finally {
        operations--;
      }
    };
  }
  // Freeze ingress at the request boundary. The old router has no global
  // maintenance gate. Already admitted async operations remain counted above.
  const emit = Server.prototype.emit;
  Server.prototype.emit = function (event, ...args) {
    if (
      event === "request" &&
      maintained() &&
      args[0].url !== "/api/tools/server_doctor"
    ) {
      args[1].writeHead(503, { "Content-Type": "application/json" });
      args[1].end('{"error":"Update maintenance in progress"}');
      return true;
    }
    if (event === "request" && core) {
      operations++;
      let finished = false;
      const release = () => {
        if (!finished) {
          finished = true;
          operations--;
        }
      };
      args[1].once("finish", release);
      args[1].once("close", release);
    }
    return emit.call(this, event, ...args);
  };
  const start = Orchestrator.prototype.start;
  Orchestrator.prototype.start = function (...args) {
    core = this;
    const file = path.join(core.config.dataDir, "legacy-updater.sock");
    // Original cli acquired server.lock and rejected any surviving service
    // before calling start. Replacing a stale socket here cannot steal ownership.
    try {
      unlinkSync(file);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    const server = createServer((socket) => {
      try {
        if (!(core.running instanceof Map) || typeof core.ticking !== "boolean")
          throw Error("Unknown historical worker layout");
        let active = 0;
        for (const job of core.store.list()) {
          if (["PREPARING", "CODEX_RUNNING", "REVIEWING"].includes(job.status))
            active++;
          if (job.childPid !== null && job.childPid !== undefined) {
            if (!Number.isSafeInteger(job.childPid) || job.childPid <= 0)
              throw Error("Invalid worker PID");
            try {
              process.kill(job.childPid, 0);
              active++;
            } catch (e) {
              if (e.code !== "ESRCH") active++;
            }
          }
        }
        const used =
          core.running.size +
          active +
          Number(core.ticking) +
          Number(core.restarting) +
          Number(core.stopping);
        socket.end(
          JSON.stringify({
            bootstrap: 1,
            release: source.commit,
            pid: process.pid,
            health: { orchestratorOk: true, maintenance: maintained() },
            scheduler: { runningJobs: core.running.size, usedCapacity: used },
            // These pinned trees have no integration subsystem. All Git/API
            // operations are still tracked so no promises can disappear in counts.
            activeIntegrationOperations: operations,
            integrations: {},
          }),
        );
      } catch {
        socket.end('{"error":"Untrusted historical state"}');
      }
    });
    server.on("error", () => {
      /* Missing evidence makes the updater fail closed. */
    });
    server.listen(file, () => chmodSync(file, 0o600));
    server.unref();
    process.once("exit", () => {
      try {
        unlinkSync(file);
      } catch {}
    });
    return start.apply(this, args);
  };
}

const entry = process.argv[1];
if (entry && path.basename(entry) === "cli.js") {
  const release = await realpath(path.join(path.dirname(entry), ".."));
  const manifest = JSON.parse(
    await readFile(path.join(release, "release.json"), "utf8"),
  );
  if (manifest.sqliteSchema === undefined) {
    if (!HISTORICAL_V1.includes(manifest.commit))
      throw Error("Unreviewed legacy bootstrap target");
    const source = await historicalIdentity(release);
    const { Orchestrator } = await import(
      pathToFileURL(path.join(release, "dist/orchestrator.js"))
    );
    const { GitWorkspace } = await import(
      pathToFileURL(path.join(release, "dist/git.js"))
    );
    installLegacyBridge(Orchestrator, GitWorkspace, source);
  }
}
