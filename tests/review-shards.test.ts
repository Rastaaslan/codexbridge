import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { shardReviewDiff, REVIEW_TOTAL_LIMIT } from "../src/integration.js";
import { AutomaticReviewer } from "../src/reviewer.js";
import { configSchema } from "../src/config.js";
import type { Job } from "../src/domain.js";
import type { CodexAdapter } from "../src/codex.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const fakeJob = {
  id: "CB-999",
  worktree: process.cwd(),
  title: "Large WorldPrep integration",
  ticket: "Review full changes",
  acceptanceCriteria: ["Compile source", "Test journal rollback"],
  result: {
    testsPassed: true,
    testsExecuted: ["javac --release 21", "6 native GameTests"],
    status: "completed",
  },
} as unknown as Job;
const config = configSchema.parse({
  dataDir: ".codexbridge",
  token: "a".repeat(64),
  reviewer: "codex",
});
const opts = {
  signal: new AbortController().signal,
  onEvent(_name: string, _data: unknown) {},
  onPid(_pid: number | null) {},
};
const accept = (summary = "Reviewed this actual patch segment") => ({
  decision: "ACCEPT" as const,
  summary,
  issues: [],
  requestedChanges: [],
  humanQuestion: null,
});
const source =
  "diff --git a/new.rs b/new.rs\n--- /dev/null\n+++ b/new.rs\n" +
  Array.from(
    { length: 19500 },
    (_, i) => "+fn test_" + i + '() -> String { format!("safe-' + i + '") }\n',
  ).join("");
test("large source diff splits into bounded complete, bit-identical segments", () => {
  assert(source.length > 500000);
  const chunks = shardReviewDiff(source);
  assert.ok(chunks && chunks.length > 1);
  assert.ok(chunks.every((s) => s.length > 0 && s.length <= 185000));
  assert.equal(chunks.join(""), source);
  assert.equal(sha(chunks.join("")), sha(source));
  const emoji = "😀".repeat(300000);
  const shardEmoji = shardReviewDiff(emoji);
  assert.equal(shardEmoji?.join(""), emoji);
  assert.equal(shardReviewDiff("small"), null);
  assert.equal(shardReviewDiff("x".repeat(REVIEW_TOTAL_LIMIT + 1)), null);
});
test("full source must be reviewed segment-by-segment and globally", async () => {
  const chunks = shardReviewDiff(source)!;
  let calls = 0;
  const fragments: string[] = [];
  const mock = {
    async run(input: { prompt: string; readOnly: boolean; cwd: string }) {
      assert.equal(input.readOnly, true);
      assert.equal(input.cwd, fakeJob.worktree);
      fragments.push(input.prompt);
      calls++;
      return accept();
    },
  } as unknown as CodexAdapter;
  const reviewer = new AutomaticReviewer(config, mock);
  const review = await reviewer.reviewAllChunks(
    {
      job: fakeJob,
      diff: {
        diff: source.slice(0, 500000),
        reviewChunks: chunks,
        fullDiffSha256: sha(source),
        truncated: true,
        changedFiles: ["new.rs"],
      },
      history: [],
    },
    opts,
  );
  assert.equal(review.review.decision, "ACCEPT");
  assert.equal(review.coverageSha256, sha(source));
  assert.equal(calls, chunks.length + 1);
  for (let i = 0; i < chunks.length; i++) {
    const context = JSON.parse(
      fragments[i].slice(fragments[i].indexOf('{"job":')),
    );
    assert.equal(context.diff.source, chunks[i]);
    assert.match(fragments[i], /ONE COMPLETE SEGMENT/);
    if (i < chunks.length - 1)
      assert.notEqual(context.diff.source, chunks[i + 1]);
  }
  assert.match(fragments.at(-1)!, /cross-file implications/);
  assert.ok(!fragments.at(-1)!.includes(source.slice(0, 3000)));
});
test("tampered, omitted or overlong coverage cannot authorize anything", async () => {
  let calls = 0;
  const reviewer = new AutomaticReviewer(config, {
    async run() {
      calls++;
      return accept();
    },
  } as unknown as CodexAdapter);
  const chunks = shardReviewDiff(source)!;
  for (const diff of [
    {
      diff: source.slice(0, 500000),
      reviewChunks: chunks.slice(0, -1),
      fullDiffSha256: sha(source),
      truncated: true,
    },
    {
      diff: source.slice(0, 500000),
      reviewChunks: chunks,
      fullDiffSha256: "0".repeat(64),
      truncated: true,
    },
    {
      diff: source.slice(0, 500000),
      reviewChunks: [],
      fullDiffSha256: sha(source),
      truncated: true,
    },
    {
      diff: source.slice(0, 500000),
      reviewChunks: null,
      fullDiffSha256: sha(source),
      truncated: true,
    },
    {
      diff: source.slice(0, 500000),
      reviewChunks: chunks,
      fullDiffSha256: sha(source),
      truncated: false,
    },
  ]) {
    const outcome = await reviewer.reviewAllChunks(
      { job: fakeJob, diff, history: [] },
      opts,
    );
    assert.equal(outcome.coverageSha256, null);
    assert.equal(outcome.review.decision, "HUMAN_REQUIRED");
  }
  assert.equal(calls, 0);
});
test("a failed segment or final holistic review prevents completed proof", async () => {
  const chunks = shardReviewDiff(source)!;
  for (const rejectAt of [2, chunks.length + 1]) {
    let calls = 0;
    const adapter = {
      async run() {
        calls++;
        return calls === rejectAt
          ? {
              decision: "REQUEST_CHANGES",
              summary: "Real code regression",
              issues: ["Concrete file mismatch"],
              requestedChanges: ["Fix the mismatch"],
              humanQuestion: null,
            }
          : accept();
      },
    } as unknown as CodexAdapter;
    const reviewer = new AutomaticReviewer(config, adapter);
    const outcome = await reviewer.reviewAllChunks(
      {
        job: fakeJob,
        diff: {
          diff: source.slice(0, 500000),
          reviewChunks: chunks,
          fullDiffSha256: sha(source),
          changedFiles: ["new.rs"],
          truncated: true,
        },
        history: [],
      },
      opts,
    );
    assert.equal(outcome.review.decision, "REQUEST_CHANGES");
    assert.equal(outcome.coverageSha256, null);
    assert.equal(calls, rejectAt);
  }
});
