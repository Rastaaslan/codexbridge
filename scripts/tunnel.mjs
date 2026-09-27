import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveTunnelBinary, tunnelMcpCommand } from "./tunnel-paths.mjs";
const dir = path.resolve(process.env.CODEXBRIDGE_HOME || ".codexbridge");
const installed = JSON.parse(
  readFileSync(path.join(dir, "tunnel-install.json"), "utf8"),
);
const bin = resolveTunnelBinary(installed);
const [action = "status", id] = process.argv.slice(2),
  file = path.join(dir, "tunnel.json");
const profileDir = path.join(dir, "tunnel-profiles");
mkdirSync(profileDir, { recursive: true });
if (action === "setup") {
  if (!/^tunnel_[a-zA-Z0-9]+$/.test(id || ""))
    throw Error("Provide a valid tunnel_id");
  writeFileSync(file, JSON.stringify({ tunnelId: id }, null, 2));
}
const settings = JSON.parse(readFileSync(file, "utf8"));
const command = tunnelMcpCommand();
let args;
if (action === "setup")
  args = [
    "init",
    "--sample",
    "sample_mcp_stdio_local",
    "--profile",
    "codexbridge",
    "--profile-dir",
    profileDir,
    "--tunnel-id",
    settings.tunnelId,
    "--mcp-command",
    command,
    "--health-listen-addr",
    "127.0.0.1:0",
  ];
else if (action === "connect") {
  if (!process.env.CONTROL_PLANE_API_KEY)
    throw Error(
      "Configure CONTROL_PLANE_API_KEY in the local .env before connecting.",
    );
  args = [
    "runtimes",
    "connect",
    "--alias",
    "codexbridge",
    "--profile",
    "codexbridge",
    "--profile-dir",
    profileDir,
    "--tunnel-id",
    settings.tunnelId,
    "--mcp-command",
    command,
    "--runtime-api-key",
    "env:CONTROL_PLANE_API_KEY",
    "--json",
  ];
} else if (action === "status")
  args = ["runtimes", "status", "codexbridge", "--json"];
else if (action === "stop")
  args = ["runtimes", "stop", "codexbridge", "--json"];
else if (action === "help") args = ["help", "quickstart"];
else throw Error("Use setup <tunnel_id>, connect, status, stop or help");
const result = spawnSync(bin, args, {
  windowsHide: true,
  encoding: "utf8",
  maxBuffer: 4 * 1024 * 1024,
  env: { ...process.env, CODEXBRIDGE_HOME: dir },
});
if (result.error) throw result.error;
if (["connect", "status"].includes(action) && result.status === 0) {
  const s = JSON.parse(result.stdout);
  console.log(
    JSON.stringify(
      {
        alias: s.alias,
        process_running: s.process_running,
        healthy: s.healthy,
        ready: s.ready,
        runtime_state: s.runtime_state,
        health_url: s.health_url,
        ui_url: s.ui_url,
        remote_error: s.remote_error,
      },
      null,
      2,
    ),
  );
} else {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}
process.exitCode = result.status ?? 1;
