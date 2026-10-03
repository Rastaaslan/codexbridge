import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import {
  AppServerAdapter,
  HumanRequired,
  TransientRuntimeError,
} from "../src/codex.js";
import { git, inside } from "../src/git.js";
import { configSchema } from "../src/config.js";

// Real child processes speak the app-server wire protocol. Failures originate
// at the production adapter boundary, not from injected adapter exceptions.
async function fixture(
  mode: string,
  timeoutMs = 10000,
  readOnly = true,
  resume = false,
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cb-adapter-"));
  let cwd = dir;
  if (!readOnly) {
    const repo = path.join(dir, "repo");
    await mkdir(repo);
    await git(repo, ["init"]);
    await git(repo, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ]);
    cwd = path.join(dir, "worktree");
    await git(repo, ["worktree", "add", "-b", "codexbridge/CB-1", cwd]);
  }
  const wire = path.join(dir, "wire.jsonl");
  const command = path.join(dir, "worker.cjs");
  await writeFile(
    command,
    `#!${process.execPath}
const { createInterface } = require('node:readline');
const { closeSync } = require('node:fs');
const mode = ${JSON.stringify(mode)};
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const keepAlive = setInterval(() => {}, 1000);
process.stdin.on('end', () => {
  if (mode !== 'passage-timeout') { clearInterval(keepAlive); process.exit(0); }
});
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  require("node:fs").appendFileSync(${JSON.stringify(wire)}, JSON.stringify(m) + "\\n");
  if (m.method === 'initialize') {
    if (mode === 'rpc-timeout') return;
    if (mode === 'transport') {
      process.stdin.pause();
      closeSync(0);
    }
    send({ id: m.id, result: {} });
  } else if (m.method === 'config/read') {
    send({ id: m.id, result: { config: { mcp_servers: { external: {} }, plugins: { external: {} } } } });
  } else if ((m.method === 'thread/start' || m.method === 'thread/resume')) {
    send({ id: m.id, result: { thread: { id: 'thread-one' } } });
  } else if (m.method === 'turn/start') {
    send({ id: m.id, result: {} });
    send({ method: 'turn/started', params: { turn: { id: 'turn-one' }, threadId: 'thread-one' } });
    if (mode === 'success') {
      send({ method: 'item/completed', params: { item: { type: 'agentMessage', text: '{"ok":true}' } } });
      send({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
    }
    if (mode === 'signal') process.kill(process.pid, 'SIGKILL');
    if (mode === 'exit') process.exit(1);
    if (mode === 'human') send({ id: 99, method: 'item/tool/requestUserInput', params: { question: 'Choose a product' } });
    if (mode === 'approval') send({ id: 99, method: 'item/commandExecution/requestApproval', params: {} });
    if (mode === 'failure') send({ method: 'turn/completed', params: { turn: { status: 'failed', error: { message: 'ECONNRESET in task text is not a transport error' } } } });
    if (mode === 'invalid') send({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
  }
});
`,
    { mode: 0o700 },
  );
  const config = configSchema.parse({
    dataDir: dir,
    token: "x".repeat(32),
    codexCommand: command,
    timeoutMs,
  });
  const adapter = new AppServerAdapter(config);
  const controller = new AbortController();
  const pids: (number | null)[] = [];
  const events: string[] = [];
  const run = () =>
    adapter.run({
      cwd,
      threadId: resume ? "saved-thread" : undefined,
      prompt: "Test",
      schema: z.strictObject({ ok: z.boolean() }),
      readOnly,
      signal: controller.signal,
      onPid: (pid) => pids.push(pid),
      onThread: () => {},
      onEvent: (type) => {
        events.push(type);
        if (mode === "cancel" && type === "CODEX_TURN_STARTED")
          controller.abort();
      },
    });
  return {
    run,
    cwd,
    wire,
    dir,
    pids,
    events,
    async close() {
      // Also clean up on assertion failure, without touching unrelated processes.
      const pid = pids.at(-1);
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}
function assertCleaned(pids: (number | null)[]) {
  assert.equal(typeof pids[0], "number", "worker was spawned");
  assert.equal(pids.at(-1), null, "adapter confirmed child cleanup");
  assert.throws(() => process.kill(pids[0]!, 0), { code: "ESRCH" });
}

for (const [mode, message] of [
  ["transport", /Worker transport failure: EPIPE/],
  ["signal", /terminated \(SIGKILL\)/],
  ["passage-timeout", /Codex passage timeout/],
] as const) {
  test(
    `adapter classifies ${mode} as transient and reaps its worker`,
    { timeout: 15000 },
    async () => {
      const f = await fixture(mode, mode === "passage-timeout" ? 1000 : 10000);
      try {
        await assert.rejects(
          f.run,
          (e) => e instanceof TransientRuntimeError && message.test(e.message),
        );
        assertCleaned(f.pids);
      } finally {
        await f.close();
      }
    },
  );
}

test(
  "adapter RPC timeout is transient and cleans up the pending process",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture("rpc-timeout", 60000);
    try {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const run = f.run();
      const rejected = assert.rejects(
        run,
        (e) =>
          e instanceof TransientRuntimeError &&
          /RPC timeout: initialize/.test(e.message),
      );
      t.mock.timers.tick(30000);
      // Cleanup runs on real timers; only the 30-second RPC deadline is advanced.
      t.mock.timers.reset();
      await rejected;
      assertCleaned(f.pids);
    } finally {
      t.mock.timers.reset();
      await f.close();
    }
  },
);

for (const [mode, message, human] of [
  ["cancel", /passage interrupted/, false],
  ["human", /requires a decision/, true],
  ["approval", /requires a decision/, true],
  ["failure", /ECONNRESET in task text/, false],
  ["exit", /exited \(1\)/, false],
  ["invalid", /invalid structured output/, false],
] as const) {
  test(
    `adapter ${mode} is not retryable and reaps its worker`,
    { timeout: 15000 },
    async () => {
      const f = await fixture(mode);
      try {
        await assert.rejects(
          f.run,
          (e) =>
            e instanceof Error &&
            !(e instanceof TransientRuntimeError) &&
            e instanceof HumanRequired === human &&
            message.test(e.message),
        );
        assertCleaned(f.pids);
        if (human) assert.ok(f.events.includes("APPROVAL_REQUIRED"));
      } finally {
        await f.close();
      }
    },
  );
}

for (const resume of [false, true])
  test(`ordinary worker least privilege on ${resume ? "resume" : "start"}`, async () => {
    const f = await fixture("success", 10000, false, resume);
    try {
      assert.deepEqual(await f.run(), { ok: true });
      const messages = (await readFile(f.wire, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const thread = messages.find(
        (m) => m.method === (resume ? "thread/resume" : "thread/start"),
      ).params;
      const policy = messages.find((m) => m.method === "turn/start").params
        .sandboxPolicy;
      assert.equal(thread.approvalPolicy, "never");
      assert.equal(
        thread.config["sandbox_workspace_write.network_access"],
        false,
      );
      assert.equal(thread.config["mcp_servers.external.enabled"], false);
      assert.deepEqual(thread.config.plugins, { external: { enabled: false } });
      const gitDir = path.resolve(
        f.cwd,
        await git(f.cwd, ["rev-parse", "--git-dir"]),
      );
      const common = path.resolve(
        f.cwd,
        await git(f.cwd, ["rev-parse", "--git-common-dir"]),
      );
      assert.deepEqual(policy, {
        type: "workspaceWrite",
        writableRoots: [f.cwd, path.join(f.dir, ".npm")],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      });
      assert.deepEqual(
        thread.config["sandbox_workspace_write.writable_roots"],
        policy.writableRoots,
      );
      assert.ok(
        policy.writableRoots.every((root: string) => !inside(root, gitDir)),
      );
      for (const protectedPath of [
        "refs/heads/main",
        "refs/codexbridge/integration/main",
        "packed-refs",
        "config",
        "objects",
      ]) {
        assert.ok(
          policy.writableRoots.every(
            (root: string) => !inside(root, path.join(common, protectedPath)),
          ),
        );
      }
      await writeFile(path.join(f.cwd, "change.txt"), "isolated change");
      assert.match(await git(f.cwd, ["status", "--short"]), /change.txt/);
    } finally {
      await f.close();
    }
  });
test("ordinary worker declines approvals and returns a human decision", async () => {
  const f = await fixture("approval", 10000, false);
  try {
    await assert.rejects(f.run, HumanRequired);
    const messages = (await readFile(f.wire, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(messages.find((m) => m.id === 99).result, {
      decision: "decline",
    });
    assert.ok(!f.events.includes("APPROVAL_GRANTED"));
    assertCleaned(f.pids);
  } finally {
    await f.close();
  }
});
