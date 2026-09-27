import { mkdir, cp, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/database.js";
import { git, GitWorkspace } from "../src/git.js";
import { AppServerAdapter } from "../src/codex.js";
import { AutomaticReviewer } from "../src/reviewer.js";
import { Orchestrator } from "../src/orchestrator.js";
import { createApp } from "../src/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const exec = promisify(execFile);
const base = loadConfig();
try {
  await exec(base.codexCommand, ["login", "status"], { windowsHide: true });
} catch {
  console.error(
    "LIVE E2E BLOCKED: run codex login locally, then rerun npm run test:live. No mock substituted.",
  );
  process.exit(2);
}
const dir = path.join(base.dataDir, "live-e2e", Date.now().toString()),
  repo = path.join(dir, "repository"),
  dataDir = path.join(dir, "state");
await mkdir(dataDir, { recursive: true });
await cp("fixtures/add", repo, { recursive: true });
await git(repo, ["init"]);
await git(repo, ["config", "user.name", "CodexBridge E2E"]);
await git(repo, ["config", "user.email", "e2e@example.invalid"]);
await git(repo, ["add", "."]);
await git(repo, ["commit", "-m", "Intentionally broken addition"]);
const config = { ...base, dataDir, repositoryRoots: [repo], port: 38478 };
let store = new Store(path.join(dataDir, "codexbridge.db"));
const core = new Orchestrator(
  config,
  store,
  new GitWorkspace(config),
  new AppServerAdapter(config),
  new AutomaticReviewer(
    config,
    new AppServerAdapter({
      ...config,
      model: config.reviewerModel ?? config.model,
    }),
  ),
);
const server = createApp(core).listen(config.port, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const client = new Client({ name: "codexbridge-live-e2e", version: "1.0.0" });
await client.connect(
  new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${config.port}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${config.token}` } } },
  ),
);
try {
  const created = await client.callTool({
    name: "create_job",
    arguments: {
      title: "Fix addition",
      ticket:
        "Fix add(a,b) to return the exact sum. Add negative, zero and decimal tests. Run node --test and report actual results.",
      repository: repo,
      acceptanceCriteria: [
        "add(2,2) returns 4",
        "Negative, zero and decimal tests pass",
        "Original main working tree is untouched",
      ],
      options: { maxIterations: 5 },
    },
  });
  assert.ok(!created.isError);
  const job = (created.structuredContent as any).job;
  core.start();
  let last = "";
  const deadline = Date.now() + config.timeoutMs * 6;
  while (Date.now() < deadline) {
    const j = store.get(job.id);
    const current = `${j.status} ${j.iteration}`;
    if (current !== last) {
      console.log(`${j.id} ${current}`);
      last = current;
    }
    if (
      [
        "READY_FOR_HUMAN_TEST",
        "FAILED",
        "WAITING_FOR_HUMAN",
        "CANCELLED",
      ].includes(j.status)
    )
      break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  await core.stop();
  const result = store.get(job.id);
  const report = await client.callTool({
    name: "get_job_report",
    arguments: { id: job.id },
  });
  assert.ok(!report.isError);
  await writeFile(
    path.join(dir, "report.json"),
    JSON.stringify(report.structuredContent, null, 2),
  );
  assert.equal(
    result.status,
    "READY_FOR_HUMAN_TEST",
    result.blocker ?? "Job did not complete",
  );
  const tests = await exec(process.execPath, ["--test"], {
    cwd: result.worktree!,
    windowsHide: true,
    timeout: 30000,
  });
  console.log(tests.stdout);
  assert.equal(await git(repo, ["status", "--porcelain"]), "");
  assert.ok(result.codexThreadId);
  assert.ok((await core.git.diff(result)).changedFiles.includes("add.js"));
  store.close();
  store = new Store(path.join(dataDir, "codexbridge.db"));
  assert.equal(store.get(job.id).status, "READY_FOR_HUMAN_TEST");
  assert.ok(store.reviews(job.id).length > 0);
  console.log(`LIVE E2E PASSED. Evidence: ${path.join(dir, "report.json")}`);
} finally {
  await client.close();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await core.stop();
  store.close();
}
