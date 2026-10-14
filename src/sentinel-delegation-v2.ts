/** Separate operator-side authority. No private key, filesystem loader or startup hook. */
import { createPublicKey, verify } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { hash, devPolicySchema } from "./sentinel-dev.js";
import { createSchema, type Job } from "./domain.js";
import type { ExecutionPorts } from "./sentinel-executor.js";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const repository = z.string().regex(/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/);
export const mandateV2Schema = z
  .strictObject({
    version: z.literal(2),
    id,
    repository,
    originHash: digest,
    branches: z
      .array(z.string().regex(/^refs\/heads\/[a-zA-Z0-9_/-]+$/))
      .min(1)
      .max(8),
    operation: z.literal("code-fix"),
    issuerKeyId: id,
    evidenceKeyId: id,
    maxIterations: z.number().int().min(1).max(8),
    iterations7d: z.number().int().min(1).max(32),
    iterations30d: z.number().int().min(1).max(128),
    jobs7d: z.number().int().min(1).max(4),
    jobs30d: z.number().int().min(1).max(16),
    concurrency: z.literal(1),
    leaseMs: z.number().int().min(1000).max(300000),
    templates: z
      .array(
        z.strictObject({
          id,
          ticket: z.string().min(1).max(4000),
          ticketHash: digest,
          dependencies: z
            .array(z.string().regex(/^CB-\d+$/))
            .min(1)
            .max(10),
        }),
      )
      .min(1)
      .max(10),
  })
  .superRefine((m, ctx) => {
    if (
      new Set(m.templates.map((t) => t.id)).size !== m.templates.length ||
      m.templates.some(
        (t) => hash(t.ticket) !== t.ticketHash || t.ticket !== t.ticket.trim(),
      )
    )
      ctx.addIssue({ code: "custom", message: "Invalid template identity" });
  });
export const evidenceV2Schema = z.strictObject({
  version: z.literal(2),
  mandateHash: digest,
  cycleId: id,
  templateId: id,
  repository,
  originHash: digest,
  branch: z.string(),
  sourceSha: commit,
  observedAt: z.number().int().nonnegative(),
  factsHash: digest,
});
export const leaseV2Schema = z.strictObject({
  version: z.literal(2),
  mandateHash: digest,
  evidenceHash: digest,
  requestKey: digest,
  policy: devPolicySchema,
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
});
type Role = "mandate" | "evidence" | "lease";
const schemas = {
  mandate: mandateV2Schema,
  evidence: evidenceV2Schema,
  lease: leaseV2Schema,
};
export type V2Envelope = { keyId: string; payload: unknown; signature: string };
export type V2Keys = (role: Role, keyId: string) => string | null;
export function delegationMessage(role: Role, payload: unknown) {
  return Buffer.from(
    `CODEXBRIDGE_DELEGATION_${role.toUpperCase()}_V2\n${JSON.stringify(schemas[role].parse(payload))}`,
  );
}
export function verifyDelegation(
  role: Role,
  envelope: V2Envelope,
  keys: V2Keys,
) {
  try {
    const pem = keys(role, id.parse(envelope.keyId));
    if (!pem || !/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature)) return false;
    const key = createPublicKey(pem);
    return (
      key.asymmetricKeyType === "ed25519" &&
      verify(
        null,
        delegationMessage(role, envelope.payload),
        key,
        Buffer.from(envelope.signature, "base64"),
      )
    );
  } catch {
    return false;
  }
}
export interface DelegationPorts {
  enabled?(): boolean; // Protected operator control; default is disabled.
  keys: V2Keys; // Live external allowlist/revocations, never worker metadata.
  mandateAllowed(hash: string): boolean;
  now(): number;
  resources(): boolean;
  source(evidence: z.infer<typeof evidenceV2Schema>): boolean;
  // Separate operator signer; never supplied by a worker or loaded from this DB.
  signLease(payload: z.infer<typeof leaseV2Schema>): V2Envelope;
}
const denied = (ok: unknown, reason: string): void => {
  if (!ok) throw Error(`V2_${reason}`);
};
type Row = {
  request: string;
  repository: string;
  mandate: string;
  iterations: number;
  at: number;
  state: string;
  lease: string | null;
  job_id: string | null;
};
/** Durable bounded issuer. Deployment must keep this DB and signer outside worker access. */
export class DelegationIssuerV2 {
  constructor(
    private db: DatabaseSync,
    private ports: DelegationPorts,
  ) {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sentinel_v2_leases(request TEXT PRIMARY KEY, repository TEXT NOT NULL,
      mandate TEXT NOT NULL, iterations INTEGER NOT NULL, at INTEGER NOT NULL, state TEXT NOT NULL,
      lease TEXT, job_id TEXT);
      CREATE INDEX IF NOT EXISTS sentinel_v2_quota ON sentinel_v2_leases(repository,at);
      CREATE TABLE IF NOT EXISTS sentinel_v2_admissions(request TEXT PRIMARY KEY, repository TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS sentinel_v2_admission_time ON sentinel_v2_admissions(repository,at);
      CREATE TABLE IF NOT EXISTS sentinel_v2_clock(id INTEGER PRIMARY KEY CHECK(id=1), at INTEGER NOT NULL);`);
  }
  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private row(key: string) {
    return this.db
      .prepare("SELECT * FROM sentinel_v2_leases WHERE request=?")
      .get(key) as Row | undefined;
  }
  private clock() {
    const now = this.ports.now();
    const last = this.db
      .prepare("SELECT at FROM sentinel_v2_clock WHERE id=1")
      .get();
    denied(
      Number.isSafeInteger(now) &&
        now >= 0 &&
        (!last || now >= Number(last.at)),
      "CLOCK",
    );
    this.db
      .prepare("INSERT OR REPLACE INTO sentinel_v2_clock VALUES(1,?)")
      .run(now);
    return now;
  }
  private cooldown(repository: string, now: number, request = "") {
    const last = this.db
      .prepare(
        `SELECT max(at) AS at FROM (
      SELECT at FROM sentinel_v2_leases WHERE repository=? AND request!=?
      UNION ALL SELECT at FROM sentinel_v2_admissions WHERE repository=? AND request!=?)`,
      )
      .get(repository, request, repository, request);
    denied(last?.at == null || now - Number(last.at) >= 60000, "COOLDOWN");
  }
  private mandate(envelope: V2Envelope) {
    denied(this.ports.enabled?.() === true, "DISABLED");
    denied(verifyDelegation("mandate", envelope, this.ports.keys), "MANDATE");
    const m = mandateV2Schema.parse(envelope.payload),
      fingerprint = hash(delegationMessage("mandate", m).toString());
    denied(this.ports.mandateAllowed(fingerprint), "REVOKED");
    const keys = [
      this.ports.keys("mandate", envelope.keyId),
      this.ports.keys("evidence", m.evidenceKeyId),
      this.ports.keys("lease", m.issuerKeyId),
    ];
    denied(
      keys.every(Boolean) &&
        new Set(
          keys.map((k) =>
            createPublicKey(k!)
              .export({ type: "spki", format: "der" })
              .toString("hex"),
          ),
        ).size === 3,
      "KEY_ROLES",
    );
    return { m, fingerprint };
  }
  issue(mandate: V2Envelope, evidence: V2Envelope): V2Envelope {
    const { m, fingerprint } = this.mandate(mandate);
    denied(
      evidence.keyId === m.evidenceKeyId &&
        verifyDelegation("evidence", evidence, this.ports.keys),
      "EVIDENCE",
    );
    const e = evidenceV2Schema.parse(evidence.payload);
    const t = m.templates.find((t) => t.id === e.templateId);
    denied(
      t &&
        e.mandateHash === fingerprint &&
        e.repository === m.repository &&
        e.originHash === m.originHash &&
        m.branches.includes(e.branch),
      "IDENTITY",
    );
    const request = hash(`sentinel:v2:${m.repository}:${e.cycleId}`);
    const evidenceHash = hash(delegationMessage("evidence", e).toString());
    const issued = this.tx(() => {
      const now = this.clock();
      const old = this.row(request);
      if (old) {
        denied(old.lease, "AMBIGUOUS");
        const envelope = JSON.parse(old.lease!) as V2Envelope;
        const lease = this.validate(mandate, envelope, now);
        denied(lease.evidenceHash === evidenceHash, "REPLAY_IDENTITY");
        return envelope;
      }
      denied(e.observedAt <= now && now - e.observedAt <= 60000, "STALE");
      denied(this.ports.resources() && this.ports.source(e), "ADMISSION");
      denied(
        !this.db
          .prepare(
            "SELECT 1 FROM sentinel_v2_leases WHERE repository=? AND state!='completed' LIMIT 1",
          )
          .get(m.repository),
        "BUSY",
      );
      this.cooldown(m.repository, now);
      for (const [days, iterations, jobs] of [
        [7, m.iterations7d, m.jobs7d],
        [30, m.iterations30d, m.jobs30d],
      ]) {
        const used = this.db
          .prepare(
            "SELECT count(*) AS jobs, coalesce(sum(iterations),0) AS iterations FROM sentinel_v2_leases WHERE repository=? AND at>?",
          )
          .get(m.repository, now - days * 86400000)!;
        denied(
          Number(used.jobs) + 1 <= jobs &&
            Number(used.iterations) + m.maxIterations <= iterations,
          "QUOTA",
        );
      }
      const policy = devPolicySchema.parse({
        id: e.cycleId,
        enabled: true,
        repository: m.repository,
        source: {
          baseCommit: e.sourceSha,
          provenanceHash: hash(
            JSON.stringify({
              repository: m.repository,
              baseCommit: e.sourceSha,
              sourceRef: e.branch,
            }),
          ),
          approvedBy: m.id,
        },
        budget: m.maxIterations,
        concurrency: 1,
        cooldownMs: 60000,
        tasks: [
          {
            id: t!.id,
            operation: "code-fix",
            maxIterations: m.maxIterations,
            dependencies: t!.dependencies,
            requiredEvidence: [],
            ticket: t!.ticket,
            ticketHash: t!.ticketHash,
          },
        ],
      });
      const payload = leaseV2Schema.parse({
        version: 2,
        mandateHash: fingerprint,
        evidenceHash,
        requestKey: request,
        policy,
        issuedAt: now,
        expiresAt: now + m.leaseMs,
      });
      this.db
        .prepare(
          "INSERT INTO sentinel_v2_leases VALUES(?,?,?,?,?,'reserved',NULL,NULL)",
        )
        .run(request, m.repository, fingerprint, m.maxIterations, now);
      return payload;
    });
    if ("signature" in issued) return issued;
    // A crash/signing failure retains the full debit and prevents a second signing attempt.
    const signed = this.ports.signLease(issued);
    this.validate(mandate, signed, this.ports.now());
    denied(
      signed.keyId === m.issuerKeyId &&
        delegationMessage("lease", signed.payload).equals(
          delegationMessage("lease", issued),
        ),
      "SIGNER",
    );
    this.tx(() => {
      denied(this.row(request)?.state === "reserved", "STATE");
      this.db
        .prepare(
          "UPDATE sentinel_v2_leases SET lease=?,state='issued' WHERE request=?",
        )
        .run(JSON.stringify(signed), request);
    });
    return signed;
  }
  validate(mandate: V2Envelope, envelope: V2Envelope, now = this.ports.now()) {
    const { m, fingerprint } = this.mandate(mandate);
    denied(
      envelope.keyId === m.issuerKeyId &&
        verifyDelegation("lease", envelope, this.ports.keys),
      "LEASE",
    );
    const l = leaseV2Schema.parse(envelope.payload),
      p = l.policy,
      t = p.tasks[0];
    const approved = m.templates.find((v) => v.id === t.id);
    denied(
      l.mandateHash === fingerprint &&
        l.issuedAt <= now &&
        now < l.expiresAt &&
        l.expiresAt - l.issuedAt <= m.leaseMs,
      "EXPIRED_OR_MANDATE",
    );
    denied(
      p.enabled &&
        p.cooldownMs === 60000 &&
        p.repository === m.repository &&
        p.tasks.length === 1 &&
        p.budget === m.maxIterations &&
        t.maxIterations === m.maxIterations &&
        t.requiredEvidence.length === 0 &&
        p.source?.approvedBy === m.id &&
        approved &&
        approved.ticketHash === t.ticketHash &&
        JSON.stringify(approved.dependencies) ===
          JSON.stringify(t.dependencies),
      "POLICY",
    );
    denied(
      l.requestKey === hash(`sentinel:v2:${m.repository}:${p.id}`),
      "REQUEST",
    );
    return l;
  }
  private input(l: z.infer<typeof leaseV2Schema>) {
    const task = l.policy.tasks[0];
    const input = createSchema.parse({
      title: `Sentinel delegated code-fix: ${task.id}`,
      ticket: task.ticket,
      repository: l.policy.repository,
      startRef: l.policy.source!.baseCommit,
      dependencies: task.dependencies,
      options: {
        idempotencyKey: l.requestKey,
        maxIterations: task.maxIterations,
      },
    });
    return input;
  }
  private matching(job: Job, l: z.infer<typeof leaseV2Schema>) {
    const input = this.input(l);
    denied(
      job.repository === input.repository &&
        job.ticket === input.ticket &&
        job.title === input.title &&
        job.startRef === input.startRef &&
        job.baseCommit === input.startRef &&
        job.maxIterations === input.options.maxIterations &&
        job.priority === input.priority &&
        job.executionCost === input.executionCost &&
        job.projectId === undefined &&
        job.featureId === undefined &&
        JSON.stringify(job.acceptanceCriteria) ===
          JSON.stringify(input.acceptanceCriteria) &&
        JSON.stringify(job.dependencies) ===
          JSON.stringify([...new Set(input.dependencies)].sort()),
      "JOB_IDENTITY",
    );
    return job;
  }
  /** Same canonical create port as v1, but independent namespace/ledger. No v1 mutation. */
  async dispatch(
    mandate: V2Envelope,
    envelope: V2Envelope,
    ports: Pick<ExecutionPorts, "create" | "schedulerAllows"> & {
      lookup(key: string): Job | undefined;
      dependencies(ids: string[]): boolean;
      source(policy: z.infer<typeof devPolicySchema>): boolean;
    },
  ) {
    const l = this.validate(mandate, envelope),
      task = l.policy.tasks[0];
    const input = this.input(l);
    const matching = (job: Job) => this.matching(job, l);
    const guard = (): undefined => {
      this.validate(mandate, envelope);
      const now = this.clock();
      this.cooldown(input.repository, now, l.requestKey);
      denied(
        this.ports.resources() &&
          ports.schedulerAllows(input.repository) &&
          ports.dependencies(input.dependencies ?? []) &&
          ports.source(l.policy),
        "ADMISSION",
      );
      this.db
        .prepare("INSERT OR REPLACE INTO sentinel_v2_admissions VALUES(?,?,?)")
        .run(l.requestKey, input.repository, now);
      return undefined;
    };
    const found = this.tx(() => {
      this.clock();
      const row = this.row(l.requestKey);
      denied(row?.lease === JSON.stringify(envelope), "UNISSUED");
      const job = ports.lookup(l.requestKey);
      if (job) {
        matching(job);
        this.db
          .prepare(
            "UPDATE sentinel_v2_leases SET state=?,job_id=? WHERE request=?",
          )
          .run(
            job.status === "COMPLETED" ? "completed" : "submitted",
            job.id,
            l.requestKey,
          );
        return job;
      }
      denied(row!.state === "issued", "AMBIGUOUS");
      guard();
      this.db
        .prepare(
          "UPDATE sentinel_v2_leases SET state='launching' WHERE request=?",
        )
        .run(l.requestKey);
      return undefined;
    });
    if (found) return found;
    let guarded = false;
    const job = await ports.create(input, () => {
      guard();
      guarded = true;
      return undefined;
    });
    denied(guarded, "CREATE_GUARD");
    matching(job);
    const persisted = ports.lookup(l.requestKey);
    denied(persisted?.id === job.id, "PERSISTENCE");
    this.db
      .prepare(
        "UPDATE sentinel_v2_leases SET state='submitted',job_id=? WHERE request=?",
      )
      .run(job.id, l.requestKey);
    return job;
  }
  /** Reconcile completed work after lease expiry without authorizing any new work. */
  reconcile(request: string, lookup: (key: string) => Job | undefined) {
    return this.tx(() => {
      const row = this.row(digest.parse(request));
      denied(
        row?.lease &&
          ["launching", "submitted", "completed"].includes(row.state),
        "AMBIGUOUS",
      );
      // Protected durable issuance is historical authority for observation only.
      // Never require a live key/lease here; revocation must not hide existing work.
      const lease = leaseV2Schema.parse(JSON.parse(row!.lease!).payload);
      denied(
        lease.requestKey === request &&
          lease.mandateHash === row!.mandate &&
          lease.policy.repository === row!.repository &&
          lease.issuedAt === row!.at &&
          lease.policy.tasks[0].maxIterations === row!.iterations,
        "LEDGER_IDENTITY",
      );
      const job = lookup(request);
      denied(job && (!row!.job_id || job.id === row!.job_id), "JOB_IDENTITY");
      this.matching(job!, lease);
      this.db
        .prepare(
          "UPDATE sentinel_v2_leases SET state=?,job_id=? WHERE request=?",
        )
        .run(
          job!.status === "COMPLETED" ? "completed" : "submitted",
          job!.id,
          request,
        );
      return { state: job!.status, jobId: job!.id };
    });
  }
  status(repository: string) {
    return this.db
      .prepare(
        "SELECT request,iterations,at,state,job_id FROM sentinel_v2_leases WHERE repository=? ORDER BY at DESC LIMIT 128",
      )
      .all(repository);
  }
}
