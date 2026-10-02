import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import {
  AppServerAdapter,
  HumanRequired,
  TransientRuntimeError,
} from "../src/codex.js";
import { configSchema } from "../src/config.js";

// Real child processes speak the app-server wire protocol. Failures originate
// at the production adapter boundary, not from injected adapter exceptions.
async function fixture(mode: string, timeoutMs = 10000) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cb-adapter-"));
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
  if (m.method === 'initialize') {
    if (mode === 'rpc-timeout') return;
    if (mode === 'transport') {
      process.stdin.pause();
      closeSync(0);
    }
    send({ id: m.id, result: {} });
  } else if (m.method === 'config/read') {
    send({ id: m.id, result: { config: {} } });
  } else if (m.method === 'thread/start') {
    send({ id: m.id, result: { thread: { id: 'thread-one' } } });
  } else if (m.method === 'turn/start') {
    send({ id: m.id, result: {} });
    send({ method: 'turn/started', params: { turn: { id: 'turn-one' }, threadId: 'thread-one' } });
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
      cwd: dir,
      prompt: "Test",
      schema: z.strictObject({ ok: z.boolean() }),
      readOnly: true,
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
