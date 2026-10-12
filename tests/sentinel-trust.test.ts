import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, symlinkSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  signedBundleMessage,
  signedFileSentinelHost,
  sourceProvenanceBytes,
} from "../src/sentinel-trust.js";
import { hash } from "../src/sentinel-dev.js";
import type { ExecutionGrant } from "../src/sentinel-executor.js";

function fixture(t: Parameters<typeof test>[1] extends (...args: infer A) => any ? A[0] : never) {
  const dir = mkdtempSync(path.join(tmpdir(), "sentinel-trust-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const bundlePath = path.join(dir, "operator-grants.json");
  const repository = path.join(dir, "repository");
  const sourceRef = "refs/heads/worldprep";
  const baseCommit = "a".repeat(40);
  const provenance = { repository, baseCommit, sourceRef };
  const grant: ExecutionGrant = {
    permission: "automatic-code-fix",
    taskId: "fix-1",
    policyHash: "b".repeat(64),
    repository,
    sourceRef,
    baseCommit,
    provenanceHash: hash(sourceProvenanceBytes(provenance)),
    ticketHash: "c".repeat(64),
    expiresAt: 1000000,
  };
  const payload = { version: 1 as const, grants: [{ grant, provenance }] };
  const signed = (value: typeof payload = payload) => ({
    payload: value,
    signature: sign(null, signedBundleMessage(value), privateKey).toString("base64"),
  });
  const publish = (value: unknown) => writeFileSync(bundlePath, JSON.stringify(value));
  publish(signed());
  let checked = 0;
  const git = {
    async repository(input: string) {
      checked++;
      return input;
    },
    async resolve(_repo: string, ref: string) {
      checked++;
      return ref === sourceRef || ref === baseCommit ? baseCommit : "d".repeat(40);
    },
  };
  const options = {
    bundlePath,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    git,
    repositories: [repository],
    schedulerAllows: () => true,
    now: () => 900000,
  };
  return { bundlePath, repository, grant, payload, signed, publish, options, checked: () => checked };
}

test("operator-signed grant validates real source resolution and final recheck", async (t) => {
  const f = fixture(t);
  const host = signedFileSentinelHost(f.options);
  assert.deepEqual(await host.authorize("fix-1"), f.grant);
  assert.equal(await host.verifySource(f.grant), true);
  assert.equal(f.checked(), 3);
  assert.equal(host.revalidateGrant?.(f.grant), true);
  assert.equal(await host.authorize("unknown"), null);
});

test("tampering, forged signature, duplicate task and revoked bundle deny all actions", async (t) => {
  const f = fixture(t);
  const host = signedFileSentinelHost(f.options);
  const different = { ...f.payload, grants: [{ ...f.payload.grants[0], grant: { ...f.grant, ticketHash: "e".repeat(64) } }] };
  f.publish({ payload: different, signature: f.signed().signature });
  assert.equal(await host.authorize("fix-1"), null);
  assert.equal(await host.verifySource(f.grant), false);
  assert.equal(host.revalidateGrant?.(f.grant), false);

  const duplicate = { ...f.payload, grants: [f.payload.grants[0], f.payload.grants[0]] };
  f.publish(f.signed(duplicate));
  assert.equal(await host.authorize("fix-1"), null);

  f.publish(f.signed());
  assert.equal(await host.authorize("fix-1")?.then(x => x?.taskId), "fix-1");
  unlinkSync(f.bundlePath);
  assert.equal(host.revalidateGrant?.(f.grant), false);
});

test("expired, mutated provenance and mismatched Git refs are rejected", async (t) => {
  const f = fixture(t);
  const expired = signedFileSentinelHost({ ...f.options, now: () => f.grant.expiresAt });
  assert.equal(await expired.authorize("fix-1"), null);
  assert.equal(expired.revalidateGrant?.(f.grant), false);

  const alteredProvenance = { ...f.payload, grants: [{ grant: f.grant, provenance: { ...f.payload.grants[0].provenance, sourceRef: "refs/heads/other" } }] };
  f.publish(f.signed(alteredProvenance));
  assert.equal(await signedFileSentinelHost(f.options).authorize("fix-1"), null);

  f.publish(f.signed());
  const mismatch = signedFileSentinelHost({
    ...f.options,
    git: { repository: async () => f.repository, resolve: async () => "f".repeat(40) },
  });
  assert.equal(await mismatch.verifySource(f.grant), false);
});

test("invalid key, relative path and symlink bundle fail closed", async (t) => {
  const f = fixture(t);
  assert.throws(() => signedFileSentinelHost({ ...f.options, bundlePath: "relative.json" }), /absolute/);
  assert.throws(() => signedFileSentinelHost({ ...f.options, publicKeyPem: "invalid-key" }));
  const link = path.join(path.dirname(f.bundlePath), "linked.json");
  symlinkSync(f.bundlePath, link);
  const host = signedFileSentinelHost({ ...f.options, bundlePath: link });
  assert.equal(await host.authorize("fix-1"), null);
  assert.equal(host.revalidateGrant?.(f.grant), false);
});
