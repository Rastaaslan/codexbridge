import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { request } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { Store } from "../src/database.js";
import { GitWorkspace } from "../src/git.js";
import { Orchestrator } from "../src/orchestrator.js";
import { configSchema } from "../src/config.js";
import { createApp } from "../src/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
test("HTTP auth, origin, dashboard and actual MCP handshake/list/call/reconnect", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codexbridge-http-"));
  await mkdir(path.join(dir, "data"));
  const config = configSchema.parse({
    dataDir: path.join(dir, "data"),
    token: "t".repeat(64),
    port: 38479,
  });
  const store = new Store(path.join(config.dataDir, "codexbridge.db"));
  const core = new Orchestrator(
    config,
    store,
    new GitWorkspace(config),
    {
      async run() {
        throw Error("unused");
      },
    },
    {
      async review() {
        throw Error("unused");
      },
    },
  );
  const server = createApp(core).listen(config.port, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${config.port}`;
  try {
    assert.equal(
      (
        await fetch(url + "/api/tools/list_jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(url + "/health", {
          headers: { Origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    const hostStatus = await new Promise<number | undefined>(
      (resolve, reject) => {
        const req = request(
          url + "/health",
          { headers: { Host: "evil.example" } },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        );
        req.on("error", reject);
        req.end();
      },
    );
    assert.equal(hostStatus, 403);
    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /CodexBridge/);
    assert.match(
      page.headers.get("content-security-policy")!,
      /frame-ancestors/,
    );
    for (let i = 0; i < 2; i++) {
      const client = new Client({ name: "integration-test", version: "1" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(url + "/mcp"), {
          requestInit: { headers: { Authorization: "Bearer " + config.token } },
        }),
      );
      const tools = await client.listTools();
      assert.equal(tools.tools.length, 25);
      assert.ok(tools.tools.every((t) => t.outputSchema));
      const scheduler = await client.callTool({
        name: "get_scheduler",
        arguments: {},
      });
      assert.equal(
        (scheduler.structuredContent as any).scheduler.capacity,
        config.maxConcurrentJobs,
      );
      const badAdmission = await client.callTool({
        name: "set_admission",
        arguments: {
          scope: "project",
          target: "PR-999",
          paused: true,
          extra: true,
        },
      });
      assert.equal(badAdmission.isError, true);
      const result = await client.callTool({
        name: "list_jobs",
        arguments: {},
      });
      assert.deepEqual(result.structuredContent, { jobs: [], total: 0 });
      const bad = await client.callTool({
        name: "get_job",
        arguments: { id: "../../etc" },
      });
      assert.equal(bad.isError, true);
      await client.close();
    }
    const schedulerResponse = await fetch(url + "/api/tools/get_scheduler", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + config.token,
      },
      body: "{}",
    });
    assert.equal(schedulerResponse.status, 200);
    assert.equal((await schedulerResponse.json()).scheduler.runningJobs, 0);
    const pausedProject = store.createProject({ name: "Pause via API" });
    const pauseResponse = await fetch(url + "/api/tools/set_admission", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + config.token,
      },
      body: JSON.stringify({
        scope: "project",
        target: pausedProject.id,
        paused: true,
      }),
    });
    assert.equal(pauseResponse.status, 200);
    assert.equal(store.paused("project", pausedProject.id), true);
    await writeFile(
      path.join(config.dataDir, "config.json"),
      JSON.stringify(config),
    );
    const proxy = new Client({ name: "stdio-integration", version: "1" });
    await proxy.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", "src/cli.ts", "mcp-stdio"],
        cwd: process.cwd(),
        env: {
          ...(process.env as Record<string, string>),
          CODEXBRIDGE_HOME: config.dataDir,
        },
        stderr: "pipe",
      }),
    );
    try {
      assert.equal((await proxy.listTools()).tools.length, 25);
      assert.deepEqual(
        (await proxy.callTool({ name: "list_jobs", arguments: {} }))
          .structuredContent,
        { jobs: [], total: 0 },
      );
    } finally {
      await proxy.close();
    }
    await assert.rejects(
      () =>
        promisify(execFile)(
          process.execPath,
          ["--import", "tsx", "src/cli.ts", "start"],
          {
            cwd: process.cwd(),
            windowsHide: true,
            timeout: 10000,
            env: { ...process.env, CODEXBRIDGE_HOME: config.dataDir },
          },
        ),
      /EADDRINUSE/,
    );
    assert.equal(existsSync(path.join(config.dataDir, "server.lock")), false);
    assert.equal(store.list().length, 0);
    const call = async (name: string, body: unknown) => {
      const response = await fetch(url + "/api/tools/" + name, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + config.token,
        },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    const { project } = await call("create_project", { name: "P1" });
    const { feature } = await call("create_feature", {
      name: "DAG",
      projectId: project.id,
    });
    assert.deepEqual((await call("list_projects", {})).projects, [
      pausedProject,
      project,
    ]);
    assert.deepEqual(
      (await call("list_features", { projectId: project.id })).features,
      [feature],
    );
    const { createSchema } = await import("../src/domain.js");
    const parent = store.create(
      createSchema.parse({ title: "Parent", ticket: "Test", repository: dir }),
    );
    const child = store.create(
      createSchema.parse({
        title: "Child",
        ticket: "Test",
        repository: dir,
        featureId: feature.id,
        dependencies: [parent.id],
      }),
    );
    const listing = await call("list_jobs", {
      projectId: project.id,
      schedulingState: "WAITING",
    });
    assert.equal(listing.total, 1);
    assert.equal(listing.jobs[0].id, child.id);
    assert.equal(listing.jobs[0].dependencyStatuses[0].status, "QUEUED");
    const client = new Client({ name: "hierarchy-test", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url + "/mcp"), {
        requestInit: { headers: { Authorization: "Bearer " + config.token } },
      }),
    );
    try {
      const result = await client.callTool({
        name: "get_job",
        arguments: { id: child.id },
      });
      assert.equal((result.structuredContent as any).job.featureId, feature.id);
      assert.equal(
        (result.structuredContent as any).job.schedulingState,
        "WAITING",
      );
    } finally {
      await client.close();
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});
