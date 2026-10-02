import { z } from "zod";

export const statuses = [
  "CREATED",
  "QUEUED",
  "PREPARING",
  "CODEX_RUNNING",
  "REVIEWING",
  "CHANGES_REQUESTED",
  "WAITING_FOR_HUMAN",
  "ACCEPTED",
  "READY_FOR_HUMAN_TEST",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;
export type Status = (typeof statuses)[number];
export const resultSchema = z.strictObject({
  status: z.enum(["completed", "blocked"]),
  summary: z.string(),
  changedFiles: z.array(z.string()),
  testsExecuted: z.array(z.string()),
  testsPassed: z.boolean(),
  remainingIssues: z.array(z.string()),
  questions: z.array(z.string()),
  requiresHumanDecision: z.boolean(),
});
export const reviewSchema = z.strictObject({
  decision: z.enum(["ACCEPT", "REQUEST_CHANGES", "HUMAN_REQUIRED"]),
  summary: z.string(),
  issues: z.array(z.string()),
  requestedChanges: z.array(z.string()),
  humanQuestion: z.string().nullable(),
});
export type Result = z.infer<typeof resultSchema>;
export type Review = z.infer<typeof reviewSchema>;
export const refSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (ref) =>
      !ref.startsWith("-") &&
      !ref.includes("..") &&
      !/[\s\u0000-\u001f\u007f:]/u.test(ref),
    "Invalid Git ref",
  );
export const projectInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
});
export const projectSchema = projectInputSchema.extend({
  id: z.string(),
  createdAt: z.string(),
});
export const featureInputSchema = projectInputSchema.extend({
  projectId: z.string().regex(/^PR-\d+$/),
});
export const featureSchema = featureInputSchema.extend({
  id: z.string(),
  createdAt: z.string(),
});
export const dependencyIdsSchema = z
  .array(z.string().regex(/^CB-\d+$/))
  .max(100);
export const dependencyStateSchema = z.enum([
  "SATISFIED",
  "WAITING",
  "BLOCKED",
]);
export const schedulingStateSchema = z.enum([
  "READY",
  "WAITING",
  "BLOCKED",
  "INACTIVE",
]);
export const prioritySchema = z.number().int().min(0).max(100);
export const executionCostSchema = z.number().int().min(1).max(1000);
export const retryStateSchema = z.strictObject({
  count: z.number().int().min(0),
  nextRetryAt: z.string().nullable(),
  exhausted: z.boolean(),
  lastError: z.string().nullable(),
});
export const admissionControlSchema = z.strictObject({
  scope: z.enum(["project", "repository"]),
  target: z.string().min(1),
  paused: z.boolean(),
});
export const schedulerSchema = z.strictObject({
  maxConcurrentJobs: z.number(),
  capacity: z.number(),
  usedCapacity: z.number(),
  runningJobs: z.number(),
  repositoryLimits: z.record(z.string(), z.number()),
  pauses: z.array(admissionControlSchema),
});
export const createSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  ticket: z.string().trim().min(1).max(100000),
  repository: z.string().min(1),
  startRef: refSchema.optional(),
  priority: prioritySchema.default(0),
  executionCost: executionCostSchema.default(1),
  projectId: z
    .string()
    .regex(/^PR-\d+$/)
    .optional(),
  featureId: z
    .string()
    .regex(/^FT-\d+$/)
    .optional(),
  dependencies: dependencyIdsSchema.optional(),
  acceptanceCriteria: z.array(z.string().min(1).max(5000)).max(100).default([]),
  options: z
    .strictObject({
      maxIterations: z.number().int().min(1).max(20).default(5),
      idempotencyKey: z.string().min(1).max(100).optional(),
    })
    .default({ maxIterations: 5 }),
});
export type CreateInput = z.infer<typeof createSchema>;
export interface Job extends CreateInput {
  id: string;
  admissionReason: string | null;
  readySince: string | null;
  retry: z.infer<typeof retryStateSchema>;
  pauseState: { project: boolean; repository: boolean };
  status: Status;
  codexThreadId: string | null;
  branch: string | null;
  worktree: string | null;
  baseCommit: string | null;
  iteration: number;
  maxIterations: number;
  createdAt: string;
  updatedAt: string;
  result: Result | null;
  blocker: string | null;
  metadata: Record<string, unknown>;
  feedback: string | null;
  childPid: number | null;
  dependencyState?: z.infer<typeof dependencyStateSchema>;
  schedulingState?: z.infer<typeof schedulingStateSchema>;
  dependencyStatuses?: {
    id: string;
    status: Status;
    state: z.infer<typeof dependencyStateSchema>;
  }[];
}
export const jobSchema = createSchema.extend({
  id: z.string(),
  status: z.enum(statuses),
  admissionReason: z.string().nullable(),
  readySince: z.string().nullable(),
  retry: retryStateSchema,
  pauseState: z.strictObject({ project: z.boolean(), repository: z.boolean() }),
  codexThreadId: z.string().nullable(),
  branch: z.string().nullable(),
  worktree: z.string().nullable(),
  baseCommit: z.string().nullable(),
  iteration: z.number(),
  maxIterations: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  result: resultSchema.nullable(),
  blocker: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  feedback: z.string().nullable(),
  childPid: z.number().nullable(),
  dependencyState: dependencyStateSchema,
  schedulingState: schedulingStateSchema,
  dependencyStatuses: z.array(
    z.strictObject({
      id: z.string(),
      status: z.enum(statuses),
      state: dependencyStateSchema,
    }),
  ),
});
const transitions: Record<Status, Status[]> = {
  CREATED: ["QUEUED", "CANCELLED"],
  QUEUED: ["PREPARING", "CANCELLED", "FAILED"],
  PREPARING: ["CODEX_RUNNING", "FAILED", "CANCELLED"],
  CODEX_RUNNING: ["REVIEWING", "WAITING_FOR_HUMAN", "FAILED", "CANCELLED"],
  REVIEWING: [
    "ACCEPTED",
    "CHANGES_REQUESTED",
    "WAITING_FOR_HUMAN",
    "FAILED",
    "CANCELLED",
  ],
  CHANGES_REQUESTED: ["QUEUED", "FAILED", "CANCELLED"],
  WAITING_FOR_HUMAN: ["QUEUED", "CANCELLED"],
  ACCEPTED: ["READY_FOR_HUMAN_TEST", "FAILED"],
  READY_FOR_HUMAN_TEST: ["COMPLETED", "QUEUED", "CANCELLED"],
  COMPLETED: [],
  FAILED: ["QUEUED", "CANCELLED"],
  CANCELLED: ["QUEUED"],
};
export function assertTransition(from: Status, to: Status) {
  if (!transitions[from].includes(to))
    throw new Error(`Invalid transition ${from} → ${to}`);
}
export const activeStatuses: Status[] = [
  "PREPARING",
  "CODEX_RUNNING",
  "REVIEWING",
];
export function errorMessage(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}
