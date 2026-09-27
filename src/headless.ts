import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, open, unlink, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Orchestrator } from "./orchestrator.js";
import { activeStatuses, errorMessage } from "./domain.js";
import { redact } from "./log.js";
const exec = promisify(execFile);
export const maintenanceFile = (dir: string) =>
  path.join(dir, "maintenance.json");
export function maintenance(dir: string) {
  return existsSync(maintenanceFile(dir));
}
export async function control(action: "restart" | "update") {
  if (process.platform !== "linux" || process.env.CODEXBRIDGE_MANAGED !== "1")
    throw new Error(
      "Managed Debian installation required; no action performed.",
    );
  await exec(
    "/usr/bin/sudo",
    ["-n", "/usr/local/sbin/codexbridge-control", action],
    { timeout: 15000, maxBuffer: 65536 },
  );
}
export function overview(core: Orchestrator) {
  const groups: Record<string, number> = {
    running: 0,
    queued: 0,
    waiting: 0,
    failed: 0,
    readyHumanTest: 0,
    completed: 0,
    cancelled: 0,
  };
  const projects = new Map<string, Record<string, number>>();
  const attention: {
    id: string;
    title: string;
    status: string;
    blocker: string | null;
  }[] = [];
  for (const j of core.store.list()) {
    const group = activeStatuses.includes(j.status)
      ? "running"
      : ["CREATED", "QUEUED", "CHANGES_REQUESTED"].includes(j.status)
        ? "queued"
        : j.status === "WAITING_FOR_HUMAN"
          ? "waiting"
          : j.status === "FAILED"
            ? "failed"
            : ["READY_FOR_HUMAN_TEST", "ACCEPTED"].includes(j.status)
              ? "readyHumanTest"
              : j.status === "CANCELLED"
                ? "cancelled"
                : "completed";
    groups[group]++;
    const p = projects.get(j.repository) ?? {};
    p[group] = (p[group] ?? 0) + 1;
    projects.set(j.repository, p);
    if (
      ["waiting", "failed", "readyHumanTest"].includes(group) &&
      attention.length < 10
    )
      attention.push({
        id: j.id,
        title: j.title,
        status: j.status,
        blocker: j.blocker?.slice(0, 300) ?? null,
      });
  }
  return {
    counts: groups,
    projects: [...projects].map(([repository, counts]) => ({
      repository,
      counts,
    })),
    attention,
  };
}
export async function doctor(core: Orchestrator) {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const check = async (name: string, fn: () => unknown | Promise<unknown>) => {
    try {
      await fn();
      checks.push({ name, ok: true, detail: "ok" });
    } catch (e) {
      checks.push({
        name,
        ok: false,
        detail: redact(errorMessage(e)).slice(0, 300),
      });
    }
  };
  await check("node", () => {
    if (Number(process.versions.node.split(".")[0]) < 24)
      throw Error("Node 24+ required");
  });
  await check("database", () => {
    const result = core.store.db.prepare("PRAGMA quick_check").get();
    if (result?.quick_check !== "ok") throw Error("SQLite quick_check failed");
  });
  await check("git", () =>
    exec("git", ["--version"], { timeout: 5000, windowsHide: true }),
  );
  await check("codexAuth", () =>
    exec(core.config.codexCommand, ["login", "status"], {
      timeout: 10000,
      windowsHide: true,
    }),
  );
  await check("repositories", async () => {
    if (!core.config.repositoryRoots.length)
      throw Error("No repository roots configured");
    for (const root of core.config.repositoryRoots) {
      if (!(await stat(root)).isDirectory())
        throw Error("Missing repository root");
    }
  });
  if (process.env.CODEXBRIDGE_MANAGED === "1")
    await check("tunnel", async () => {
      const { stdout } = await exec(
        process.execPath,
        [
          fileURLToPath(new URL("../scripts/tunnel.mjs", import.meta.url)),
          "status",
        ],
        { timeout: 10000 },
      );
      const state = JSON.parse(stdout);
      if (!state.process_running || !state.healthy || !state.ready)
        throw Error("Tunnel not ready");
    });
  let release: string | null = null;
  try {
    release =
      JSON.parse(
        await readFile(
          fileURLToPath(new URL("../release.json", import.meta.url)),
          "utf8",
        ),
      ).commit ?? null;
  } catch {}
  let update: unknown = null;
  try {
    update = JSON.parse(
      await readFile(
        path.join(core.config.dataDir, "update-status.json"),
        "utf8",
      ),
    );
  } catch {}
  return {
    ok: checks.every((c) => c.ok),
    checks,
    release,
    maintenance: core.restarting || maintenance(core.config.dataDir),
    managed:
      process.platform === "linux" && process.env.CODEXBRIDGE_MANAGED === "1",
    update,
  };
}
export async function recentLogs(core: Orchestrator, limit: number) {
  const file = path.join(
    core.config.dataDir,
    "logs",
    `${new Date().toISOString().slice(0, 10)}.jsonl`,
  );
  let handle;
  try {
    handle = await open(file, "r");
    const { size } = await handle.stat();
    const start = Math.max(0, size - 65536);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start) lines.shift();
    return {
      lines: lines
        .filter(Boolean)
        .slice(-limit)
        .map((s) => redact(s)),
      truncated: start > 0,
    };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      return { lines: [], truncated: false };
    throw e;
  } finally {
    await handle?.close();
  }
}
export async function requestUpdate(core: Orchestrator, ref: string) {
  if (maintenance(core.config.dataDir))
    throw Error("Maintenance in progress; resolve recovery before updating.");
  if (process.platform !== "linux" || process.env.CODEXBRIDGE_MANAGED !== "1")
    throw Error("Managed Debian installation required; no update performed.");
  const file = path.join(core.config.dataDir, "update-request.json");
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify({ ref }));
  } finally {
    await handle.close();
  }
  try {
    await control("update");
  } catch (e) {
    await unlink(file);
    throw e;
  }
  return { accepted: true, ref, statusTool: "server_doctor" };
}
