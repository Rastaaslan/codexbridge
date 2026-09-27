import { test } from "node:test";
import assert from "node:assert/strict";
import {
  captureHealth,
  safeReport,
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
