import { readFile, readlink, realpath, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

export const runtimeFiles = (dir) => ({
  pid: path.posix.join(dir, "tunnel-runtime.pid"),
  health: path.posix.join(dir, "tunnel-health.url"),
});

export function linuxRunSpec(dir, tunnelId, command, env = process.env) {
  if (!/^tunnel_[a-zA-Z0-9]+$/.test(tunnelId || ""))
    throw Error("Provide a valid tunnel_id");
  if (!env.CONTROL_PLANE_API_KEY)
    throw Error("Configure CONTROL_PLANE_API_KEY before connecting");
  const files = runtimeFiles(dir);
  return {
    args: [
      "run",
      "--control-plane.api-key",
      "env:CONTROL_PLANE_API_KEY",
      "--health.listen-addr",
      "127.0.0.1:0",
      "--health.url-file",
      files.health,
      "--pid.file",
      files.pid,
      "--cloudflared.managed",
    ],
    env: {
      ...env,
      CODEXBRIDGE_HOME: dir,
      CONTROL_PLANE_TUNNEL_ID: tunnelId,
      MCP_COMMAND: command,
    },
  };
}

const system = {
  readFile,
  readlink,
  realpath,
  kill: process.kill.bind(process),
  fetch,
};

// Never signal a PID solely because it appears in a stale file. Require the
// installed executable AND this installation's exact --pid.file argument.
export async function runtimePid(dir, bin, io = system) {
  let text;
  try {
    text = await io.readFile(runtimeFiles(dir).pid, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!/^[1-9][0-9]*\s*$/.test(text)) throw Error("Invalid tunnel PID file");
  const pid = Number(text.trim());
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid)
    throw Error("Unsafe tunnel PID");
  try {
    const exe = await io.readlink(`/proc/${pid}/exe`);
    const args = (await io.readFile(`/proc/${pid}/cmdline`, "utf8")).split(
      "\0",
    );
    const index = args.indexOf("--pid.file");
    if (
      exe !== (await io.realpath(bin)) ||
      index < 0 ||
      args[index + 1] !== runtimeFiles(dir).pid ||
      args[1] !== "run"
    )
      throw Error("Tunnel PID does not belong to this runtime");
    io.kill(pid, 0);
    return pid;
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(error.code)) return null;
    throw error;
  }
}

export async function linuxStatus(dir, bin, io = system, signal) {
  const pid = await runtimePid(dir, bin, io);
  const status = {
    alias: "codexbridge",
    process_running: pid !== null,
    healthy: false,
    ready: false,
    runtime_state: pid ? "running" : "stopped",
    health_url: null,
  };
  if (!pid) return status;
  try {
    const url = new URL(
      (await io.readFile(runtimeFiles(dir).health, "utf8")).trim(),
    );
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.username ||
      url.password
    )
      throw Error("Unsafe tunnel health URL");
    status.health_url = url.href;
    const response = await io.fetch(url.href, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(3000)])
        : AbortSignal.timeout(3000),
      redirect: "error",
    });
    status.healthy = response.ok;
    // Readiness must be explicitly reported; a listening HTTP server alone is
    // not proof of a working tunnel.
    const health = await response.json().catch(() => null);
    status.ready = response.ok && health?.ready === true;
  } catch {
    /* Missing/unavailable health endpoint is not healthy or ready. */
  }
  return status;
}

export async function linuxStop(dir, bin, io = system) {
  const pid = await runtimePid(dir, bin, io);
  if (pid !== null) {
    try {
      io.kill(pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}

// Keep the runtime in the foreground so systemd owns its lifetime and restarts
// it on exit. Forward shutdown to the child, never create an orphaned daemon.
export function foreground(
  command,
  args,
  env,
  launch = spawn,
  {
    checkHealth,
    startupGraceMs = 60000,
    pollMs = 10000,
    failuresBeforeStop = 3,
    probeTimeoutMs = 5000,
    shutdownTimeoutMs = 10000,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const child = launch(command, args, {
      env,
      stdio: "inherit",
      windowsHide: true,
    });
    let stopping = false,
      finished = false,
      healthFailed = false,
      failures = 0;
    let pollTimer, probeTimer, shutdownTimer, probe;
    const stop = (signal) => {
      if (stopping || finished) return;
      stopping = true;
      clearTimeout(pollTimer);
      probe?.abort();
      shutdownTimer = setTimeout(() => {
        if (!finished) child.kill("SIGKILL");
      }, shutdownTimeoutMs);
      child.kill(signal);
    };
    const term = () => stop("SIGTERM");
    const interrupt = () => stop("SIGINT");
    const cleanup = () => {
      finished = true;
      clearTimeout(pollTimer);
      clearTimeout(probeTimer);
      clearTimeout(shutdownTimer);
      probe?.abort();
      process.off("SIGTERM", term);
      process.off("SIGINT", interrupt);
    };
    const poll = async () => {
      if (stopping || finished) return;
      probe = new AbortController();
      let healthy = false;
      try {
        const status = await Promise.race([
          Promise.resolve().then(() => checkHealth(probe.signal)),
          new Promise((_, reject) => {
            probeTimer = setTimeout(() => {
              probe.abort();
              reject(Error("Tunnel health probe timed out"));
            }, probeTimeoutMs);
          }),
        ]);
        healthy =
          status?.process_running === true &&
          status?.healthy === true &&
          status?.ready === true;
      } catch {
        /* A failed or timed-out probe counts as unhealthy. */
      } finally {
        clearTimeout(probeTimer);
      }
      if (stopping || finished) return;
      failures = healthy ? 0 : failures + 1;
      if (failures >= failuresBeforeStop) {
        healthFailed = true;
        stop("SIGTERM");
      } else pollTimer = setTimeout(poll, pollMs);
    };
    process.on("SIGTERM", term);
    process.on("SIGINT", interrupt);
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      resolve(healthFailed ? 1 : (code ?? (signal === "SIGTERM" ? 0 : 1)));
    });
    if (checkHealth) pollTimer = setTimeout(poll, startupGraceMs);
  });
}

export async function linuxAction(action, { dir, bin, tunnelId, command }) {
  if (action === "setup") return 0; // tunnel.json was persisted by the caller.
  if (action === "status") {
    console.log(JSON.stringify(await linuxStatus(dir, bin), null, 2));
    return 0;
  }
  if (action === "stop") {
    await linuxStop(dir, bin);
    return 0;
  }
  if (action === "help") return foreground(bin, ["run", "--help"], process.env);
  if (action !== "connect")
    throw Error("Use setup <tunnel_id>, connect, status, stop or help");
  const spec = linuxRunSpec(dir, tunnelId, command);
  if (await runtimePid(dir, bin)) throw Error("Tunnel runtime already running");
  for (const file of Object.values(runtimeFiles(dir)))
    await rm(file, { force: true });
  return foreground(bin, spec.args, spec.env, spawn, {
    checkHealth: (signal) => linuxStatus(dir, bin, system, signal),
  });
}
