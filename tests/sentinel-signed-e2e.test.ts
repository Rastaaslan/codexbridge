import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createSchema } from "../src/domain.js";
import { configSchema } from "../src/config.js";
import { Store } from "../src/database.js";
import { Orchestrator } from "../src/orchestrator.js";
import { GitWorkspace } from "../src/git.js";
import { hash } from "../src/sentinel-dev.js";
import { operatorSentinelHost } from "../src/sentinel-operator-host.js";
import { signedBundleMessage, sourceProvenanceBytes } from "../src/sentinel-trust.js";

async function pump(core: Orchestrator) {
  await core.tick();
  await core.sentinelDispatch?.tick();
  for (let i = 0; i < 16; i++)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

test("real disposable Git and signed grants dispatch two synthetic code jobs", {
  skip: process.platform !== "linux" || process.env.SENTINEL_SIGNED_E2E_GIT_TEST !== "1",
  timeout: 15000,
}, async (t) => {
  const root = mkdtempSync(path.join(process.cwd(), ".sentinel-signed-e2e-"));
  const repository = path.join(root, "repository");
  const dataDir = path.join(root, "data");
  mkdirSync(repository);
  mkdirSync(dataDir);
  let store: Store | undefined;
  let core: Orchestrator | undefined;
  t.after(async () => {
    await core?.stop();
    store?.close();
    rmSync(root, { recursive: true, force: true });
  });
  const gitCommand = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repository,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
    }).trim();
  let commit: string;
  try {
    gitCommand("init", "-q", "--initial-branch=main");
    gitCommand("-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-qm", "synthetic");
    commit = gitCommand("rev-parse", "HEAD");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("Git denied; no retry or workaround");
      return;
    }
    throw error;
  }
  store = new Store(path.join(dataDir, "state.db"));
  const dependency = store.create(
    createSchema.parse({ title: "Fixture prerequisite", ticket: "fixture", repository }),
  );
  store.patch(dependency.id, { status: "COMPLETED" });
  const source = { repository, sourceRef: "refs/heads/main", baseCommit: commit };
  const ticket = "Synthetic code fix only";
  const policy = {
    id: "signed-e2e",
    enabled: true,
    repository,
    source: { baseCommit: commit, provenanceHash: hash(sourceProvenanceBytes(source)), approvedBy: "offline-operator" },
    budget: 2, concurrency: 1, cooldownMs: 60000,
    tasks: [
      { id: "first", operation: "code-fix", dependencies: [dependency.id], requiredEvidence: [], ticket, ticketHash: hash(ticket) },
      { id: "second", operation: "code-fix", dependencies: ["CB-2"], requiredEvidence: [], ticket, ticketHash: hash(ticket) },
    ],
  };
  const config = configSchema.parse({
    dataDir, token: "x".repeat(32),
    sentinelExecutionEnabled: true, sentinelEnabled: true,
    sentinelDevPolicy: policy, maxRuntimeRetries: 0, repositoryRoots: [root],
  });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const keyPath = path.join(root, "operator-public.pem");
  const bundlePath = path.join(root, "operator-grants.json");
  writeFileSync(keyPath, pem);
  const grants = policy.tasks.map((task) => ({
    grant: {
      permission: "automatic-code-fix" as const,
      taskId: task.id,
      policyHash: hash(JSON.stringify(config.sentinelDevPolicy)),
      repository,
      sourceRef: source.sourceRef,
      baseCommit: commit,
      provenanceHash: policy.source.provenanceHash,
      ticketHash: task.ticketHash,
      expiresAt: 999999,
    },
    provenance: source,
  }));
  const payload = { version: 1 as const, grants };
  writeFileSync(bundlePath, JSON.stringify({
    payload,
    signature: sign(null, signedBundleMessage(payload), privateKey).toString("base64"),
  }));
  let now = 100000;
  const env = {
    CODEXBRIDGE_SENTINEL_OPERATOR_OPT_IN: "1",
    CODEXBRIDGE_SENTINEL_GRANTS_FILE: bundlePath,
    CODEXBRIDGE_SENTINEL_PUBLIC_KEY_FILE: keyPath,
    CODEXBRIDGE_SENTINEL_PUBLIC_KEY_SHA256: hash(pem),
    CODEXBRIDGE_SENTINEL_REPOSITORIES_JSON: JSON.stringify([repository]),
  };
  const git = new GitWorkspace(config);
  const trusted = operatorSentinelHost(config, git, () => true, env, () => true, () => now);
  assert.ok(trusted);
  assert.deepEqual(await trusted.authorize("first"), grants[0].grant);
  assert.equal(await trusted.verifySource(grants[0].grant), true);
  assert.equal(trusted.revalidateGrant?.(grants[0].grant), true);
  // Real Git identity/resolution; synthetic worktree and Codex adapters only.
  git.plan = async (job) => ({
    worktree: path.join(root, "synthetic-worktree"),
    branch: "fixture-" + job.id,
    baseCommit: commit,
  });
  git.prepare = async () => {};
  let workerCalls = 0;
  core = new Orchestrator(
    config, store, git,
    { async run() {
      workerCalls++;
      return {
        status: "completed", summary: "fixture", changedFiles: [],
        testsExecuted: ["synthetic"], testsPassed: true,
        remainingIssues: [], questions: [], requiresHumanDecision: false,
      };
    } },
    { async review() {
      return { decision: "ACCEPT", summary: "fixture", issues: [], requestedChanges: [], humanQuestion: null };
    } },
    trusted,
  );
  core.integration.snapshot = async () => ({}) as any;
  core.integration.reviewDiff = async () => ({ truncated: false }) as any;
  core.integration.seal = () => {};
  store.event(dependency.id, "JOB_COMPLETED", {});
  await pump(core);
  assert.equal(store.list().length, 2);
  assert.equal(store.get("CB-2").status, "READY_FOR_HUMAN_TEST");
  store.transition("CB-2", "COMPLETED"); // Synthetic fixture only, never human approval.
  await pump(core);
  assert.equal(store.list().length, 2);
  now += 60000;
  await pump(core);
  assert.equal(store.list().length, 3);
  assert.equal(store.get("CB-3").status, "READY_FOR_HUMAN_TEST");
  assert.equal(workerCalls, 2);
  await pump(core);
  assert.equal(store.list().length, 3); // No duplicate job.
  t.diagnostic("Signed grants + real disposable Git verified; two jobs passed through canonical scheduler with synthetic workers.");
});
