import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Orchestrator } from "./orchestrator.js";
import { doctor } from "./headless.js";
import { refSchema } from "./domain.js";
const exec = promisify(execFile);
const count = z.number().int().nonnegative();
const counts = z.record(z.string(), count);
const healthSchema = z.strictObject({
  orchestratorOk: z.boolean(),
  availability: z.enum(["ready", "degraded", "unhealthy"]),
  release: z.string().nullable(),
  maintenance: z.boolean(),
});
export const operationalSchema = z.strictObject({
  health: healthSchema,
  scheduler: z.strictObject({
    capacity: count,
    usedCapacity: count,
    runningJobs: count,
    pausedScopes: count,
  }),
  jobs: counts,
  projects: count,
  roadmaps: z.array(
    z.strictObject({
      id: z.string(),
      version: count,
      runnable: count,
      blocked: count,
      integrationWaits: count,
      humanAttention: count,
    }),
  ),
  integrations: counts,
  activeIntegrationOperations: count,
  retries: z.strictObject({ pending: count, exhausted: count }),
  humanAttention: count,
});
export async function operationalSummary(core: Orchestrator, health = doctor) {
  const h = await health(core),
    s = core.scheduler(),
    jobs = core.store.list();
  const statuses: Record<string, number> = {};
  for (const j of jobs) statuses[j.status] = (statuses[j.status] ?? 0) + 1;
  const integrations: Record<string, number> = {};
  for (const row of core.store.db
    .prepare("SELECT status, count(*) AS n FROM integrations GROUP BY status")
    .all())
    integrations[String(row.status)] = Number(row.n);
  return operationalSchema.parse({
    health: {
      orchestratorOk: h.orchestratorOk,
      availability: h.availability,
      release:
        h.release && /^[0-9a-f]{40,64}$/.test(h.release) ? h.release : null,
      maintenance: h.maintenance,
    },
    scheduler: {
      capacity: s.capacity,
      usedCapacity: s.usedCapacity,
      runningJobs: s.runningJobs,
      pausedScopes: s.pauses.filter((p) => p.paused).length,
    },
    jobs: statuses,
    projects: core.store.projects().length,
    roadmaps: core.store.db
      .prepare("SELECT id FROM roadmaps ORDER BY id")
      .all()
      .map((row) => {
        const p = core.planner.summary(String(row.id));
        return {
          id: p.roadmapId,
          version: p.version,
          runnable: p.nextRunnable.length,
          blocked: p.blockers.length,
          integrationWaits: p.integrationWaits.length,
          humanAttention: p.humanAttention.length,
        };
      }),
    integrations,
    activeIntegrationOperations: core.integration.activeOperations,
    retries: {
      pending: jobs.filter((j) => j.retry.nextRetryAt).length,
      exhausted: jobs.filter((j) => j.retry.exhausted).length,
    },
    humanAttention: jobs.filter((j) =>
      ["WAITING_FOR_HUMAN", "FAILED", "READY_FOR_HUMAN_TEST"].includes(
        j.status,
      ),
    ).length,
  });
}
export const preflightInput = z.strictObject({ candidateRef: refSchema });
export const preflightSchema = z.strictObject({
  ready: z.boolean(),
  currentRelease: z.string().nullable(),
  candidateRef: z.string(),
  candidateCommit: z.string().nullable(),
  schemaVersion: count,
  blockers: z.array(z.strictObject({ code: z.string(), detail: z.string() })),
});
// Local inspection only: no fetch, migration, maintenance changes or activation.
export async function releasePreflight(
  core: Orchestrator,
  candidateRef: string,
  options: {
    health?: typeof doctor;
    releaseDir?: string;
    installedUpdaterFile?: string;
  } = {},
) {
  preflightInput.parse({ candidateRef });
  const root =
    options.releaseDir ?? fileURLToPath(new URL("../", import.meta.url));
  const blockers: { code: string; detail: string }[] = [];
  const block = (code: string, detail: string) =>
    blockers.push({ code, detail });
  let currentRelease: string | null = null,
    candidateCommit: string | null = null;
  try {
    const h = await (options.health ?? doctor)(core);
    healthSchema.parse({
      orchestratorOk: h.orchestratorOk,
      availability: h.availability,
      release: h.release,
      maintenance: h.maintenance,
    });
    currentRelease =
      h.release && /^[0-9a-f]{40,64}$/.test(h.release) ? h.release : null;
    if (!h.orchestratorOk)
      block(
        "APPLICATION_UNHEALTHY",
        "Application health checks failed; inspect server_doctor.",
      );
    if (h.maintenance)
      block("MAINTENANCE", "Restart or release recovery is in progress.");
  } catch {
    block(
      "APPLICATION_UNHEALTHY",
      "Application health could not be established.",
    );
  }
  if (
    core.scheduler().runningJobs ||
    core.integration.activeOperations ||
    core.store.list().some((j) => core.integration.active(j.id))
  )
    block(
      "ACTIVE_WORK",
      "Jobs, child processes or integration attempts are active; wait for them to settle.",
    );
  const schemaVersion = Number(
    core.store.db.prepare("PRAGMA user_version").get()!.user_version,
  );
  if (![1, 4].includes(schemaVersion))
    block("MIGRATION_STATE", "Runtime database must be at schema v1 or v4.");
  try {
    const release = JSON.parse(
      await readFile(path.join(root, "release.json"), "utf8"),
    );
    const policy = JSON.parse(
      await readFile(`${root}/deploy/debian/release-policy.json`, "utf8"),
    );
    if (
      !currentRelease ||
      release.commit !== currentRelease ||
      !/^[0-9a-f]{40,64}$/.test(release.commit) ||
      ![1, 2].includes(release.runtimeSchema) ||
      release.sqliteSchema !== schemaVersion ||
      policy.runtimeSchema !== release.runtimeSchema ||
      policy.sqliteSchema !== schemaVersion
    )
      throw Error("baseline");
  } catch {
    block(
      "PREVIOUS_RELEASE",
      "A matching current release manifest and schema-v1/v4 rollback baseline are required.",
    );
  }
  const git = async (args: string[]) =>
    (
      await exec(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.fsmonitor=false",
          ...args,
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            GIT_OPTIONAL_LOCKS: "0",
            GIT_NO_REPLACE_OBJECTS: "1",
            GIT_TERMINAL_PROMPT: "0",
          },
          timeout: 5000,
          maxBuffer: 1024 * 1024,
        },
      )
    ).stdout.trim();
  try {
    const head = await git(["rev-parse", "HEAD"]);
    const flags = await git(["ls-files", "-v"]);
    if (flags.split("\n").some((line) => /^[a-zS]/.test(line)))
      throw Error("Hidden index changes");
    if (
      head !== currentRelease ||
      (await git(["status", "--porcelain", "--untracked-files=normal"]))
    )
      throw Error("dirty");
    for (const marker of ["rebase-merge", "rebase-apply", "sequencer"]) {
      const location = await git(["rev-parse", "--git-path", marker]);
      if (
        await stat(path.resolve(root, location)).then(
          () => true,
          () => false,
        )
      )
        throw Error("operation");
    }
    for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
      if (
        await git(["rev-parse", "--quiet", "--verify", marker]).catch(() => "")
      )
        throw Error("operation");
    }
  } catch {
    block(
      "REPOSITORY_STATE",
      "Release repository is unavailable, modified or does not match the current release.",
    );
  }
  try {
    candidateCommit = await git([
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${candidateRef}^{commit}`,
    ]);
    const policy = JSON.parse(
      await git([
        "show",
        `${candidateCommit}:deploy/debian/release-policy.json`,
      ]),
    );
    if (![1, 2].includes(policy.runtimeSchema) || policy.sqliteSchema !== 4)
      throw Error("schema");
    if (policy.runtimeSchema === 2 && policy.minimumUpdaterVersion !== 2)
      throw Error("runtime contract required");
    if (schemaVersion === 1 && policy.minimumUpdaterVersion !== 2)
      throw Error("cold rollback contract required");
    if (policy.minimumUpdaterVersion !== undefined) {
      const required = policy.minimumUpdaterVersion;
      if (!Number.isSafeInteger(required) || required < 1)
        throw Error("updater requirement");
      // Read root-owned installed code as data. Never execute/import candidate or
      // old updater scripts just to query capabilities (old runners have no query mode).
      const file =
        options.installedUpdaterFile ??
        "/usr/local/lib/codexbridge/self-update.mjs";
      const info = await stat(file);
      if (
        !options.installedUpdaterFile &&
        (info.uid !== 0 || info.mode & 0o022)
      )
        throw Error("unsafe installed updater");
      const installed = await readFile(file, "utf8");
      const version = Number(
        installed.match(/^export const UPDATER_VERSION = (\d+);$/m)?.[1],
      );
      if (!Number.isSafeInteger(version) || version < required)
        throw Error("installed updater too old");
    }
  } catch {
    block(
      "CANDIDATE_COMPATIBILITY",
      "Candidate must exist locally, declare supported runtimeSchema 1/2 and sqliteSchema 4, and be supported by the installed updater; build/test validation is still required before activation.",
    );
  }
  return preflightSchema.parse({
    ready: blockers.length === 0,
    currentRelease,
    candidateRef,
    candidateCommit,
    schemaVersion,
    blockers,
  });
}
