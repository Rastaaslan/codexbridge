// Manual Debian diagnostic only. Never imported by the production supervisor.
import { readFile, mkdtemp, realpath } from "node:fs/promises";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { linuxRunSpec, runtimeFiles, runtimePid } from "./tunnel-linux.mjs";
import { resolveTunnelBinary, tunnelMcpCommand } from "./tunnel-paths.mjs";

export async function captureHealth(file, read = readFile, request = fetch) {
  const raw = await read(file, "utf8");
  const capture = { urlFile: raw };
  // Preserve the actual file even if it is NOT a plain URL. Do not guess a
  // JSON field, endpoint suffix or readiness schema in this diagnostic.
  try {
    const url = new URL(raw.trim());
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.username ||
      url.password
    )
      throw Error("not a plain loopback HTTP URL");
    const response = await request(url.href, {
      redirect: "error",
      signal: AbortSignal.timeout(3000),
    });
    capture.httpStatus = response.status;
    capture.contentType = response.headers.get("content-type");
    capture.body = await response.text();
  } catch {
    capture.captureError =
      "URL format unrecognized or loopback HTTP request failed; inspect urlFile";
  }
  return capture;
}

export function safeReport(value, secret) {
  const serialized = JSON.stringify(value);
  return secret
    ? serialized.replaceAll(JSON.stringify(secret).slice(1, -1), "[REDACTED]")
    : serialized;
}

// Buffer each stream until close so a key split across chunks is still masked.
// On overflow omit the entire stream: truncating raw text could expose a key
// prefix that no longer matches the complete secret during redaction.
export function captureRuntimeOutput(child, report, limit = 65536) {
  const collect = (stream) => {
    let chunks = [],
      bytes = 0,
      truncated = false;
    stream.on("data", (chunk) => {
      if (truncated) return;
      const data = Buffer.from(chunk);
      bytes += data.length;
      if (bytes > limit) {
        chunks = [];
        truncated = true;
      } else chunks.push(data);
    });
    return () => ({
      text: truncated
        ? "[output omitted: size limit exceeded]"
        : Buffer.concat(chunks).toString("utf8"),
      truncated,
    });
  };
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  return new Promise((resolve) =>
    child.once("close", () => {
      report({ runtimeOutput: { stdout: stdout(), stderr: stderr() } });
      resolve();
    }),
  );
}

async function main() {
  if (process.platform !== "linux")
    throw Error("Run this diagnostic on Debian only");
  const dir = "/var/lib/codexbridge";
  const installed = JSON.parse(
    await readFile(path.join(dir, "tunnel-install.json"), "utf8"),
  );
  if (installed.version !== "v0.0.15")
    throw Error("This capture requires installed v0.0.15");
  const bin = resolveTunnelBinary(installed);
  if (await runtimePid(dir, bin))
    throw Error(
      "Existing tunnel runtime is active; capture requires the tunnel service to be stopped",
    );
  const settings = JSON.parse(
    await readFile(path.join(dir, "tunnel.json"), "utf8"),
  );
  const spec = linuxRunSpec(
    dir,
    settings.tunnelId,
    tunnelMcpCommand({ platform: "linux", managed: "1" }),
  );
  const captureDir = await mkdtemp(path.join(dir, "health-capture-"));
  const files = runtimeFiles(captureDir);
  spec.args[spec.args.indexOf("--health.url-file") + 1] = files.health;
  spec.args[spec.args.indexOf("--pid.file") + 1] = files.pid;
  const report = (value) =>
    console.log(safeReport(value, process.env.CONTROL_PLANE_API_KEY));
  // Never inherit raw logs; report bounded, redacted output after stream close.
  const child = spawn(bin, spec.args, {
    env: spec.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const outputClosed = captureRuntimeOutput(child, report);
  let done = false;
  child.once("error", () => {
    done = true;
    report({ error: "Runtime launch failed" });
  });
  child.once("exit", (code, signal) => {
    done = true;
    report({ exitCode: code, signal });
  });
  const stop = () => {
    done = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  report({
    version: installed.version,
    urlFilePath: files.health,
    durationSeconds: 60,
  });
  try {
    const deadline = Date.now() + 60000;
    while (!done && Date.now() < deadline) {
      try {
        report({
          time: new Date().toISOString(),
          ...(await captureHealth(files.health)),
        });
      } catch {
        report({ time: new Date().toISOString(), awaitingUrlFile: true });
      }
      await delay(1000);
    }
  } finally {
    // Signal only the new process group created by this diagnostic, including
    // its bundled cloudflared. Never use a PID read from disk for cleanup.
    const signalGroup = (signal) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    };
    signalGroup("SIGTERM");
    await delay(1000);
    signalGroup("SIGKILL");
    await outputClosed;
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

// Node resolves the module URL through symlinks, while argv retains "current".
// Canonicalize both paths; a missing import-check argument must remain inert.
const entryPath = process.argv[1]
  ? await realpath(process.argv[1]).catch(() => null)
  : null;
if (
  entryPath &&
  entryPath === (await realpath(fileURLToPath(import.meta.url)))
) {
  main().catch(() => {
    console.error(
      "Capture failed: verify Linux, v0.0.15 installation, stopped tunnel service, local tunnel ID and API key environment. No secret values printed.",
    );
    process.exitCode = 1;
  });
}
