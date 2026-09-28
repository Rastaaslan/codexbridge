import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  captureHealth,
  safeReport,
  captureRuntimeOutput,
} from "../scripts/capture-tunnel-health.mjs";

test("capture enters main through a current directory symlink, but stays inert when imported", async () => {
  const temporaryRoot = path.resolve(".test-tmp");
  await mkdir(temporaryRoot, { recursive: true });
  const root = await mkdtemp(path.join(temporaryRoot, "capture-entry-"));
  const current = path.join(root, "current");
  await symlink(
    process.cwd(),
    current,
    process.platform === "win32" ? "junction" : "dir",
  );
  const entry = path.join(current, "scripts", "capture-tunnel-health.mjs");
  // Force the unsupported-platform check before any /var/lib reads or runtime
  // launch, even on Linux CI. Reaching this error proves main was invoked.
  const preload =
    "data:text/javascript," +
    encodeURIComponent(
      "Object.defineProperty(process, 'platform', { value: 'win32' });",
    );
  for (const script of [
    path.resolve("scripts/capture-tunnel-health.mjs"),
    entry,
  ]) {
    const result = spawnSync(process.execPath, ["--import", preload, script], {
      encoding: "utf8",
      timeout: 10000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1, `main must run for ${script}`);
    assert.match(result.stderr, /Capture failed:/);
  }
  const imported = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "await import(process.argv[2]);",
      "import-check",
      pathToFileURL(entry).href,
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.ifError(imported.error);
  assert.equal(imported.status, 0);
  assert.equal(imported.stdout, "");
  assert.equal(imported.stderr, "");
});

test("diagnostic preserves URL-file bytes, HTTP status and body without interpreting readiness", async () => {
  for (const status of [200, 503]) {
    const raw = "http://127.0.0.1:43210/custom-health\n";
    const result = await captureHealth(
      "fixture",
      async () => raw,
      async (url: string, options: any) => {
        assert.equal(url, raw.trim());
        assert.equal(options.redirect, "error");
        return new Response("unknown upstream body\n", { status });
      },
    );
    assert.equal(result.urlFile, raw);
    assert.equal(result.httpStatus, status);
    assert.equal(result.body, "unknown upstream body\n");
    assert.equal("ready" in result, false);
  }
});

test("runtime exit 1 before health file preserves stderr and redacts secrets split across writes", async () => {
  const secret = "capture-fixture-sensitive-value";
  const child = spawn(
    process.execPath,
    [
      "-e",
      "process.stdout.write('startup\\n'); process.stderr.write('failure: '+process.env.CAPTURE_TEST_KEY.slice(0,10)); setTimeout(()=>{process.stderr.write(process.env.CAPTURE_TEST_KEY.slice(10)+' missing configuration\\n');process.exitCode=1},10)",
    ],
    {
      env: { ...process.env, CAPTURE_TEST_KEY: secret },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const reports: string[] = [];
  await captureRuntimeOutput(child, (value: unknown) =>
    reports.push(safeReport(value, secret)),
  );
  assert.equal(child.exitCode, 1);
  assert.equal(reports.length, 1);
  const output = JSON.parse(reports[0]).runtimeOutput;
  assert.equal(output.stdout.text, "startup\n");
  assert.equal(
    output.stderr.text,
    "failure: [REDACTED] missing configuration\n",
  );
  assert.equal(reports[0].includes(secret), false);
});

test("oversized runtime output is drained and fully omitted rather than leaking a partial secret", async () => {
  const child = spawn(
    process.execPath,
    ["-e", "process.stderr.write('x'.repeat(100000));"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output: any;
  await captureRuntimeOutput(
    child,
    (value: any) => {
      output = value.runtimeOutput;
    },
    32,
  );
  assert.equal(child.exitCode, 0);
  assert.equal(output.stderr.truncated, true);
  assert.equal(output.stderr.text, "[output omitted: size limit exceeded]");
});

test("capture preserves the reported managed-runtime failure without treating it as ready", async () => {
  // Exact messages supplied by the Debian operator, not a health API fixture.
  const message =
    "cloudflared: fetch managed runtime credentials failed\nHTTP 404: Managed Cloudflare tunnel runtime material not found\n";
  const child = spawn(
    process.execPath,
    [
      "-e",
      "process.stderr.write(process.env.CAPTURE_FAILURE); process.exitCode=1;",
    ],
    {
      env: { ...process.env, CAPTURE_FAILURE: message },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let report: any;
  await captureRuntimeOutput(child, (value: unknown) => {
    report = JSON.parse(safeReport(value, "fixture-key"));
  });
  assert.equal(child.exitCode, 1);
  assert.equal(report.runtimeOutput.stderr.text, message);
  assert.equal(report.runtimeOutput.stderr.truncated, false);
  assert.equal("ready" in report, false);
});

test("diagnostic preserves unknown file formats without fetching and redacts API key", async () => {
  for (const raw of [
    '{"unknown":"format"}',
    "https://example.com/",
    "http://user:password@127.0.0.1/",
  ]) {
    const result = await captureHealth(
      "fixture",
      async () => raw,
      async () => {
        assert.fail("must not fetch");
      },
    );
    assert.equal(result.urlFile, raw);
    assert.ok(result.captureError);
  }
  const secret = 'fixture"key\\value';
  assert.equal(
    JSON.parse(safeReport({ body: `prefix ${secret} suffix` }, secret)).body,
    "prefix [REDACTED] suffix",
  );
});
