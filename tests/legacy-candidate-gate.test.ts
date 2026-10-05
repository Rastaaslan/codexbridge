import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  symlink,
  realpath,
  rm,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { makeDriver, validateUpdater } from "../scripts/self-update.mjs";
const exec = promisify(execFile);
const deployedHash =
  "3ea3502d7d6588f725c49037c2261b5da90f3e51503050a4eac7d3070fd2011e";

test("actual deployed updater rejects revised candidate through real fetch/build transaction before npm, maintenance or activation", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cb-gate-"));
  try {
    // Reconstruct the exact installed artifact from repository history, including
    // its older fixed /tmp spelling. Hash pins every byte, not merely its API.
    const historical = (
      await exec("git", [
        "show",
        "3a99deafb510a893e607204f3add8805599c69e7:scripts/self-update.mjs",
      ])
    ).stdout;
    const installed = historical
      .replace('import { tmpdir } from "node:os";\n', "")
      .replace(
        'mkdtemp(path.join(tmpdir(), "codexbridge-validation-"))',
        'mkdtemp("/tmp/codexbridge-validation-")',
      );
    assert.equal(
      createHash("sha256").update(installed).digest("hex"),
      deployedHash,
    );
    if (process.env.CB_TEST_INSTALLED_UPDATER)
      assert.equal(
        await readFile(process.env.CB_TEST_INSTALLED_UPDATER, "utf8"),
        installed,
      );
    const oldFile = path.join(dir, "installed.mjs");
    await writeFile(oldFile, installed);
    const old = await import(pathToFileURL(oldFile).href);
    const repo = path.join(dir, "upstream"),
      root = path.join(dir, "root"),
      data = path.join(dir, "data");
    await mkdir(path.join(repo, "deploy/debian"), { recursive: true });
    await mkdir(path.join(root, "releases/old"), { recursive: true });
    await mkdir(data);
    const previous = path.join(root, "releases/old");
    await symlink(previous, path.join(root, "current"));
    const policy = JSON.parse(
      await readFile("deploy/debian/release-policy.json", "utf8"),
    );
    assert.deepEqual(policy, {
      runtimeSchema: 2,
      sqliteSchema: 4,
      minimumUpdaterVersion: 2,
    });
    const git = (args: string[]) =>
      exec("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: repo });
    await git(["init"]);
    await writeFile(
      path.join(repo, "deploy/debian/release-policy.json"),
      JSON.stringify(policy),
    );
    await git(["add", "."]);
    await git([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "candidate policy",
    ]);
    for (const name of [
      "codexbridge.db",
      "codexbridge.db-wal",
      "codexbridge.db-shm",
    ])
      await writeFile(path.join(data, name), "unchanged:" + name);
    const commands: string[] = [];
    const execute = async (command: string, args: string[], options: any) => {
      commands.push(command);
      assert.equal(
        command,
        "git",
        "old flow must reject before npm or service control",
      );
      return exec(command, args, options);
    };
    const driver = await old.makeDriver(
      root,
      data,
      { repository: repo },
      execute,
      () => {
        throw Error("unexpected API call");
      },
    );
    await assert.rejects(
      old.transaction(driver, "HEAD"),
      /Incompatible runtime schema/,
    );
    assert.ok(
      commands.length >= 5,
      "real init/fetch/resolve/clone/checkout exercised",
    );
    assert.equal(await realpath(path.join(root, "current")), previous);
    await assert.rejects(access(path.join(root, "current.next")));
    await assert.rejects(access(path.join(data, "maintenance.json")));
    const journal = JSON.parse(
      await readFile(path.join(data, "update-status.json"), "utf8"),
    );
    assert.equal(journal.phase, "failed");
    assert.match(journal.reason, /Incompatible runtime schema/);
    for (const name of [
      "codexbridge.db",
      "codexbridge.db-wal",
      "codexbridge.db-shm",
    ])
      assert.equal(
        await readFile(path.join(data, name), "utf8"),
        "unchanged:" + name,
      );

    // Matching runner builds the same fetched policy and preserves the new
    // contract in release.json. Only npm is mocked; Git and filesystem are real.
    const modern = await makeDriver(
      root,
      data,
      { repository: repo },
      async (command: string, args: string[], options: any) => {
        if (command === "npm")
          return { stdout: "isolated validation double", stderr: "" };
        assert.equal(command, "git");
        return exec(command, args, options);
      },
    );
    const candidate = await modern.build("HEAD");
    const manifestFile = path.join(candidate, "release.json");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    assert.equal(manifest.runtimeSchema, 2);
    assert.equal(validateUpdater(manifest), 2);
    // With no current release this exercises validation/selection without
    // inventing a historical rollback baseline or bypassing cold snapshots.
    await rm(path.join(root, "current"));
    await modern.activate(candidate);
    assert.equal(await realpath(path.join(root, "current")), candidate);
    for (const runtimeSchema of [1, 3]) {
      await writeFile(
        manifestFile,
        JSON.stringify({ ...manifest, runtimeSchema }),
      );
      await assert.rejects(modern.activate(candidate), /rollback baseline/);
    }
    for (const required of [undefined, 1, 3])
      assert.throws(
        () => validateUpdater({ ...policy, minimumUpdaterVersion: required }),
        /updater/i,
      );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
