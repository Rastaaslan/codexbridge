#!/usr/bin/env node
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setup, loadConfig } from "./config.js";
import { Store } from "./database.js";
import { GitWorkspace } from "./git.js";
import { AppServerAdapter } from "./codex.js";
import { AutomaticReviewer } from "./reviewer.js";
import { Orchestrator, alive } from "./orchestrator.js";
import { createApp } from "./server.js";
import { errorMessage } from "./domain.js";
import { serveStdio } from "./stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const exec = promisify(execFile);
async function main() {
  const [command = "help", id] = process.argv.slice(2);
  if (command === "setup") {
    console.log(
      `Configuration: ${setup()}\nNext: codex login, then codexbridge doctor and codexbridge start.`,
    );
    return;
  }
  if (command === "help") {
    console.log(
      "codexbridge setup | start | stop | doctor | status | jobs | job <CB-id> | report <CB-id> | token | mcp-stdio",
    );
    return;
  }
  const c = loadConfig();
  process.env.CODEXBRIDGE_TOKEN = c.token;
  if (command === "mcp-stdio") {
    await serveStdio(c);
    return;
  }
  const base = `http://127.0.0.1:${c.port}`;
  const call = async (name: string, args: unknown = {}) => {
    const r = await fetch(base + "/api/tools/" + name, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${c.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(15000),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(data));
    return data;
  };
  if (command === "token") {
    console.log(c.token);
    return;
  }
  if (command === "doctor") {
    let failures = 0;
    const check = async (name: string, fn: () => Promise<string> | string) => {
      try {
        console.log(`✓ ${name}: ${await fn()}`);
      } catch (e) {
        failures++;
        console.log(`✗ ${name}: ${errorMessage(e)}`);
      }
    };
    await check("Node", () => {
      if (Number(process.versions.node.split(".")[0]) < 24)
        throw new Error("Node 24+ required");
      return process.version;
    });
    await check("Git", async () =>
      (await exec("git", ["--version"], { windowsHide: true })).stdout.trim(),
    );
    await check("SQLite / database", () => {
      const db = new DatabaseSync(path.join(c.dataDir, "codexbridge.db"));
      const x = db.prepare("PRAGMA quick_check").get();
      db.close();
      return JSON.stringify(x);
    });
    await check("Codex", async () =>
      (
        await exec(c.codexCommand, ["--version"], { windowsHide: true })
      ).stdout.trim(),
    );
    await check("Codex auth", async () => {
      const r = await exec(c.codexCommand, ["login", "status"], {
        windowsHide: true,
        timeout: 15000,
      });
      return (r.stdout + r.stderr).trim();
    });
    await check("OpenAI reviewer", () =>
      c.reviewer === "codex"
        ? "Using separate read-only Codex reviewer"
        : process.env.OPENAI_API_KEY && c.reviewerModel
          ? "API key and model configured (not a network verification)"
          : Promise.reject(
              new Error("OPENAI_API_KEY and reviewerModel required"),
            ),
    );
    await check("Repository roots", async () => {
      if (!c.repositoryRoots.length) throw new Error("No roots configured");
      for (const root of c.repositoryRoots)
        if (!existsSync(root)) throw new Error("Missing " + root);
      return c.repositoryRoots.join(", ");
    });
    await check("Write permissions", () => {
      const file = path.join(c.dataDir, "doctor-write");
      writeFileSync(file, "ok");
      unlinkSync(file);
      return "ok";
    });
    await check("MCP / port", async () => {
      try {
        const r = await fetch(base + "/health", {
          signal: AbortSignal.timeout(2000),
        });
        const x = (await r.json()) as any;
        if (x.name !== "codexbridge")
          throw new Error("Port occupied by another service");
        const client = new Client({
          name: "codexbridge-doctor",
          version: "1.0.0",
        });
        try {
          await client.connect(
            new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
              requestInit: { headers: { Authorization: "Bearer " + c.token } },
            }),
          );
          const tools = await client.listTools();
          if (tools.tools.length < 11)
            throw new Error("MCP tool catalog incomplete");
        } finally {
          await client.close();
        }
        return "MCP handshake authenticated; compatible tool catalog available";
      } catch (e) {
        if (errorMessage(e).includes("fetch failed"))
          return "Server stopped; start it to verify MCP";
        throw e;
      }
    });
    console.log(
      failures ? "Configuration requires attention." : "codexbridge ready.",
    );
    process.exitCode = failures ? 1 : 0;
    return;
  }
  if (command === "jobs" || command === "status") {
    console.log(JSON.stringify(await call("list_jobs"), null, 2));
    return;
  }
  if (command === "job" || command === "report") {
    console.log(
      JSON.stringify(
        await call(command === "job" ? "get_job" : "get_job_report", { id }),
        null,
        2,
      ),
    );
    return;
  }
  if (command === "stop") {
    const r = await fetch(base + "/api/stop", {
      method: "POST",
      headers: { Authorization: `Bearer ${c.token}` },
    });
    if (!r.ok) throw new Error("Stop request failed");
    console.log("Stopping codexbridge.");
    return;
  }
  if (command !== "start") throw new Error("Unknown command");
  mkdirSync(c.dataDir, { recursive: true });
  const lockFile = path.join(c.dataDir, "server.lock");
  if (existsSync(lockFile)) {
    const old = JSON.parse(readFileSync(lockFile, "utf8"));
    if (alive(old.pid))
      throw new Error(`codexbridge already running (PID ${old.pid})`);
    unlinkSync(lockFile);
  }
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid }), {
    flag: "wx",
    mode: 0o600,
  });
  const store = new Store(path.join(c.dataDir, "codexbridge.db"));
  const adapter = new AppServerAdapter(c);
  const core = new Orchestrator(
    c,
    store,
    new GitWorkspace(c),
    adapter,
    new AutomaticReviewer(
      c,
      new AppServerAdapter({ ...c, model: c.reviewerModel ?? c.model }),
    ),
  );
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    server.close();
    await core.stop();
    server.closeAllConnections();
    store.close();
    unlinkSync(lockFile);
  };
  const server = createApp(core, () => void close()).listen(
    c.port,
    c.host,
    () => {
      console.log(
        `CodexBridge running\nDashboard: ${base}\nMCP: ${base}/mcp\nUse codexbridge token to unlock the dashboard.`,
      );
    },
  );
  server.on("error", (e) => {
    console.error(errorMessage(e));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      if (server.listening) resolve();
      else {
        server.once("listening", resolve);
        server.once("error", reject);
      }
    });
    await core.recover();
    core.start();
  } catch (e) {
    await close();
    throw e;
  }
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
}
main().catch((e) => {
  console.error(errorMessage(e));
  process.exitCode = 1;
});
