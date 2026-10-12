import { z } from "zod";
import type { Store } from "./database.js";
import { redact } from "./log.js";

const statuses = [
  "READY_FOR_HUMAN_TEST",
  "WAITING_FOR_HUMAN",
  "FAILED",
  "COMPLETED",
] as const;
export const attentionSchema = z.strictObject({
  eventId: z.number().int().nonnegative(),
  jobId: z.string(),
  time: z.string(),
  status: z.enum(statuses),
  blocker: z.string().max(400).nullable(),
  detail: z.string(),
});
export type Attention = z.infer<typeof attentionSchema>;

// Pure future policy boundary: no Store, executor, network or credentials.
// V0 never invokes policies. Recommendations cannot authorize execution.
export interface SentinelPolicy {
  evaluate(event: Readonly<Attention>): Readonly<{
    kind: "ignore" | "recommend";
    reason: string;
    requiresHumanAuthorization: "[REDACTED]"
  }>;
}

const key = "sentinel:mini:v0";
const stateSchema = z.strictObject({
  cursor: z.number().int().nonnegative(),
  latestEventId: z.number().int().nonnegative().default(0),
  summaries: z.array(attentionSchema).max(100),
});
export const sentinelReportSchema = stateSchema.extend({
  mode: z.literal("observe"),
  observation: z.enum(["disabled", "observing", "stopped", "error"]),
  replayPending: z.boolean(),
});
const actionable = new Set(statuses.map((status) => `JOB_${status}`));
const windowSize = 4096;
const filter =
  "type IN ('JOB_READY_FOR_HUMAN_TEST','JOB_WAITING_FOR_HUMAN','JOB_FAILED','JOB_COMPLETED')";
// Both ends are bounded by event ID: LIMIT alone would allow an unbounded scan
// through token events. The existing INTEGER PRIMARY KEY serves both queries.
export const sentinelReplayQuery = `SELECT id,job_id,time,type FROM job_events WHERE id>? AND id<=? AND ${filter} ORDER BY id LIMIT 128`;
export const sentinelTailQuery = `SELECT id,job_id,time,type FROM job_events WHERE id>? AND id<=? AND ${filter} ORDER BY id DESC LIMIT 100`;

export class SentinelMini {
  private state: z.infer<typeof stateSchema> = {
    cursor: 0,
    latestEventId: 0,
    summaries: [],
  };
  private observation: "disabled" | "observing" | "stopped" | "error" =
    "disabled";
  private fallback?: NodeJS.Timeout;
  private pending?: NodeJS.Timeout;
  private readonly onEvent = (_id: string, type: string) => {
    if (
      !actionable.has(type) ||
      this.pending ||
      this.observation !== "observing"
    )
      return;
    // Coalesce bursts and keep observer work out of lifecycle transactions.
    this.pending = setTimeout(() => {
      this.pending = undefined;
      this.tick();
    }, 1000);
    this.pending.unref();
  };

  constructor(
    private readonly store: Store,
    enabled = false,
  ) {
    if (!enabled) return; // No DB access or listeners when disabled.
    try {
      this.state = store.transaction(() => {
        const row = store.db
          .prepare("SELECT value FROM settings WHERE key=?")
          .get(key);
        if (row) return stateSchema.parse(JSON.parse(String(row.value)));
        // First opt-in observes new events only. Persist before listening, so a
        // restart before the first tick cannot silently reset the starting point.
        const latestEventId = this.latestId();
        const state = { cursor: latestEventId, latestEventId, summaries: [] };
        store.db
          .prepare("INSERT INTO settings(key,value) VALUES(?,?)")
          .run(key, JSON.stringify(state));
        return state;
      });
      this.observation = "observing";
      store.on("event", this.onEvent);
      this.fallback = setInterval(() => this.tick(), 30_000);
      this.fallback.unref();
      this.onEvent("", "JOB_COMPLETED"); // One bounded restart catch-up pass.
    } catch {
      this.fail();
    }
  }

  // A single bounded pass, also callable for deterministic tests. Never drains
  // recursively. Ordered replay preserves gaps; the recent tail provides fresh
  // attention independently of replay lag, with event-ID dedupe on overlap.
  tick() {
    if (this.observation !== "observing") return;
    try {
      const latestEventId = this.latestId();
      if (latestEventId <= this.state.cursor) return;
      const replayEnd = Math.min(latestEventId, this.state.cursor + windowSize);
      const replay = this.store.db
        .prepare(sentinelReplayQuery)
        .all(this.state.cursor, replayEnd);
      const cursor =
        replay.length === 128 ? Number(replay.at(-1)!.id) : replayEnd;
      const tail =
        latestEventId > cursor
          ? this.store.db
              .prepare(sentinelTailQuery)
              .all(Math.max(cursor, latestEventId - windowSize), latestEventId)
          : [];
      const next = this.store.transaction(() => {
        const summaries = new Map(
          this.state.summaries.map((s) => [s.eventId, s]),
        );
        for (const row of [...replay, ...tail]) {
          if (summaries.has(Number(row.id))) continue;
          const payload = this.store.db
            .prepare(
              "SELECT substr(data,1,4096) AS data FROM job_events WHERE id=?",
            )
            .get(row.id)!;
          let blocker: string | null = null;
          try {
            const data = JSON.parse(String(payload.data));
            if (typeof data?.blocker === "string")
              blocker = redact(data.blocker)
                .replace(/[\x00-\x1f\x7f]/g, " ")
                .slice(0, 400);
          } catch {
            blocker = "Detail omitted; inspect the job event.";
          }
          summaries.set(Number(row.id), {
            eventId: Number(row.id),
            jobId: String(row.job_id),
            time: String(row.time),
            status: String(row.type).slice(4) as Attention["status"],
            blocker,
            detail: `get_job / get_job_events: ${row.job_id}`,
          });
        }
        const state = {
          cursor,
          latestEventId,
          summaries: [...summaries.values()]
            .sort((a, b) => a.eventId - b.eventId)
            .slice(-100),
        };
        this.store.db
          .prepare("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)")
          .run(key, JSON.stringify(state));
        return state;
      });
      this.state = next; // Publish only after cursor and summaries commit together.
    } catch {
      this.fail(); // No exception or raw error detail reaches jobs or callers.
    }
  }

  report() {
    return sentinelReportSchema.parse({
      ...this.state,
      mode: "observe",
      observation: this.observation,
      replayPending: this.state.cursor < this.state.latestEventId,
    });
  }
  private latestId() {
    return Number(
      this.store.db
        .prepare("SELECT COALESCE(MAX(id),0) AS id FROM job_events")
        .get()!.id,
    );
  }
  stop() {
    if (this.fallback) clearInterval(this.fallback);
    if (this.pending) clearTimeout(this.pending);
    this.store.off("event", this.onEvent);
    if (this.observation === "observing") this.observation = "stopped";
  }
  private fail() {
    this.stop();
    this.observation = "error";
  }
}

