import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  captureHealth,
  safeReport,
  captureRuntimeOutput,
} from "../scripts/capture-tunnel-health.mjs";

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
