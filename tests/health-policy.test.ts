import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { healthSummary } from "../src/headless.js";
import { toolDefinitions } from "../src/tools.js";
import {
  makeDriver,
  releaseHealth,
  transaction,
  recover,
  verifyRecovery,
} from "../scripts/self-update.mjs";

const checks = (tunnel = true, database = true) => [
  ...["node", "git", "codexAuth", "repositories"].map((name) => ({
    name,
    ok: true,
    detail: "ok",
  })),
  { name: "database", ok: database, detail: database ? "ok" : "failed" },
  {
    name: "tunnel",
    ok: tunnel,
    detail: tunnel ? "ok" : "managed runtime unavailable",
  },
];
const doctor = (commit: string, tunnel = true, database = true) => {
  const list = checks(tunnel, database);
  return {
    ...healthSummary(list),
    checks: list,
    release: commit,
    managed: true,
    maintenance: false,
    update: null,
  };
};

test("doctor/API distinguish application failure, tunnel degradation and live recovery", () => {
  const schema = toolDefinitions({} as any).find(
    (t) => t.name === "server_doctor",
  )!.output;
  for (const tunnel of [true, false, true]) {
    const result = doctor("commit", tunnel);
    assert.equal(result.orchestratorOk, true);
    assert.equal(result.ok, tunnel, "legacy overall health remains truthful");
    assert.equal(result.availability, tunnel ? "ready" : "degraded");
    assert.equal(schema.safeParse(result).success, true);
  }
  assert.equal(doctor("commit", false, false).availability, "unhealthy");
  assert.equal(doctor("commit", true, false).orchestratorOk, false);
  assert.equal(
    healthSummary(checks().filter((c) => c.name !== "tunnel")).tunnel,
    "not_checked",
  );
});

test("release health accepts only isolated tunnel failure, including legacy rollback doctors", () => {
  const degraded = doctor("commit", false);
  assert.throws(() => releaseHealth({ ...degraded, release: null }, null));
  assert.throws(() => releaseHealth({ ...degraded, release: "" }, ""));
  assert.equal(releaseHealth(degraded, "commit").availability, "degraded");
  const { orchestratorOk, availability, tunnel, ...legacy } = degraded;
  assert.equal(releaseHealth(legacy, "commit").availability, "degraded");
  for (const name of [
    "node",
    "database",
    "git",
    "codexAuth",
    "repositories",
    "futureCheck",
  ]) {
    const list = checks(false).filter((c) => c.name !== name);
    list.push({ name, ok: false, detail: "failure" });
    assert.throws(() => releaseHealth({ ...degraded, checks: list }, "commit"));
  }
  for (const bad of [
    null,
    {},
    { ...degraded, release: "other" },
    { ...degraded, managed: false },
    { ...degraded, checks: [] },
    { ...degraded, checks: checks().filter((c) => c.name !== "database") },
    { ...degraded, checks: [...checks(false), checks(false)[0]] },
    { ...degraded, checks: [{ name: "node", ok: "true" }] },
    { ...degraded, ok: true },
    { ...degraded, orchestratorOk: false },
    { ...degraded, availability: "ready" },
    { ...degraded, tunnel: "ready" },
  ])
    assert.throws(() => releaseHealth(bad, "commit"));
});

test("real update health and boot recovery retain maintenance ordering with a degraded tunnel", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "cb-health-policy-"));
  const data = path.join(base, "runtime");
  const old = path.join(base, "old"),
    candidate = path.join(base, "new");
  for (const dir of [data, old, candidate]) await mkdir(dir);
  for (const [dir, commit] of [
    [old, "old"],
    [candidate, "new"],
  ])
    await writeFile(
      path.join(dir, "release.json"),
      JSON.stringify({ commit, runtimeSchema: 1 }),
    );
  await writeFile(
    path.join(data, "config.json"),
    JSON.stringify({ token: "fixture-local", port: 3847 }),
  );
  await writeFile(path.join(data, "codexbridge.db"), "persistent sentinel");
  let selected = old,
    tunnelReady = false;
  const services: string[][] = [];
  const driver = await makeDriver(
    base,
    data,
    {},
    async (command: string, args: string[]) => {
      assert.equal(command, "/usr/bin/systemctl");
      services.push(args);
      assert.deepEqual(args, ["is-active", "--quiet", "codexbridge.service"]);
      return { stdout: "", stderr: "" };
    },
    async (url: string, options: any) => {
      assert.equal(options.headers.Authorization, "Bearer fixture-local");
      if (url.endsWith("jobs_overview"))
        return Response.json({ counts: { running: 0 } });
      assert.ok(url.endsWith("server_doctor"));
      await access(path.join(data, "maintenance.json"));
      return Response.json(
        doctor(selected === candidate ? "new" : "old", tunnelReady),
      );
    },
  );
  driver.current = async () => selected;
  driver.build = async () => candidate;
  driver.activate = async (value: string) => {
    await access(path.join(data, "maintenance.json"));
    selected = value;
  };
  driver.restart = async () => {
    await access(path.join(data, "maintenance.json"));
  };
  await transaction(driver, "requested-ref");
  assert.equal(selected, candidate);
  let state = JSON.parse(
    await readFile(path.join(data, "update-status.json"), "utf8"),
  );
  assert.equal(state.phase, "completed");
  assert.equal(state.health.availability, "degraded");
  await assert.rejects(access(path.join(data, "maintenance.json")));

  await recover(
    driver,
    { phase: "activating", previous: old, candidate },
    true,
  );
  assert.equal(selected, old);
  state = JSON.parse(
    await readFile(path.join(data, "update-status.json"), "utf8"),
  );
  assert.equal(state.phase, "boot_pending_health");
  await access(path.join(data, "maintenance.json"));
  await verifyRecovery(driver, state);
  state = JSON.parse(
    await readFile(path.join(data, "update-status.json"), "utf8"),
  );
  assert.equal(state.phase, "rolled_back");
  assert.equal(state.health.availability, "degraded");
  await assert.rejects(access(path.join(data, "maintenance.json")));

  // The next live health read reflects recovery; the journal remains history.
  tunnelReady = true;
  await driver.hold();
  assert.equal((await driver.health(old)).availability, "ready");
  await driver.resume();
  assert.equal(selected, old);
  assert.equal(
    await readFile(path.join(data, "codexbridge.db"), "utf8"),
    "persistent sentinel",
  );
  assert.equal(services.length, 3);
});

test("application failure still rolls back and failed boot validation retains maintenance", async () => {
  let selected = "old",
    held = false,
    state: any;
  const driver = {
    current: async () => selected,
    build: async () => "new",
    save: async (value: any) => {
      state = value;
    },
    hold: async () => {
      held = true;
    },
    quiesce: async () => {
      held = true;
    },
    activate: async (value: string) => {
      selected = value;
    },
    restart: async () => {},
    health: async (value: string) =>
      releaseHealth(doctor(value, false, value !== "new"), value),
    resume: async () => {
      held = false;
    },
  };
  await assert.rejects(transaction(driver, "ref"));
  assert.equal(selected, "old");
  assert.equal(state.phase, "rolled_back");
  assert.equal(state.health.availability, "degraded");
  assert.equal(held, false);
  driver.health = async (value: string) =>
    releaseHealth(doctor(value, true, false), value);
  await recover(driver, { phase: "activating", previous: "old" }, true);
  await assert.rejects(verifyRecovery(driver, state));
  assert.equal(state.phase, "rollback_failed");
  assert.equal(held, true);
});
