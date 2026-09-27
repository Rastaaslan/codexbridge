import { test } from "node:test";
import assert from "node:assert/strict";
import { AutomaticReviewer } from "../src/reviewer.js";
import { configSchema } from "../src/config.js";
import type { Job } from "../src/domain.js";
const config = configSchema.parse({
  dataDir: ".codexbridge",
  token: "x".repeat(64),
  reviewer: "openai",
  reviewerModel: "configured-model",
});
test("Responses reviewer sends strict schema and validates structured response without writing tools", async () => {
  const previous = globalThis.fetch,
    key = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-only-key";
  let request: any;
  globalThis.fetch = async (_url, init) => {
    request = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        output: [
          {
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  decision: "REQUEST_CHANGES",
                  summary: "Missing boundary test",
                  issues: ["edge case"],
                  requestedChanges: ["Test zero"],
                  humanQuestion: null,
                }),
              },
            ],
          },
        ],
      }),
      { status: 200 },
    );
  };
  try {
    const reviewer = new AutomaticReviewer(config, {
      async run() {
        throw Error("Wrong backend");
      },
    });
    const r = await reviewer.review(
      {
        job: {
          ticket: "Fix add",
          acceptanceCriteria: ["zero"],
          result: { testsPassed: false },
        } as unknown as Job,
        diff: "diff",
        history: [],
      },
      { signal: new AbortController().signal, onEvent() {}, onPid() {} },
    );
    assert.equal(r.decision, "REQUEST_CHANGES");
    assert.equal(request.text.format.strict, true);
    assert.equal(request.store, false);
    assert.equal(request.tools, undefined);
    assert.equal(request.text.format.schema.additionalProperties, false);
  } finally {
    globalThis.fetch = previous;
    if (key) process.env.OPENAI_API_KEY = key;
    else delete process.env.OPENAI_API_KEY;
  }
});
test("Responses HTTP failure is explicit and does not leak body or key", async () => {
  const previous = globalThis.fetch,
    key = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-only-key";
  globalThis.fetch = async () =>
    new Response("sensitive server response", { status: 429 });
  try {
    const reviewer = new AutomaticReviewer(config, { async run() {} });
    await assert.rejects(
      () =>
        reviewer.review(
          { job: {} as Job, diff: "", history: [] },
          { signal: new AbortController().signal, onEvent() {}, onPid() {} },
        ),
      /OpenAI reviewer HTTP 429/,
    );
  } finally {
    globalThis.fetch = previous;
    if (key) process.env.OPENAI_API_KEY = key;
    else delete process.env.OPENAI_API_KEY;
  }
});
