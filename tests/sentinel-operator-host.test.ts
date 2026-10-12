import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { configSchema } from "../src/config.js";
import { hash } from "../src/sentinel-dev.js";
import { operatorSentinelHost, pressureAllows } from "../src/sentinel-operator-host.js";
import { signedBundleMessage, sourceProvenanceBytes } from "../src/sentinel-trust.js";

test("resource gate fails closed on high disk, CPU, low memory or missing telemetry", () => {
  const cpu = "some avg10=0.5 avg60=0 avg300=0 total=0\nfull avg10=0 avg60=0 avg300=0 total=0";
  const io = "some avg10=9 avg60=0 avg300=0 total=0\nfull avg10=2.1 avg60=0 avg300=0 total=0";
  const memory = "MemAvailable:    6418408 kB\n";
  assert.equal(pressureAllows(cpu, io, memory), true);
  assert.equal(pressureAllows(cpu.replace("0.5", "10.0"), io, memory), false);
  assert.equal(pressureAllows(cpu, io.replace("full avg10=2.1", "full avg10=8.0"), memory), false);
  assert.equal(pressureAllows(cpu, io, "MemAvailable:    2000000 kB\n"), false);
  assert.equal(pressureAllows("", io, memory), false);
});

test("ordinary service cannot construct a trust host without separate operator opt-in", () => {
  const config = configSchema.parse({
    dataDir: "/tmp/sentinel-disabled-fixture",
    token: "x".repeat(32),
    sentinelExecutionEnabled: false,
  });
  let calls = 0;
  const git = { repository: async (s: string) => { calls++; return s; }, resolve: async () => { calls++; return "a".repeat(40); } };
  const result = operatorSentinelHost(config, git, () => { calls++; return true; }, {}, () => { calls++; return true; });
  assert.equal(result, undefined);
  assert.equal(calls, 0);
});

test("signed operator bootstrap is opt-in and revocation/resource gates remain live", { skip: process.platform !== "linux" }, async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "sentinel-operator-fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const repository = path.join(root, "repo");
  mkdirSync(dataDir);
  mkdirSync(repository);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const keyPath = path.join(root, "public.pem");
  const bundlePath = path.join(root, "bundle.json");
  writeFileSync(keyPath, pem);
  const source = { repository, sourceRef: "refs/heads/main", baseCommit: "a".repeat(40) };
  const grant = {
    permission: "automatic-code-fix" as const,
    taskId: "fix-one",
    policyHash: "c".repeat(64),
    repository,
    sourceRef: source.sourceRef,
    baseCommit: source.baseCommit,
    provenanceHash: hash(sourceProvenanceBytes(source)),
    ticketHash: "d".repeat(64),
    expiresAt: Date.now() + 600000,
  };
  const payload = { version: 1 as const, grants: [{ grant, provenance: source }] };
  const put = () => writeFileSync(bundlePath, JSON.stringify({
    payload,
    signature: sign(null, signedBundleMessage(payload), privateKey).toString("base64"),
  }));
  put();
  const config = configSchema.parse({
    dataDir,
    token: "x".repeat(32),
    sentinelExecutionEnabled: true,
    sentinelEnabled: true,
    maxRuntimeRetries: 0,
    sentinelDevPolicy: {
      id: "test",
      enabled: true,
      repository,
      source: { baseCommit: source.baseCommit, provenanceHash: grant.provenanceHash, approvedBy: "operator" },
      budget: 1,
      concurrency: 1,
      cooldownMs: 60000,
      tasks: [{ id: "fix-one", operation: "code-fix", ticket: "Safe fixture", ticketHash: hash("Safe fixture"), dependencies: ["CB-1"], requiredEvidence: [] }],
    },
  });
  const env = {
    CODEXBRIDGE_SENTINEL_OPERATOR_OPT_IN: "1",
    CODEXBRIDGE_SENTINEL_GRANTS_FILE: bundlePath,
    CODEXBRIDGE_SENTINEL_PUBLIC_KEY_FILE: keyPath,
    CODEXBRIDGE_SENTINEL_PUBLIC_KEY_SHA256: hash(pem),
    CODEXBRIDGE_SENTINEL_REPOSITORIES_JSON: JSON.stringify([repository]),
  };
  let admissions = 0;
  let okay = true;
  const git = {
    repository: async (input: string) => input,
    resolve: async (_repository: string, ref: string) => ref === source.sourceRef || ref === source.baseCommit ? source.baseCommit : "f".repeat(40),
  };
  assert.equal(operatorSentinelHost(config, git, () => true, { ...env, CODEXBRIDGE_SENTINEL_OPERATOR_OPT_IN: "0" }), undefined);
  assert.equal(operatorSentinelHost(config, git, () => true, { ...env, CODEXBRIDGE_SENTINEL_PUBLIC_KEY_SHA256: "f".repeat(64) }), undefined);
  const host = operatorSentinelHost(config, git, () => { admissions++; return true; }, env, () => okay);
  assert.ok(host);
  assert.deepEqual(await host.authorize("fix-one"), grant);
  assert.equal(await host.verifySource(grant), true);
  assert.equal(host.revalidateGrant?.(grant), true);
  assert.equal(host.schedulerAllows(repository), true);
  okay = false;
  assert.equal(host.schedulerAllows(repository), false);
  assert.equal(admissions, 1);
  rmSync(bundlePath);
  assert.equal(host.revalidateGrant?.(grant), false);
  assert.equal(await host.authorize("fix-one"), null);
});
