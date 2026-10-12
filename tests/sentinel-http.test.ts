import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { configSchema } from "../src/config.js";
import { Store } from "../src/database.js";
import { createSchema } from "../src/domain.js";
import { GitWorkspace } from "../src/git.js";
import { Orchestrator } from "../src/orchestrator.js";
import { createApp } from "../src/server.js";

test(
  "disposable loopback HTTP: auth, default-off, observation and durable restart",
  {
    timeout: 8000,
    // Explicit opt-in: this acceptance smoke test requires permitted sockets.
    // Never retry a denied bind or substitute a different transport.
    skip: process.env.CODEXBRIDGE_TEST_SENTINEL_HTTP !== "1",
  },
  async (t) => {
    const root = mkdtempSync(path.join(process.cwd(), ".sentinel-http-"));
    const fixtures: Array<Awaited<ReturnType<typeof open>>> = [];
    t.after(async () => {
      for (const fixture of fixtures.reverse()) await fixture.close();
      rmSync(root, { recursive: true });
    });

    async function open(name: string, enabled?: boolean) {
      const dataDir = path.join(root, name);
      mkdirSync(dataDir, { recursive: true });
      const config = configSchema.parse({
        dataDir,
        token: randomBytes(32).toString("hex"),
        ...(enabled === undefined ? {} : { sentinelEnabled: enabled }),
      });
      const store = new Store(path.join(dataDir, "fixture.db"));
      const core = new Orchestrator(
        config,
        store,
        new GitWorkspace(config),
        {
          async run() {
            throw Error("Worker must never run in HTTP smoke test");
          },
        },
        {
          async review() {
            throw Error("Reviewer must never run in HTTP smoke test");
          },
        },
      );
      const server = createServer(createApp(core));
      let closed = false;
      async function close() {
        if (closed) return;
        closed = true;
        server.closeAllConnections();
        if (server.listening)
          await new Promise<void>((resolve, reject) =>
            server.close((e) => (e ? reject(e) : resolve())),
          );
        await core.stop();
        store.close();
      }
      try {
        // A denial is fatal: no retry, alternative bind, or permission escalation.
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
      } catch (error) {
        await close();
        throw error;
      }
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      assert.equal(address.address, "127.0.0.1");
      config.port = address.port; // Match canonical Host checks to the ephemeral port.
      const url = `http://127.0.0.1:${address.port}/api/tools/get_sentinel`;
      async function request(authorization?: string) {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(authorization ? { Authorization: authorization } : {}),
          },
          body: "{}",
          signal: AbortSignal.timeout(2000),
        });
        return { status: response.status, body: await response.json() };
      }
      async function read() {
        const result = await request(`Bearer ${config.token}`);
        assert.equal(result.status, 200);
        assert.equal(JSON.stringify(result.body).includes(config.token), false);
        return result.body;
      }
      const fixture = { store, core, request, read, close };
      fixtures.push(fixture);
      return fixture;
    }

    const disabled = await open("disabled");
    assert.equal((await disabled.request()).status, 401);
    assert.equal(
      (await disabled.request("Bearer intentionally-invalid-token")).status,
      401,
    );
    const off = await disabled.read();
    assert.equal(off.observation, "disabled");
    assert.equal(off.mode, "observe");
    assert.deepEqual(off.summaries, []);
    assert.deepEqual(await disabled.read(), off);
    assert.equal(
      disabled.store.db
        .prepare("SELECT 1 FROM settings WHERE key='sentinel:mini:v0'")
        .get(),
      undefined,
    );
    await disabled.close();

    const enabled = await open("enabled", true);
    assert.equal((await enabled.request()).status, 401);
    const job = enabled.store.create(
      createSchema.parse({
        title: "HTTP fixture",
        ticket: "Synthetic only",
        repository: root,
      }),
    );
    enabled.store.transition(job.id, "FAILED", {
      blocker: 'password="synthetic-private-value"',
    });
    const jobBefore = enabled.store.get(job.id);
    const eventsBefore = enabled.store.events(job.id);
    // Exercise real debounce timers and real HTTP; never start the scheduler.
    await delay(1100);
    const observed = await enabled.read();
    assert.equal(observed.observation, "observing");
    assert.equal(observed.mode, "observe");
    assert.equal(observed.summaries.length, 1);
    assert.equal(observed.summaries[0].jobId, job.id);
    assert.equal(observed.summaries[0].status, "FAILED");
    assert.match(observed.summaries[0].blocker, /REDACTED/);
    assert.doesNotMatch(JSON.stringify(observed), /synthetic-private-value/);
    assert.deepEqual(await enabled.read(), observed);
    assert.deepEqual(enabled.store.get(job.id), jobBefore);
    assert.deepEqual(enabled.store.events(job.id), eventsBefore);
    await enabled.close();

    const restarted = await open("enabled", true);
    assert.equal((await restarted.request()).status, 401);
    assert.deepEqual(await restarted.read(), observed);
    assert.deepEqual(restarted.store.get(job.id), jobBefore);
    assert.deepEqual(restarted.store.events(job.id), eventsBefore);
    t.diagnostic(
      "Genuine HTTP on ephemeral 127.0.0.1 sockets: 401 without/with invalid auth; 200 with synthetic auth; durable restart and unchanged job/events verified.",
    );
  },
);

