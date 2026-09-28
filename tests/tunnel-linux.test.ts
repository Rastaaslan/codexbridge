import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import {
  linuxRunSpec,
  linuxStatus,
  linuxStop,
  runtimeFiles,
  foreground,
  linuxAction,
} from "../scripts/tunnel-linux.mjs";

const dir = "/var/lib/codexbridge";
const bin = `${dir}/bin/tunnel-client-v0.0.15/tunnel-client-runtime-cloudflared`;
const command =
  '"/usr/bin/node" "/opt/codexbridge/current/dist/cli.js" mcp-stdio';
const missing = () => Object.assign(Error("missing"), { code: "ENOENT" });
// Synthetic plumbing fixture, NOT captured v0.0.15 health-contract evidence.
// Authoritative URL-file and readiness fixtures are still required by review.
function mockRuntime({
  pid = "424242",
  executable = bin,
  args = [bin, "run", "--pid.file", runtimeFiles(dir).pid],
  url = "http://127.0.0.1:12345",
  alive = true,
  ready = true,
  ok = true,
} = {}) {
  const signals: unknown[] = [];
  const requests: unknown[] = [];
  return {
    signals,
    requests,
    readFile: async (file: string) => {
      if (file === runtimeFiles(dir).pid) return pid;
      if (file === runtimeFiles(dir).health) return url;
      if (file === "/proc/424242/cmdline") return args.join("\0");
      throw missing();
    },
    readlink: async () => {
      if (!alive) throw missing();
      return executable;
    },
    realpath: async () => bin,
    kill: (pid: number, signal: unknown) => signals.push([pid, signal]),
    fetch: async (url: string, options: unknown) => {
      requests.push([url, options]);
      if (url.endsWith("/healthz"))
        return new Response(ok ? "live" : "unhealthy", {
          status: ok ? 200 : 503,
        });
      if (url.endsWith("/readyz"))
        return new Response(ready ? "ready" : "not ready", {
          status: ok && ready ? 200 : 503,
        });
      throw Error("unexpected health route");
    },
  };
}

test('Linux run contract avoids unknown command "runtimes" and keeps secrets out of arguments', () => {
  const spec = linuxRunSpec(dir, "tunnel_example", command, {
    CONTROL_PLANE_API_KEY: "fixture-key",
  });
  // Reproduce the verified runtime's rejection of the old CLI contract.
  const runtime = (args: string[]) => {
    if (args[0] !== "run")
      throw Error(
        `unknown command "${args[0]}" for "tunnel-client-runtime-cloudflared"`,
      );
  };
  assert.throws(
    () => runtime(["runtimes", "connect"]),
    /unknown command "runtimes"/,
  );
  assert.doesNotThrow(() => runtime(spec.args));
  assert.deepEqual(spec.args, [
    "run",
    "--control-plane.api-key",
    "env:CONTROL_PLANE_API_KEY",
    "--health.listen-addr",
    "127.0.0.1:0",
    "--health.url-file",
    `${dir}/tunnel-health.url`,
    "--pid.file",
    `${dir}/tunnel-runtime.pid`,
  ]);
  assert.ok(!spec.args.includes("--cloudflared.managed"));
  assert.equal(spec.env.CONTROL_PLANE_TUNNEL_ID, "tunnel_example");
  assert.equal(spec.env.MCP_COMMAND, command);
  assert.ok(!spec.args.join(" ").includes("fixture-key"));
  assert.throws(
    () => linuxRunSpec(dir, "tunnel_example", command, {}),
    /CONTROL_PLANE_API_KEY/,
  );
  assert.throws(() => linuxRunSpec(dir, "invalid", command, {}), /tunnel_id/);
});

test("Linux status combines owned PID with loopback health, without CLI calls", async () => {
  const io = mockRuntime();
  const status = await linuxStatus(dir, bin, io);
  assert.equal(status.process_running, true);
  assert.equal(status.healthy, true);
  assert.equal(status.ready, true);
  assert.deepEqual(
    io.requests.map(([url]) => url),
    [
      "http://127.0.0.1:12345/healthz",
      "http://127.0.0.1:12345/readyz",
    ],
  );
  for (const options of [
    { alive: false },
    { ok: false },
    { ready: false },
    { url: "https://example.com" },
    { url: "http://127.0.0.1@evil.test" },
  ]) {
    const io = mockRuntime(options);
    assert.equal((await linuxStatus(dir, bin, io)).ready, false);
    if (options.url || options.alive === false)
      assert.equal(io.requests.length, 0);
  }
  const absent = mockRuntime();
  absent.readFile = async () => {
    throw missing();
  };
  assert.equal((await linuxStatus(dir, bin, absent)).process_running, false);
});

test("Linux stop signals only a matching runtime; stale, foreign and unsafe PIDs are never killed", async () => {
  const io = mockRuntime();
  await linuxStop(dir, bin, io);
  assert.deepEqual(io.signals, [
    [424242, 0],
    [424242, "SIGTERM"],
  ]);
  const stale = mockRuntime({ alive: false });
  await linuxStop(dir, bin, stale);
  assert.deepEqual(stale.signals, []);
  for (const options of [
    { pid: "-1" },
    { pid: "1" },
    { pid: "not-a-pid" },
    { executable: "/usr/bin/node" },
    { args: [bin, "run", "--pid.file", "/other/runtime.pid"] },
  ]) {
    const io = mockRuntime(options);
    await assert.rejects(linuxStop(dir, bin, io));
    assert.deepEqual(io.signals, []);
  }
});

test("foreground supervision waits for exit, forwards shutdown, and propagates launch failures", async () => {
  const child = new EventEmitter() as EventEmitter & {
    kill: (signal: string) => void;
  };
  const signals: string[] = [];
  child.kill = (signal) => {
    signals.push(signal);
  };
  const count = process.listenerCount("SIGTERM");
  const result = foreground(
    bin,
    ["run"],
    {},
    (_bin: string, args: string[], options: any) => {
      assert.deepEqual(args, ["run"]);
      assert.equal(options.stdio, "inherit");
      assert.equal(options.shell, undefined);
      return child;
    },
  );
  process.emit("SIGTERM");
  assert.deepEqual(signals, ["SIGTERM"]);
  child.emit("exit", 7, null);
  assert.equal(await result, 7);
  assert.equal(process.listenerCount("SIGTERM"), count);
  const failed = foreground(bin, ["run"], {}, () => child);
  child.emit("error", Error("spawn failed"));
  await assert.rejects(failed, /spawn failed/);
});

test("Linux setup avoids init; supervisor bypasses old daemon timeout and Windows retains runtimes", async () => {
  assert.equal(
    await linuxAction("setup", {
      dir,
      bin,
      tunnelId: "tunnel_example",
      command,
    }),
    0,
  );
  const entry = await readFile("scripts/tunnel.mjs", "utf8");
  assert.match(entry, /process.platform === "linux"[\s\S]*linuxAction/);
  assert.match(entry, /else \{[\s\S]*"runtimes",\s+"connect"/);
  const supervisor = await readFile("scripts/tunnel-supervisor.mjs", "utf8");
  assert.match(
    supervisor,
    /process.platform === "linux"[\s\S]*await foreground\([\s\S]*\[script, "connect"\]/,
  );
});

test("a live persistently unhealthy child is terminated after grace and consecutive failures", async () => {
  const child = new EventEmitter() as EventEmitter & {
    kill: (signal: string) => void;
  };
  const signals: string[] = [];
  let probes = 0;
  child.kill = (signal) => {
    signals.push(signal);
    // Simulate a stuck runtime that ignores graceful shutdown.
    if (signal === "SIGKILL") child.emit("exit", null, signal);
  };
  const listeners = process.listenerCount("SIGTERM");
  const result = foreground(bin, ["run"], {}, () => child, {
    startupGraceMs: 30,
    pollMs: 1,
    failuresBeforeStop: 3,
    shutdownTimeoutMs: 5,
    checkHealth: async () => {
      probes++;
      return { process_running: true, healthy: false, ready: false };
    },
  });
  assert.equal(probes, 0, "startup grace must not probe immediately");
  assert.deepEqual(signals, []);
  assert.equal(await result, 1);
  assert.equal(probes, 3);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(process.listenerCount("SIGTERM"), listeners);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(probes, 3, "exit must remove polling timers");
});

test("a successful probe resets consecutive failures and unready counts as failure", async () => {
  const child = new EventEmitter() as EventEmitter & {
    kill: (signal: string) => void;
  };
  child.kill = (signal) => child.emit("exit", 0, signal);
  let probes = 0;
  const result = foreground(bin, ["run"], {}, () => child, {
    startupGraceMs: 0,
    pollMs: 1,
    failuresBeforeStop: 2,
    checkHealth: async () => ({
      process_running: true,
      healthy: true,
      ready: ++probes === 2,
    }),
  });
  assert.equal(await result, 1);
  assert.equal(probes, 4);
});

test("hung health probes are bounded and shutdown cancels monitoring", async () => {
  const child = new EventEmitter() as EventEmitter & {
    kill: (signal: string) => void;
  };
  const signals: string[] = [];
  child.kill = (signal) => {
    signals.push(signal);
    child.emit("exit", null, signal);
  };
  let probeSignal: AbortSignal | undefined;
  const result = foreground(bin, ["run"], {}, () => child, {
    startupGraceMs: 0,
    failuresBeforeStop: 1,
    probeTimeoutMs: 5,
    checkHealth: (signal: AbortSignal) => {
      probeSignal = signal;
      return new Promise(() => {});
    },
  });
  assert.equal(await result, 1);
  assert.equal(probeSignal?.aborted, true);
  assert.deepEqual(signals, ["SIGTERM"]);

  let probes = 0;
  const stopped = foreground(bin, ["run"], {}, () => child, {
    startupGraceMs: 5,
    checkHealth: async () => {
      probes++;
      throw Error("unavailable");
    },
  });
  process.emit("SIGTERM");
  assert.equal(await stopped, 0);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(probes, 0);
  assert.deepEqual(signals, ["SIGTERM", "SIGTERM"]);
});
