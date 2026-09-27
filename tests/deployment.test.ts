import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { audit } from "../scripts/audit-publication.mjs";
const read = (file: string) =>
  readFile(path.join("deploy/debian", file), "utf8");
test("Debian units use fixed service identity, external state, boot and restart supervision", async () => {
  for (const unit of [
    "codexbridge",
    "codexbridge-tunnel",
    "codexbridge-update",
    "codexbridge-recover",
    "codexbridge-recovery-health",
  ]) {
    const text = await read(unit + ".service");
    assert.match(text, /^User=codexbridge$/m);
    assert.match(text, /^Group=codexbridge$/m);
    assert.match(
      text,
      /^Environment=CODEXBRIDGE_HOME=\/var\/lib\/codexbridge$/m,
    );
    assert.match(text, /^UMask=0077$/m);
    assert.match(text, /^StandardOutput=journal$/m);
    assert.doesNotMatch(text, /\r|\uFEFF|User=root|ExecStart=.*(?:sh -c|sudo)/);
    if (["codexbridge", "codexbridge-tunnel"].includes(unit)) {
      assert.match(text, /^Restart=always$/m);
      assert.match(text, /^WantedBy=multi-user.target$/m);
      assert.match(text, /^KillMode=control-group$/m);
    }
  }
  const main = await read("codexbridge.service");
  assert.match(main, /^Requires=codexbridge-recover.service$/m);
  // sudo remains usable for the tiny control wrapper, never general commands.
  assert.doesNotMatch(main, /^NoNewPrivileges=true$/m);
  const updater = await read("codexbridge-update.service");
  assert.match(
    updater,
    /ExecStart=\/usr\/bin\/node \/usr\/local\/lib\/codexbridge\/self-update.mjs/,
  );
  assert.doesNotMatch(updater, /PartOf=|BindsTo=|Requires=codexbridge.service/);
});
test("root control wrapper and sudoers allow only exact verbs and fixed units", async () => {
  const control = await read("codexbridge-control");
  assert.match(control, /\[ "\$#" -eq 1 \] \|\| exit 64/);
  assert.match(control, /start\|stop\|restart\)/);
  for (const verb of ["status", "is-active", "logs", "update"])
    assert.ok(control.includes(verb + ")"));
  assert.match(control, /\*\) exit 64/);
  assert.doesNotMatch(control, /eval|sh -c|\$@|\$2|source |\. \/|\r|\uFEFF/);
  const sudo = (await read("sudoers"))
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .join("\n");
  assert.equal(sudo.split("NOPASSWD:")[1].split(",").length, 7);
  assert.doesNotMatch(sudo, /\*|\/bin\/(?:sh|bash)|SETENV|NOPASSWD: ALL/);
  for (const entry of sudo.split("NOPASSWD:")[1].split(","))
    assert.match(
      entry.trim(),
      /^\/usr\/local\/sbin\/codexbridge-control (start|stop|restart|status|is-active|logs|update)$/,
    );
  const install = await read("install.sh");
  assert.match(
    install,
    /install -o root -g root -m 0755 deploy\/debian\/codexbridge-control/,
  );
  assert.match(install, /visudo -cf deploy\/debian\/sudoers/);
  assert.match(install, /if \[ ! -e \/etc\/codexbridge\/environment \]/);
  assert.match(
    install,
    /systemctl enable codexbridge.service codexbridge-tunnel.service/,
  );
  assert.doesNotMatch(install, /systemctl (?:start|restart)|rm -rf|\r|\uFEFF/);
});
test("publication excludes runtime paths and detects accidentally tracked credentials", async () => {
  const probes = [
    ".env",
    ".env.production",
    ".codexbridge/jobs.db",
    ".test-tmp/state",
    "logs/a.jsonl",
    "worktrees/CB-1/file",
    "state.sqlite-wal",
    "auth.json",
    "secret.pem",
    "node_modules/test",
    "dist/main.js",
  ];
  const ignored = execFileSync("git", ["check-ignore", "--stdin"], {
    input: probes.join("\n"),
    encoding: "utf8",
  })
    .trim()
    .split(/\r?\n/);
  assert.deepEqual(ignored, probes);
  const dir = await mkdtemp(path.join(os.tmpdir(), "cb-audit-"));
  execFileSync("git", ["init", dir], { stdio: "ignore" });
  await writeFile(path.join(dir, ".gitignore"), ".env\n*.db\n");
  await writeFile(path.join(dir, ".env"), "not-a-real-secret");
  await writeFile(path.join(dir, "state.db"), "fixture");
  execFileSync("git", ["-C", dir, "add", "-f", ".env", "state.db"]);
  await mkdir(path.join(dir, "src"));
  await writeFile(
    path.join(dir, "src", "leak.ts"),
    'const value = "' + "gh" + "p_" + "a".repeat(36) + '";',
  );
  const result = audit(dir);
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((f: any) => f.file === ".env"));
  assert.ok(result.findings.some((f: any) => f.file === "state.db"));
  assert.ok(result.findings.some((f: any) => f.file === "src/leak.ts"));
  assert.equal(JSON.stringify(result).includes("a".repeat(36)), false);
});

test("post-boot health unit runs after server and tunnel without a dependency cycle", async () => {
  const health = await read("codexbridge-recovery-health.service");
  assert.match(
    health,
    /^After=codexbridge.service codexbridge-tunnel.service$/m,
  );
  assert.match(health, /self-update.mjs --verify-recovery/);
  assert.match(health, /^WantedBy=multi-user.target$/m);
  for (const name of [
    "codexbridge",
    "codexbridge-tunnel",
    "codexbridge-recover",
  ]) {
    const unit = await read(name + ".service");
    assert.doesNotMatch(
      unit,
      /^(?:After|Requires)=.*codexbridge-recovery-health/m,
    );
  }
  assert.match(
    await read("install.sh"),
    /systemctl enable .*codexbridge-recovery-health.service/,
  );
});
