import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSchema, jobSchema, errorMessage } from "./domain.js";
import type { Orchestrator } from "./orchestrator.js";
import {
  doctor,
  overview,
  recentLogs,
  requestUpdate,
  control,
  maintenance,
} from "./headless.js";
import { refSchema, activeStatuses } from "./domain.js";
import { redact } from "./log.js";
const id = z.string().regex(/^CB-\d+$/);
const idSchema = z.strictObject({ id });
const eventSchema = z.strictObject({
  id: z.number(),
  time: z.string(),
  type: z.string(),
  data: z.unknown(),
});
const diffSchema = z.strictObject({
  diff: z.string(),
  changedFiles: z.array(z.string()),
  commits: z.string(),
  status: z.string(),
  truncated: z.boolean(),
});
export function toolDefinitions(core: Orchestrator) {
  const definitions: {
    name: string;
    description: string;
    input: z.ZodType;
    output: z.ZodType;
    readOnly: boolean;
    run: (a: any) => Promise<any>;
  }[] = [
    {
      name: "create_job",
      description:
        "Create and queue an isolated Codex coding job. The service continues autonomously through review. Supply an absolute allowed repository path and a stable idempotencyKey to avoid duplicate submissions.",
      input: createSchema,
      output: z.strictObject({ job: jobSchema }),
      readOnly: false,
      run: async (a: any) => ({ job: await core.create(a) }),
    },
    {
      name: "get_job",
      description:
        "Read persistent status, iteration, Codex thread, result and any precise human blocker.",
      input: idSchema,
      output: z.strictObject({ job: jobSchema }),
      readOnly: true,
      run: async (a: any) => ({ job: core.store.get(a.id) }),
    },
    {
      name: "list_jobs",
      description:
        "List jobs, newest first, with optional status filtering and pagination.",
      input: z.strictObject({
        status: z.string().optional(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(50),
      }),
      output: z.strictObject({ jobs: z.array(jobSchema), total: z.number() }),
      readOnly: true,
      run: async (a: any) => {
        const jobs = core.store
          .list()
          .filter((j) => !a.status || j.status === a.status);
        return {
          jobs: jobs.slice(a.offset, a.offset + a.limit),
          total: jobs.length,
        };
      },
    },
    {
      name: "get_job_events",
      description:
        "Read ordered activity and logs after an event cursor. Use the last id as after to fetch more.",
      input: idSchema.extend({
        after: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(500).default(300),
      }),
      output: z.strictObject({ events: z.array(eventSchema) }),
      readOnly: true,
      run: async (a: any) => ({
        events: core.store.events(a.id, a.after, a.limit),
      }),
    },
    {
      name: "get_job_report",
      description:
        "Retrieve ticket, result, tests, review history, decisions, branch, commits and human testing instructions.",
      input: idSchema,
      output: z.strictObject({
        job: jobSchema,
        changes: z.unknown(),
        reviews: z.array(z.unknown()),
        humanDecisions: z.array(z.unknown()),
        humanTestingInstructions: z.string(),
      }),
      readOnly: true,
      run: async (a: any) => core.report(a.id),
    },
    {
      name: "get_job_diff",
      description:
        "Inspect changes against the original base commit, including untracked files, Git status and commits.",
      input: idSchema,
      output: diffSchema,
      readOnly: true,
      run: async (a: any) => core.git.diff(core.store.get(a.id)),
    },
  ];
  for (const [name, action, description] of [
    [
      "send_instruction",
      "send_instruction",
      "Resume a paused or finished-review job in its existing Codex thread with human feedback. Active jobs must first be cancelled.",
    ],
    [
      "approve_job",
      "approve",
      "Confirm functional human testing and mark a READY_FOR_HUMAN_TEST job COMPLETED. Does not merge or push.",
    ],
    [
      "reject_job",
      "reject",
      "Reject a reviewed result with a concrete reason and resume the same Codex thread.",
    ],
    [
      "cancel_job",
      "cancel",
      "Interrupt an active job and preserve its worktree and history.",
    ],
    [
      "retry_job",
      "retry",
      "Retry a failed or cancelled job safely using its existing worktree and thread; adds up to five passages.",
    ],
  ])
    definitions.push({
      name,
      description,
      input: idSchema.extend({
        instruction:
          action === "send_instruction" || action === "reject"
            ? z.string().trim().min(1).max(100000)
            : z.string().max(100000).default(""),
      }),
      output: z.strictObject({ job: jobSchema }),
      readOnly: false,
      run: async (a: any) => ({
        job: await core.action(a.id, action, a.instruction),
      }),
    });
  definitions.push(
    {
      name: "server_doctor",
      description:
        "Application health and tunnel availability, release, maintenance and persisted update outcome. Degraded tunnel does not imply an unhealthy application.",
      input: z.strictObject({}),
      output: z.strictObject({
        ok: z.boolean(),
        orchestratorOk: z.boolean(),
        availability: z.enum(["ready", "degraded", "unhealthy"]),
        tunnel: z.enum(["ready", "degraded", "not_checked"]),
        checks: z.array(
          z.strictObject({
            name: z.string(),
            ok: z.boolean(),
            detail: z.string(),
          }),
        ),
        release: z.string().nullable(),
        maintenance: z.boolean(),
        managed: z.boolean(),
        update: z.unknown(),
      }),
      readOnly: true,
      run: async () => doctor(core),
    },
    {
      name: "jobs_overview",
      description:
        "Compact project/job counts and the ten newest items needing human attention.",
      input: z.strictObject({}),
      output: z.strictObject({
        counts: z.record(z.string(), z.number()),
        projects: z.array(
          z.strictObject({
            repository: z.string(),
            counts: z.record(z.string(), z.number()),
          }),
        ),
        attention: z.array(
          z.strictObject({
            id: z.string(),
            title: z.string(),
            status: z.string(),
            blocker: z.string().nullable(),
          }),
        ),
      }),
      readOnly: true,
      run: async () => overview(core),
    },
    {
      name: "server_logs",
      description:
        "Recent redacted application logs from today, bounded to 64 KiB.",
      input: z.strictObject({
        limit: z.number().int().min(1).max(100).default(30),
      }),
      output: z.strictObject({
        lines: z.array(z.string()),
        truncated: z.boolean(),
      }),
      readOnly: true,
      run: async (a) => recentLogs(core, a.limit),
    },
    {
      name: "restart_service",
      description:
        "Request a managed Debian restart when no jobs are running. Connection may close; reconnect and call server_doctor.",
      input: z.strictObject({}),
      output: z.strictObject({ accepted: z.boolean() }),
      readOnly: false,
      run: async () => {
        if (
          maintenance(core.config.dataDir) ||
          core.store.list().some((j) => activeStatuses.includes(j.status))
        )
          throw Error(
            "Service busy; wait or cancel active jobs before restart.",
          );
        core.restarting = true;
        try {
          await control("restart");
        } catch (e) {
          core.restarting = false;
          throw e;
        }
        return { accepted: true };
      },
    },
    {
      name: "self_update",
      description:
        "Queue an explicit Git ref from the administrator-configured upstream. Build/tests before activation, automatic rollback on failed health. Read server_doctor for outcome.",
      input: z
        .strictObject({
          ref: refSchema.optional(),
          startRef: refSchema.optional(),
        })
        .refine(
          (a) => Boolean(a.ref) !== Boolean(a.startRef),
          "Supply exactly one of ref or startRef",
        ),
      output: z.strictObject({
        accepted: z.boolean(),
        ref: z.string(),
        statusTool: z.string(),
      }),
      readOnly: false,
      run: async (a) => requestUpdate(core, a.ref ?? a.startRef),
    },
  );
  return definitions;
}
export function createMcp(core: Orchestrator) {
  const server = new McpServer(
    { name: "codexbridge", version: "1.0.0" },
    {
      instructions:
        "CodexBridge is the source of truth. Create a job once, retain its CB-id and query status later. The backend owns the autonomous correction loop. Never claim accepted code has been merged or human-tested. Answer a blocker using send_instruction. Approve only after explicit user confirmation.",
    },
  );
  for (const tool of toolDefinitions(core))
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.input,
        outputSchema: tool.output,
        annotations: {
          readOnlyHint: tool.readOnly,
          destructiveHint: ["cancel_job", "reject_job"].includes(tool.name),
          idempotentHint: tool.readOnly || tool.name === "cancel_job",
          openWorldHint: !tool.readOnly,
        },
        _meta: {
          securitySchemes: core.config.publicUrl
            ? [{ type: "oauth2", scopes: ["codexbridge"] }]
            : [{ type: "noauth" }],
        },
      },
      async (args: any) => {
        try {
          const data = tool.output.parse(
            await tool.run(tool.input.parse(args)),
          );
          const safe = JSON.parse(redact(data));
          return {
            content: [{ type: "text" as const, text: JSON.stringify(safe) }],
            structuredContent: safe,
          };
        } catch (e) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: redact(errorMessage(e)) }],
          };
        }
      },
    );
  return server;
}
