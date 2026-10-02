import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/database.js";
import { configSchema } from "../src/config.js";
import { createSchema } from "../src/domain.js";
import { GitWorkspace, git } from "../src/git.js";
import { Orchestrator } from "../src/orchestrator.js";
import { operationalSummary, releasePreflight } from "../src/readiness.js";
import { toolDefinitions } from "../src/tools.js";
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cb-ready-"));
  const config = configSchema.parse({
    dataDir: dir,
    token: "secret".repeat(8),
  });
  const file = path.join(dir, "state.db");
  const store = new Store(file);
  const workspace = new GitWorkspace(config);
  const core = new Orchestrator(
    config,
    store,
    workspace,
    {
      async run() {
        throw Error("Unexpected work");
      },
    },
    {
      async review() {
        throw Error("Unexpected review");
      },
    },
  );
  return {
    dir,
    file,
    store,
    core,
    async cleanup() {
      await core.stop();
      if (store.db.isOpen) store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
test("preflight fails closed with concrete blockers and preserves strict read-only surfaces", async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.dir, "deploy/debian"), { recursive: true });
    await writeFile(
      path.join(f.dir, "deploy/debian/release-policy.json"),
      '{"runtimeSchema":1,"sqliteSchema":4}',
    );
    await writeFile(path.join(f.dir, ".gitignore"), "*.db*\nrelease.json\n");
    await git(f.dir, ["init"]);
    await git(f.dir, ["config", "user.name", "Test"]);
    await git(f.dir, ["config", "user.email", "test@example.invalid"]);
    await git(f.dir, ["add", "."]);
    await git(f.dir, ["commit", "-m", "baseline"]);
    const commit = (await git(f.dir, ["rev-parse", "HEAD"])).trim();
    await writeFile(
      path.join(f.dir, "release.json"),
      JSON.stringify({ commit }),
    );
    const health = async () => ({
      ok: true,
      orchestratorOk: true,
      availability: "ready",
      tunnel: "ready",
      checks: [],
      release: commit,
      maintenance: false,
      managed: true,
      update: null,
    });
    const options = { releaseDir: f.dir, health };
    const ready = await releasePreflight(f.core, "HEAD", options);
    assert.equal(ready.ready, true);
    assert.equal(ready.currentRelease, commit);
    assert.equal(ready.candidateCommit, commit);
    // A replacement must not let an incompatible commit borrow HEAD's policy.
    await writeFile(
      path.join(f.dir, "deploy/debian/release-policy.json"),
      '{"runtimeSchema":1,"sqliteSchema":99}',
    );
    await git(f.dir, ["commit", "-am", "incompatible candidate"]);
    const incompatible = await git(f.dir, ["rev-parse", "HEAD"]);
    await git(f.dir, ["checkout", "--detach", commit]);
    await git(f.dir, ["replace", incompatible, commit]);
    assert.equal(
      JSON.parse(
        await git(f.dir, [
          "show",
          `${incompatible}:deploy/debian/release-policy.json`,
        ]),
      ).sqliteSchema,
      4,
    );
    assert.equal(await git(f.dir, ["status", "--porcelain"]), "");
    const replaced = await releasePreflight(f.core, incompatible, options);
    assert.equal(replaced.candidateCommit, incompatible);
    assert.equal(replaced.ready, false);
    assert.deepEqual(
      replaced.blockers.map((b) => b.code),
      ["CANDIDATE_COMPATIBILITY"],
    );
    await git(f.dir, ["replace", "-d", incompatible]);
    const job = f.store.create(
      createSchema.parse({
        title: f.core.config.token,
        ticket: f.core.config.token,
        repository: f.dir,
      }),
    );
    f.store.patch(job.id, { childPid: process.pid });
    assert.ok(
      (await releasePreflight(f.core, "HEAD", options)).blockers.some(
        (b) => b.code === "ACTIVE_WORK",
      ),
    );
    f.store.patch(job.id, { childPid: null });
    await writeFile(path.join(f.dir, "dirty"), "change");
    assert.ok(
      (await releasePreflight(f.core, "HEAD", options)).blockers.some(
        (b) => b.code === "REPOSITORY_STATE",
      ),
    );
    await rm(path.join(f.dir, "dirty"));
    await rm(path.join(f.dir, "release.json"));
    f.store.db.exec("PRAGMA user_version=3");
    const failed = await releasePreflight(f.core, "missing", {
      ...options,
      health: async () => ({ ...(await health()), orchestratorOk: false }),
    });
    for (const code of [
      "APPLICATION_UNHEALTHY",
      "PREVIOUS_RELEASE",
      "MIGRATION_STATE",
      "CANDIDATE_COMPATIBILITY",
    ])
      assert.ok(
        failed.blockers.some((b) => b.code === code),
        code,
      );
    assert.equal(failed.ready, false);
    const summary = await operationalSummary(f.core, health);
    assert.equal(JSON.stringify(summary).includes(f.core.config.token), false);
    for (const [name, output] of [
      ["operational_summary", summary],
      ["release_preflight", failed],
    ] as const) {
      const tool = toolDefinitions(f.core).find((t) => t.name === name)!;
      assert.equal(tool.readOnly, true);
      assert.equal(tool.input.safeParse({ extra: true }).success, false);
      assert.equal(tool.output.safeParse(output).success, true);
      assert.equal(
        tool.output.safeParse({ ...output, extra: true }).success,
        false,
      );
    }
  } finally {
    await f.cleanup();
  }
});

for (const version of [1, 2, 3, 4])
  test(`schema v${version} migrates and reopens at v4 without changing existing rows`, async () => {
    const f = await fixture();
    try {
      const input = createSchema.parse({
        title: "Preserve",
        ticket: "Existing ticket",
        repository: f.dir,
        options: { idempotencyKey: "same" },
      });
      const job = f.store.create(input);
      f.store.event(job.id, "PRESERVE", { value: "existing" });
      f.store.db
        .prepare("INSERT INTO settings VALUES (?,?)")
        .run("sentinel", '"preserve"');
      if (version >= 2) f.store.createProject({ name: "Existing project" });
      if (version >= 3)
        f.store.db
          .prepare("INSERT INTO reviewed_snapshots VALUES (?,?)")
          .run(job.id, '{"sentinel":true}');
      if (version >= 4) {
        f.store.db
          .prepare("INSERT INTO roadmaps VALUES (?,?)")
          .run("RM-1", '{"sentinel":true}');
        f.store.db
          .prepare("INSERT INTO roadmap_versions VALUES (?,?,?)")
          .run("RM-1", 1, '{"sentinel":true}');
      }
      if (version < 4)
        f.store.db.exec("DROP TABLE roadmap_versions; DROP TABLE roadmaps;");
      if (version < 3)
        f.store.db.exec(
          "DROP TABLE integrations; DROP TABLE reviewed_snapshots;",
        );
      if (version < 2)
        f.store.db.exec(
          "DROP TABLE job_dependencies; DROP TABLE job_hierarchy; DROP TABLE features; DROP TABLE projects;",
        );
      f.store.db.exec(`PRAGMA user_version=${version}`);
      const tables = f.store.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all()
        .map((r) => String(r.name));
      const rows = (s: Store) =>
        tables.map((t) => s.db.prepare(`SELECT * FROM ${t}`).all());
      const before = rows(f.store);
      f.store.close();
      for (let i = 0; i < 2; i++) {
        const reopened = new Store(f.file);
        assert.equal(
          reopened.db.prepare("PRAGMA user_version").get()!.user_version,
          4,
        );
        assert.deepEqual(rows(reopened), before);
        assert.equal(reopened.create(input).id, job.id);
        reopened.close();
      }
    } finally {
      await f.cleanup();
    }
  });
