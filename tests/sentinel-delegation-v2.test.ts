import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/database.js";
import { createSchema } from "../src/domain.js";
import { hash } from "../src/sentinel-dev.js";
import { coreCreatePort } from "../src/sentinel-executor.js";
import { Orchestrator } from "../src/orchestrator.js";
import { configSchema } from "../src/config.js";
import {
  DelegationIssuerV2,
  delegationMessage,
  verifyDelegation,
  type DelegationPorts,
  type V2Envelope,
} from "../src/sentinel-delegation-v2.js";
function setup(t: TestContext) {
  mkdirSync(".test-tmp", { recursive: true });
  const dir = mkdtempSync(resolve(".test-tmp/delegation-"));
  const pairs = {
    mandate: generateKeyPairSync("ed25519"),
    evidence: generateKeyPairSync("ed25519"),
    lease: generateKeyPairSync("ed25519"),
  };
  const revoked = new Set<string>();
  const keys: DelegationPorts["keys"] = (role, id) =>
    id === role && !revoked.has(id)
      ? pairs[role].publicKey.export({ type: "spki", format: "pem" }).toString()
      : null;
  const envelope = (
    role: keyof typeof pairs,
    payload: unknown,
  ): V2Envelope => ({
    keyId: role,
    payload,
    signature: sign(
      null,
      delegationMessage(role, payload),
      pairs[role].privateKey,
    ).toString("base64"),
  });
  let now = 1800000000000,
    enabled = true,
    source = true,
    allowed = true,
    resource = true,
    signatures = 0,
    creates = 0;
  const m = {
    version: 2,
    id: "mandate-one",
    repository: dir,
    originHash: hash("synthetic-origin"),
    branches: ["refs/heads/isolated"],
    operation: "code-fix",
    issuerKeyId: "lease",
    evidenceKeyId: "evidence",
    maxIterations: 8,
    iterations7d: 8,
    iterations30d: 16,
    jobs7d: 1,
    jobs30d: 2,
    concurrency: 1,
    leaseMs: 300000,
    templates: [
      {
        id: "bounded-fix",
        ticket: "Synthetic isolated code-fix only",
        ticketHash: hash("Synthetic isolated code-fix only"),
        dependencies: ["CB-1"],
      },
    ],
  };
  // Schema intentionally rejects dot-containing paths. Use a plain canonical fixture path identity;
  // no file at that identity is accessed: Git verification is a synthetic port.
  m.repository = "/synthetic/delegation";
  let mandate = envelope("mandate", m);
  const evidence = (cycleId: string) =>
    envelope("evidence", {
      version: 2,
      mandateHash: hash(
        delegationMessage("mandate", mandate.payload).toString(),
      ),
      cycleId,
      templateId: "bounded-fix",
      repository: m.repository,
      originHash: m.originHash,
      branch: m.branches[0],
      sourceSha: "a".repeat(40),
      observedAt: now,
      factsHash: hash("synthetic facts"),
    });
  const ports: DelegationPorts = {
    enabled: () => enabled,
    keys,
    mandateAllowed: () => allowed,
    now: () => now,
    resources: () => resource,
    source: () => source,
    signLease: (payload) => {
      signatures++;
      return envelope("lease", payload);
    },
  };
  let db = new DatabaseSync(join(dir, "issuer.sqlite"));
  let issuer = new DelegationIssuerV2(db, ports);
  const store = new Store(join(dir, "jobs.sqlite"));
  const dep = store.create(
    createSchema.parse({
      title: "synthetic prerequisite",
      ticket: "synthetic",
      repository: m.repository,
    }),
  );
  assert.equal(dep.id, "CB-1");
  store.patch(dep.id, { status: "COMPLETED" });
  const core = {
    config: configSchema.parse({
      dataDir: dir,
      token: "x".repeat(32),
      maxRuntimeRetries: 0,
    }),
    store,
    git: {
      repository: async (r: string) => r,
      resolve: async () => "a".repeat(40),
    },
    tick: async () => {},
    create: Orchestrator.prototype.create,
  } as unknown as Orchestrator;
  const canonicalCreate = coreCreatePort(core);
  const lookup = (key: string) => {
    const row = store.db
      .prepare("SELECT id FROM jobs WHERE idempotency_key=?")
      .get(key);
    return row ? store.get(String(row.id)) : undefined;
  };
  const admission = {
    lookup,
    schedulerAllows: () => true,
    dependencies: (ids: string[]) =>
      ids.every((id) => store.get(id).status === "COMPLETED"),
    source: () => source,
    create: async (input: unknown, guard: () => undefined) => {
      creates++;
      return canonicalCreate(input, guard);
    },
  };
  t.after(() => {
    db.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    m,
    ports,
    store,
    admission,
    keys,
    revoked,
    envelope,
    evidence,
    get issuer() {
      return issuer;
    },
    get mandate() {
      return mandate;
    },
    advance: (ms: number) => {
      now += ms;
    },
    clockBack: () => {
      now--;
    },
    disable: () => {
      enabled = false;
    },
    denyMandate: () => {
      allowed = false;
    },
    denySource: () => {
      source = false;
    },
    denyResources: () => {
      resource = false;
    },
    rotate: () => {
      m.id = "mandate-two";
      mandate = envelope("mandate", m);
    },
    restart: () => {
      db.close();
      db = new DatabaseSync(join(dir, "issuer.sqlite"));
      issuer = new DelegationIssuerV2(db, ports);
    },
    counts: () => ({ signatures, creates }),
    complete: (key: string) => {
      const job = lookup(key)!;
      store.patch(job.id, { status: "COMPLETED" });
      issuer.reconcile(key, lookup);
    },
  };
}
test("v2 issues short lease, creates canonical job once, resumes after lost reply/reboot", async (t) => {
  const f = setup(t),
    proof = f.evidence("cycle1");
  const lease = f.issuer.issue(f.mandate, proof);
  assert.ok(verifyDelegation("lease", lease, f.keys));
  assert.equal(verifyDelegation("mandate", lease, f.keys), false);
  const original = f.admission.create;
  f.admission.create = async (input, guard) => {
    await original(input, guard);
    throw Error("lost reply");
  };
  await assert.rejects(
    f.issuer.dispatch(f.mandate, lease, f.admission),
    /lost reply/,
  );
  f.restart();
  assert.deepEqual(f.issuer.issue(f.mandate, proof), lease);
  const job = await f.issuer.dispatch(f.mandate, lease, f.admission);
  assert.equal(job.maxIterations, 8);
  assert.deepEqual(f.counts(), { signatures: 1, creates: 1 });
  assert.equal(
    (await f.issuer.dispatch(f.mandate, lease, f.admission)).id,
    job.id,
  );
  const altered = structuredClone(lease);
  (altered.payload as any).policy.tasks[0].maxIterations = 7;
  await assert.rejects(
    f.issuer.dispatch(f.mandate, altered, f.admission),
    /LEASE/,
  );
  const other = f.evidence("cycle1");
  (other.payload as any).sourceSha = "b".repeat(40);
  assert.throws(
    () => f.issuer.issue(f.mandate, f.envelope("evidence", other.payload)),
    /REPLAY_IDENTITY/,
  );
  f.advance(300000);
  assert.throws(() => f.issuer.issue(f.mandate, proof), /EXPIRED/);
  await assert.rejects(
    f.issuer.dispatch(f.mandate, lease, f.admission),
    /EXPIRED/,
  );
  f.complete((lease.payload as any).requestKey); // Completion reconciliation requires no new authority.
  assert.equal(f.issuer.status(f.m.repository)[0].state, "completed");
});
test("v2 rolling quotas persist across reboot and mandate rotation, then renew", async (t) => {
  const f = setup(t);
  const cycle = async (id: string) => {
    const l = f.issuer.issue(f.mandate, f.evidence(id));
    await f.issuer.dispatch(f.mandate, l, f.admission);
    f.complete((l.payload as any).requestKey);
  };
  await cycle("first");
  f.restart();
  f.rotate();
  f.advance(60000);
  assert.throws(() => f.issuer.issue(f.mandate, f.evidence("second")), /QUOTA/);
  f.advance(7 * 86400000 + 1);
  await cycle("second");
  f.advance(7 * 86400000 + 1);
  f.restart();
  assert.throws(() => f.issuer.issue(f.mandate, f.evidence("third")), /QUOTA/);
  f.advance(16 * 86400000 + 1);
  await cycle("third");
  assert.deepEqual(f.counts(), { signatures: 3, creates: 3 });
  assert.equal(
    f.issuer
      .status(f.m.repository)
      .reduce((n, r) => n + Number(r.iterations), 0),
    24,
  );
});
test("v2 live revocation, default disabled, stale evidence, source/resources and identity fail closed", async (t) => {
  for (const kind of [
    "disabled",
    "revoked",
    "source",
    "resources",
    "stale",
    "identity",
    "key",
  ] as const) {
    const f = setup(t),
      proof = f.evidence("first");
    if (kind === "disabled") delete f.ports.enabled;
    if (kind === "revoked") f.denyMandate();
    if (kind === "source") f.denySource();
    if (kind === "resources") f.denyResources();
    if (kind === "stale") f.advance(60001);
    if (kind === "identity") {
      (proof.payload as any).originHash = hash("other");
      proof.signature = f.envelope("evidence", proof.payload).signature;
    }
    if (kind === "key") f.revoked.add("evidence");
    assert.throws(() => f.issuer.issue(f.mandate, proof));
    assert.deepEqual(f.counts(), { signatures: 0, creates: 0 });
  }
  const f = setup(t),
    lease = f.issuer.issue(f.mandate, f.evidence("lease"));
  f.revoked.add("lease");
  f.restart();
  await assert.rejects(f.issuer.dispatch(f.mandate, lease, f.admission));
  assert.equal(f.counts().creates, 0);
});
test("v2 ambiguous signer/submit retains debit, blocks concurrent jobs and clock rollback", async (t) => {
  const f = setup(t);
  f.ports.signLease = () => {
    throw Error("signer unavailable");
  };
  const proof = f.evidence("first");
  assert.throws(() => f.issuer.issue(f.mandate, proof), /signer/);
  f.restart();
  assert.throws(() => f.issuer.issue(f.mandate, proof), /AMBIGUOUS/);
  assert.throws(() => f.issuer.issue(f.mandate, f.evidence("second")), /BUSY/);
  assert.equal(f.issuer.status(f.m.repository)[0].iterations, 8);
  const g = setup(t),
    lease = g.issuer.issue(g.mandate, g.evidence("first"));
  g.admission.create = async () => {
    throw Error("before insert crash");
  };
  await assert.rejects(
    g.issuer.dispatch(g.mandate, lease, g.admission),
    /before insert/,
  );
  g.restart();
  await assert.rejects(
    g.issuer.dispatch(g.mandate, lease, g.admission),
    /AMBIGUOUS/,
  );
  g.clockBack();
  assert.throws(() => g.issuer.issue(g.mandate, g.evidence("second")), /CLOCK/);
});

test("v2 post-async revocation blocks canonical insertion without affecting existing jobs", async (t) => {
  const f = setup(t),
    lease = f.issuer.issue(f.mandate, f.evidence("first"));
  const original = f.admission.create;
  f.admission.create = async (input, guard) => {
    f.denyMandate();
    return original(input, guard);
  };
  await assert.rejects(
    f.issuer.dispatch(f.mandate, lease, f.admission),
    /REVOKED/,
  );
  assert.equal(
    f.admission.lookup((lease.payload as any).requestKey),
    undefined,
  );
  assert.equal(f.issuer.status(f.m.repository)[0].state, "launching");
  assert.equal(f.store.get("CB-1").status, "COMPLETED");
});

test("v2 reconciles launching after expiry and revocation by exact durable identity only", async (t) => {
  const f = setup(t),
    lease = f.issuer.issue(f.mandate, f.evidence("lost"));
  const request = (lease.payload as any).requestKey;
  const create = f.admission.create;
  f.admission.create = async (input, guard) => {
    await create(input, guard);
    throw Error("lost reply");
  };
  await assert.rejects(
    f.issuer.dispatch(f.mandate, lease, f.admission),
    /lost reply/,
  );
  assert.equal(f.issuer.status(f.m.repository)[0].job_id, null);
  f.advance(300001);
  f.denyMandate();
  f.revoked.add("lease");
  f.disable();
  f.restart();
  assert.throws(
    () => f.issuer.reconcile(request, () => undefined),
    /JOB_IDENTITY/,
  );
  const job = f.admission.lookup(request)!;
  for (const change of [
    { title: "wrong" },
    { ticket: "wrong" },
    { repository: "/other" },
    { startRef: "b".repeat(40) },
    { baseCommit: "b".repeat(40) },
    { maxIterations: 9 },
    { priority: job.priority + 1 },
    { executionCost: job.executionCost + 1 },
    { projectId: "PR-99" },
    { featureId: "FE-99" },
    { acceptanceCriteria: ["different"] },
    { dependencies: [] },
  ]) {
    assert.throws(
      () => f.issuer.reconcile(request, () => ({ ...job, ...change })),
      /JOB_IDENTITY/,
    );
    assert.equal(f.issuer.status(f.m.repository)[0].state, "launching");
    assert.equal(f.issuer.status(f.m.repository)[0].job_id, null);
  }
  assert.equal(f.issuer.reconcile(request, f.admission.lookup).jobId, job.id);
  f.complete(request);
  f.restart();
  assert.equal(
    f.issuer.reconcile(request, f.admission.lookup).state,
    "COMPLETED",
  );
  await assert.rejects(
    f.issuer.dispatch(f.mandate, lease, f.admission),
    /DISABLED/,
  );
  assert.deepEqual(f.counts(), { signatures: 1, creates: 1 });
  assert.equal(f.issuer.status(f.m.repository)[0].iterations, 8);
});

test("v2 repository cooldown follows final insertion across completion, reboot and rotation", async (t) => {
  const f = setup(t);
  f.m.iterations7d = 32;
  f.m.iterations30d = 128;
  f.m.jobs7d = 4;
  f.m.jobs30d = 16;
  f.rotate();
  const first = f.issuer.issue(f.mandate, f.evidence("first"));
  const create = f.admission.create;
  f.admission.create = async (input, guard) => {
    f.advance(60000);
    return create(input, guard);
  };
  await f.issuer.dispatch(f.mandate, first, f.admission);
  f.complete((first.payload as any).requestKey);
  f.admission.create = create;
  f.restart();
  f.m.templates[0].ticket = "Synthetic rotated template";
  f.m.templates[0].ticketHash = hash(f.m.templates[0].ticket);
  f.rotate();
  assert.throws(
    () => f.issuer.issue(f.mandate, f.evidence("second")),
    /COOLDOWN/,
  );
  f.advance(59999);
  f.restart();
  assert.throws(
    () => f.issuer.issue(f.mandate, f.evidence("second")),
    /COOLDOWN/,
  );
  assert.deepEqual(f.counts(), { signatures: 1, creates: 1 });
  f.advance(1);
  const second = f.issuer.issue(f.mandate, f.evidence("second"));
  const job = await f.issuer.dispatch(f.mandate, second, f.admission);
  assert.equal(job.maxIterations, 8);
  assert.deepEqual(f.counts(), { signatures: 2, creates: 2 });
});
