import { mkdir, cp, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { git } from "../src/git.js";
import { alive } from "../src/orchestrator.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const exec = promisify(execFile),
  base = loadConfig();
await exec(base.codexCommand, ["login", "status"], { windowsHide: true });
const dir = path.join(base.dataDir, "live-recovery", String(Date.now())),
  repo = path.join(dir, "repository"),
  dataDir = path.join(dir, "state");
await mkdir(dataDir, { recursive: true });
await cp("fixtures/add", repo, { recursive: true });
await git(repo, ["init"]);
await git(repo, ["config", "user.name", "CodexBridge E2E"]);
await git(repo, ["config", "user.email", "e2e@example.invalid"]);
await git(repo, ["add", "."]);
await git(repo, ["commit", "-m", "Broken fixture"]);
const config = { ...base, dataDir, repositoryRoots: [repo], port: 38476 };
await writeFile(path.join(dataDir, "config.json"), JSON.stringify(config), {
  mode: 0o600,
});
let child: ChildProcess | undefined, client: Client | undefined;
const url = `http://127.0.0.1:${config.port}`;
async function start() {
  child = spawn(process.execPath, ["dist/cli.js", "start"], {
    cwd: process.cwd(),
    windowsHide: true,
    env: { ...process.env, CODEXBRIDGE_HOME: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (x) => process.stdout.write(x));
  child.stderr?.on("data", (x) => process.stderr.write(x));
  for (let n = 0; n < 100; n++) {
    try {
      if ((await fetch(url + "/health")).ok) break;
    } catch {}
    if (child.exitCode !== null) throw Error("Server exited");
    await new Promise((r) => setTimeout(r, 100));
  }
  client = new Client({ name: "codexbridge-recovery-e2e", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url + "/mcp"), {
      requestInit: { headers: { Authorization: "Bearer " + config.token } },
    }),
  );
}
async function call(name: string, args: any) {
  const r = await client!.callTool({ name, arguments: args });
  if (r.isError) throw Error(JSON.stringify(r.content));
  return r.structuredContent as any;
}
async function wait(id: string) {
  let last = "";
  for (let n = 0; n < 1800; n++) {
    const { job } = await call("get_job", { id });
    if (last !== job.status) {
      console.log(job.id, job.status, job.iteration);
      last = job.status;
    }
    if (
      ["READY_FOR_HUMAN_TEST", "FAILED", "WAITING_FOR_HUMAN"].includes(
        job.status,
      )
    )
      return job;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw Error("Live recovery timeout");
}
try {
  await start();
  const { job } = await call("create_job", {
    title: "Recovery of real Codex work",
    ticket:
      "Fix add(a,b) and add tests for negatives, zero and decimals. Run node --test.",
    repository: repo,
    acceptanceCriteria: ["Correct addition", "Meaningful tests pass"],
    options: { maxIterations: 5 },
  });
  let saved: any;
  for (let n = 0; n < 300; n++) {
    saved = (await call("get_job", { id: job.id })).job;
    const { events } = await call("get_job_events", { id: job.id });
    if (events.some((e: any) => e.type === "CODEX_TURN_STARTED")) break;
    if (saved.status === "FAILED") throw Error(saved.blocker);
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(saved.codexThreadId);
  assert.equal(saved.status, "CODEX_RUNNING");
  const workerPid = saved.childPid;
  console.log("Killing service during real turn:", job.id, saved.codexThreadId);
  await client!.close();
  const exited = new Promise<void>((r) => child!.once("exit", () => r()));
  child!.kill("SIGKILL");
  await exited;
  for (let n = 0; n < 100 && alive(workerPid); n++)
    await new Promise((r) => setTimeout(r, 200));
  await start();
  let recovered = (await call("get_job", { id: job.id })).job;
  for (let n = 0; n < 100 && recovered.status === "CODEX_RUNNING"; n++) {
    await new Promise((r) => setTimeout(r, 100));
    recovered = (await call("get_job", { id: job.id })).job;
  }
  assert.equal(recovered.status, "FAILED");
  assert.equal(recovered.codexThreadId, saved.codexThreadId);
  assert.equal(recovered.worktree, saved.worktree);
  assert.equal(
    alive(workerPid),
    false,
    "Previous app-server is still alive; safe retry refused",
  );
  await call("retry_job", { id: job.id });
  const resumed = await wait(job.id);
  assert.equal(resumed.status, "READY_FOR_HUMAN_TEST", resumed.blocker);
  assert.equal(resumed.codexThreadId, saved.codexThreadId);
  await call("reject_job", {
    id: job.id,
    instruction:
      "Add a regression test for add(-0.5, 0.25) returning -0.25. Preserve the existing tests, rerun node --test, and report the outcome.",
  });
  const corrected = await wait(job.id);
  assert.equal(corrected.status, "READY_FOR_HUMAN_TEST", corrected.blocker);
  assert.equal(corrected.codexThreadId, saved.codexThreadId);
  const tested = await exec(process.execPath, ["--test"], {
    cwd: corrected.worktree,
    windowsHide: true,
    timeout: 30000,
  });
  console.log(tested.stdout);
  assert.equal(await git(repo, ["status", "--porcelain"]), "");
  assert.equal(
    (await git(repo, ["worktree", "list", "--porcelain"])).split("worktree ")
      .length - 1,
    2,
  );
  const report = await call("get_job_report", { id: job.id });
  await writeFile(
    path.join(dir, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    "LIVE RECOVERY + SAME THREAD CORRECTION PASSED:",
    path.join(dir, "report.json"),
  );
} finally {
  await client?.close();
  if (child?.exitCode === null) {
    try {
      await fetch(url + "/api/stop", {
        method: "POST",
        headers: { Authorization: "Bearer " + config.token },
      });
    } catch {
      child.kill();
    }
  }
}
