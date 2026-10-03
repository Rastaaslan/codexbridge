import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLiveCodexLauncher } from "../scripts/live-codex-launcher.js";

test(
  "live launcher starts inside an ESM package and forwards arguments, isolated home and exit status",
  { skip: process.platform === "win32" },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cb-live-launcher-"));
    const execute = promisify(execFile);
    const parentHome = process.env.CODEX_HOME;
    try {
      await writeFile(
        path.join(dir, "package.json"),
        JSON.stringify({ type: "module" }),
      );
      const stub = path.join(dir, "stub codex.cjs");
      await writeFile(
        stub,
        `#!/usr/bin/env node
console.log(JSON.stringify({ args: process.argv.slice(2), home: process.env.CODEX_HOME }));
console.error('stub stderr forwarded');
process.exit(process.argv.includes('--fail') ? 27 : 0);
`,
        { mode: 0o700 },
      );
      const sessionHome = path.join(dir, "test session's home");
      const launcher = await createLiveCodexLauncher(dir, sessionHome, stub);
      const args = [
        "app-server",
        "--listen",
        "stdio://",
        "argument with spaces",
        "$(literal)",
      ];
      const result = await execute(launcher, args, {
        cwd: dir,
        timeout: 10000,
      });
      assert.deepEqual(JSON.parse(result.stdout), { args, home: sessionHome });
      assert.equal(result.stderr.trim(), "stub stderr forwarded");
      await assert.rejects(
        execute(launcher, ["--fail"], { cwd: dir, timeout: 10000 }),
        (error: any) => {
          assert.equal(error.code, 27);
          assert.deepEqual(JSON.parse(error.stdout), {
            args: ["--fail"],
            home: sessionHome,
          });
          assert.equal(error.stderr.trim(), "stub stderr forwarded");
          return true;
        },
      );
      assert.equal(
        process.env.CODEX_HOME,
        parentHome,
        "Parent session storage must remain unchanged",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
