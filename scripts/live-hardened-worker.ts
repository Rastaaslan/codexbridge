import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AppServerAdapter } from "../src/codex.js";
import { configSchema } from "../src/config.js";
import { git, inside } from "../src/git.js";

// No service, production configuration, reviewer, or external MCP connection.
// CODEX_HOME is scoped to the child runtime by the launcher below.
const root = await realpath(fileURLToPath(new URL("..", import.meta.url)));
const temporaryRoot = path.join(root, ".test-tmp");
await mkdir(temporaryRoot, { recursive: true });
const homeArgument = process.argv[2];
if (process.platform !== "linux" || !homeArgument)
  throw Error(
    "Usage on Linux: npm run test:live-hardened -- .test-tmp/test-codex-home (authenticate this test-only home first)",
  );
const sessionHome = await realpath(homeArgument);
assert.ok(
  inside(await realpath(temporaryRoot), sessionHome),
  "Session storage must be inside this worktree's .test-tmp",
);
assert.notEqual(sessionHome, await realpath(temporaryRoot));
const dir = await mkdtemp(path.join(temporaryRoot, "live-hardened-"));
const repo = path.join(dir, "repository");
const worktree = path.join(dir, "worker");
const execute = promisify(execFile);
const report: Record<string, any> = {
  commit: await git(root, ["rev-parse", "HEAD"]),
  trackedChanges: await git(root, ["diff", "HEAD", "--name-only"]),
  adapterSha256: createHash("sha256")
    .update(await readFile(path.join(root, "src/codex.ts")))
    .digest("hex"),
  harnessSha256: createHash("sha256")
    .update(await readFile(fileURLToPath(import.meta.url)))
    .digest("hex"),
  startedAt: new Date().toISOString(),
  status: "blocked",
  turns: [],
};
const reportFile = path.join(dir, "report.json");
try {
  await cp(path.join(root, "fixtures/add"), repo, { recursive: true });
  await git(repo, ["init"]);
  await git(repo, [
    "-c",
    "user.name=Validation",
    "-c",
    "user.email=validation@example.invalid",
    "add",
    ".",
  ]);
  await git(repo, [
    "-c",
    "user.name=Validation",
    "-c",
    "user.email=validation@example.invalid",
    "commit",
    "-m",
    "Isolated broken fixture",
  ]);
  const baseline = await git(repo, ["rev-parse", "HEAD"]);
  await git(repo, [
    "worktree",
    "add",
    "-b",
    "validation-worker",
    worktree,
    baseline,
  ]);
  const launcher = path.join(dir, "codex-launcher");
  await writeFile(
    launcher,
    `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const child = spawn('codex', process.argv.slice(2), {
  env: { ...process.env, CODEX_HOME: ${JSON.stringify(sessionHome)} }, stdio: 'inherit'
});
child.on('error', () => process.exit(1));
child.on('exit', code => process.exit(code ?? 1));
`,
    { mode: 0o700 },
  );
  const config = configSchema.parse({
    dataDir: path.join(dir, "state"),
    repositoryRoots: [repo],
    codexCommand: launcher,
    token: "validation-only-".repeat(3),
    timeoutMs: 180000,
  });
  const commonGit = path.resolve(
    worktree,
    await git(worktree, ["rev-parse", "--git-common-dir"]),
  );
  const linkedGit = path.resolve(
    worktree,
    await git(worktree, ["rev-parse", "--git-dir"]),
  );
  const denied = [
    path.join(commonGit, "worker-write-probe"),
    path.join(linkedGit, "worker-write-probe"),
    path.join(dir, "outside-worker-probe"),
  ];
  await writeFile(
    path.join(worktree, "sandbox-probe.mjs"),
    `
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
for (const file of ${JSON.stringify(denied)}) {
  await assert.rejects(writeFile(file, 'forbidden', {flag:'wx'}),
    e => ['EACCES', 'EPERM', 'EROFS'].includes(e.code), 'worker must not write ' + file);
}
console.log('SANDBOX_WRITE_RESTRICTIONS_PASSED');
`,
  );
  const probeBytes = await readFile(path.join(worktree, "sandbox-probe.mjs"));
  let previousTests = await readFile(
    path.join(worktree, "add.test.js"),
    "utf8",
  );
  let threadId: string | undefined;
  for (const turn of [1, 2]) {
    const record: Record<string, any> = { turn, commands: [] };
    report.turns.push(record);
    const prompt =
      turn === 1
        ? "Fix add.js to compute the exact sum. Add named tests for negative, zero and decimal addition in add.test.js."
        : "Resume the existing task. Preserve all existing tests and append a test named 'resume fractional regression' asserting add(-0.5, 0.25) equals -0.25.";
    const expectedThread = threadId;
    const result = await new AppServerAdapter(config).run({
      cwd: worktree,
      threadId,
      prompt: `${prompt} Execute node sandbox-probe.mjs and node --test --test-reporter=tap add.test.js as separate commands. Do not edit sandbox-probe.mjs. Do not commit. Report completed only if both commands succeed.`,
      schema: z.object({ status: z.literal("completed"), summary: z.string() }),
      signal: AbortSignal.timeout(config.timeoutMs + 5000),
      onThread: (id) => {
        record.threadId = id;
        threadId = id;
      },
      onPid: () => {},
      onEvent: (type, data: any) => {
        if (type === "CODEX_ITEM" && data?.type === "commandExecution")
          record.commands.push({
            command: data.command,
            exitCode: data.exitCode,
            output: data.aggregatedOutput,
          });
      },
    });
    record.result = result;
    assert.deepEqual(
      await readFile(path.join(worktree, "sandbox-probe.mjs")),
      probeBytes,
      "Worker must not weaken sandbox assertions",
    );
    const currentTests = await readFile(
      path.join(worktree, "add.test.js"),
      "utf8",
    );
    if (turn === 2)
      assert.ok(
        currentTests.startsWith(previousTests),
        "Resume must preserve existing tests and append the regression",
      );
    previousTests = currentTests;
    assert.ok(threadId, "Actual thread must start");
    if (turn === 2)
      assert.equal(
        threadId,
        expectedThread,
        "Resume must preserve thread identity",
      );
    const commands = record.commands as any[];
    assert.ok(
      commands.some(
        (c) =>
          c.exitCode === 0 &&
          c.command.includes("node sandbox-probe.mjs") &&
          c.output?.includes("SANDBOX_WRITE_RESTRICTIONS_PASSED"),
      ),
      "Worker must execute the sandbox assertions successfully",
    );
    assert.ok(
      commands.some(
        (c) =>
          c.exitCode === 0 &&
          c.command.includes("node --test") &&
          /# fail 0\b/.test(c.output ?? ""),
      ),
      "Worker must execute passing tests, not merely report them",
    );
    const tests = await execute(
      process.execPath,
      ["--test", "--test-reporter=tap", "add.test.js"],
      { cwd: worktree, timeout: 30000 },
    );
    record.independentTests = tests.stdout;
    assert.match(tests.stdout, /# fail 0\b/);
    assert.ok(
      Number(tests.stdout.match(/# tests (\d+)/)?.[1]) >= (turn === 1 ? 4 : 5),
    );
    if (turn === 2) assert.match(tests.stdout, /resume fractional regression/);
    assert.equal(await git(repo, ["status", "--porcelain"]), "");
    assert.equal(await git(repo, ["rev-parse", "HEAD"]), baseline);
    assert.equal(await git(worktree, ["rev-parse", "HEAD"]), baseline);
    const diff = await git(worktree, ["diff", "--name-only"]);
    assert.ok(diff.includes("add.js") && diff.includes("add.test.js"));
    console.log(
      `Turn ${turn}: edits, sandbox restrictions, worker tests and independent tests passed`,
    );
  }
  report.status = "passed";
  console.log("LIVE HARDENED WORKER AND SAME-THREAD RESUME PASSED");
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(reportFile, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(`Evidence: ${reportFile}`);
}
