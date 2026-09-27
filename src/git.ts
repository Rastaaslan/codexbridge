import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath, mkdir, lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";
import type { Job } from "./domain.js";
const exec = promisify(execFile);
export async function git(cwd: string, args: string[]) {
  const { stdout } = await exec(
    "git",
    ["-c", "core.hooksPath=/dev/null", ...args],
    {
      cwd,
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
      },
    },
  );
  return stdout.trimEnd();
}
export function inside(root: string, target: string) {
  const rel = path.relative(root, target);
  return (
    rel === "" ||
    (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel))
  );
}
export class GitWorkspace {
  constructor(private config: Config) {}
  async resolve(repo: string, ref: string) {
    const commit = await git(repo, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${ref}^{commit}`,
    ]);
    if (!/^[0-9a-f]{40,64}$/.test(commit))
      throw new Error("Invalid resolved commit");
    return commit;
  }
  async repository(input: string) {
    if (!path.isAbsolute(input) || input.includes("\0"))
      throw new Error("Repository must be an absolute path.");
    const repo = await realpath(input);
    const roots = await Promise.all(
      this.config.repositoryRoots.map((r) => realpath(r)),
    );
    if (!roots.some((r) => inside(r, repo)))
      throw new Error("Repository is outside configured repositoryRoots.");
    const top = await realpath(
      await git(repo, ["rev-parse", "--show-toplevel"]),
    );
    if (top !== repo)
      throw new Error("Use the Git repository root, not a subdirectory.");
    await git(repo, ["rev-parse", "HEAD"]);
    return repo;
  }
  async plan(job: Job) {
    const repo = await this.repository(job.repository);
    const root = path.join(this.config.dataDir, "worktrees");
    await mkdir(root, { recursive: true });
    const worktree = path.join(await realpath(root), job.id);
    if (!/^CB-\d+$/.test(job.id)) throw new Error("Invalid job id");
    return {
      worktree,
      branch: `codexbridge/${job.id}`,
      baseCommit:
        job.baseCommit ?? (await this.resolve(repo, job.startRef ?? "HEAD")),
    };
  }
  async prepare(job: Job) {
    await this.repository(job.repository);
    if (!job.worktree || !job.branch || !job.baseCommit)
      throw new Error("Worktree plan missing");
    const expected = path.join(
      await realpath(path.join(this.config.dataDir, "worktrees")),
      job.id,
    );
    if (job.worktree !== expected)
      throw new Error("Worktree path does not match the job");
    try {
      await lstat(job.worktree);
      await this.validate(job);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      await git(job.repository, [
        "worktree",
        "add",
        "-b",
        job.branch,
        job.worktree,
        job.baseCommit,
      ]);
    }
    await this.validate(job);
  }
  async validate(job: Job) {
    if (!job.worktree) throw new Error("Worktree not prepared");
    const actual = await realpath(job.worktree);
    if (actual !== job.worktree)
      throw new Error("Worktree symlink not allowed");
    if ((await git(actual, ["branch", "--show-current"])) !== job.branch)
      throw new Error("Worktree branch mismatch");
    const common = await realpath(
      path.resolve(
        actual,
        await git(actual, ["rev-parse", "--git-common-dir"]),
      ),
    );
    const origin = await realpath(
      path.resolve(
        job.repository,
        await git(job.repository, ["rev-parse", "--git-common-dir"]),
      ),
    );
    if (common !== origin)
      throw new Error("Worktree belongs to another repository");
  }
  async diff(job: Job) {
    if (!job.worktree)
      return {
        diff: "",
        changedFiles: [] as string[],
        commits: "",
        status: "",
        truncated: false,
      };
    await this.repository(job.repository);
    await this.validate(job);
    const status = await git(job.worktree, ["status", "--short"]);
    const tracked = await git(job.worktree, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      job.baseCommit!,
      "--",
    ]);
    const untracked = (
      await git(job.worktree, [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
      ])
    )
      .split("\0")
      .filter(Boolean);
    let extra = "";
    let truncated = false;
    for (const f of untracked) {
      const full = path.resolve(job.worktree, f);
      if (!inside(job.worktree, full)) throw new Error("Invalid Git path");
      const stat = await lstat(full);
      if (stat.isSymbolicLink()) {
        extra += `\nNew symlink: ${f}\n`;
        continue;
      }
      if (stat.size > 100000) {
        extra += `\nNew file omitted (size): ${f}\n`;
        truncated = true;
        continue;
      }
      extra +=
        `\n--- /dev/null\n+++ b/${f}\n` +
        (await readFile(full, "utf8"))
          .split("\n")
          .map((l) => "+" + l)
          .join("\n");
    }
    const diff = tracked + extra;
    return {
      diff: diff.slice(0, 500000),
      changedFiles: [
        ...new Set([
          ...(
            await git(job.worktree, [
              "diff",
              "--name-only",
              "-z",
              job.baseCommit!,
              "--",
            ])
          )
            .split("\0")
            .filter(Boolean),
          ...untracked,
        ]),
      ],
      status,
      commits: await git(job.worktree, [
        "log",
        "--oneline",
        `${job.baseCommit}..HEAD`,
      ]),
      truncated: truncated || diff.length > 500000,
    };
  }
}
