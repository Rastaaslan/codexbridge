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
export const createSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  ticket: z.string().trim().min(1).max(100000),
  repository: z.string().min(1),
  startRef: refSchema.optional(),
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
}
export const jobSchema = createSchema.extend({
  id: z.string(),
  status: z.enum(statuses),
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
