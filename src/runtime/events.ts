import { readFile } from "node:fs/promises";

import { z } from "zod";

// ── Shared enum schemas ─────────────────────────────────────────

const stageNameSchema = z.enum([
  "research",
  "plan",
  "implement",
  "test",
  "prd-review",
  "code-review",
  "review-fix",
  "final-review",
  "learnings",
]);

const decisionStatusSchema = z.enum(["pending", "rejected", "approved", "invalidated"]);

/** Accepts an array of unknown values and filters to only strings (preserving lenient behavior). */
const stringArrayFilterSchema = z
  .array(z.unknown())
  .transform((arr) => arr.filter((s): s is string => typeof s === "string"));

// ── Per-variant Zod schemas ─────────────────────────────────────

const nodeStartedSchema = z.object({
  type: z.literal("node-started"),
  timestamp: z.number().finite(),
  runId: z.string(),
  nodeId: z.string(),
  unitId: z.string(),
  stageName: stageNameSchema,
});

const nodeCompletedSchema = z.object({
  type: z.literal("node-completed"),
  timestamp: z.number().finite(),
  runId: z.string(),
  nodeId: z.string(),
  unitId: z.string(),
  stageName: stageNameSchema,
});

const nodeFailedSchema = z.object({
  type: z.literal("node-failed"),
  timestamp: z.number().finite(),
  runId: z.string(),
  nodeId: z.string(),
  unitId: z.string(),
  stageName: stageNameSchema,
  error: z.string().optional(),
});

const jobScheduledSchema = z.object({
  type: z.literal("job-scheduled"),
  timestamp: z.number().finite(),
  jobType: z.string(),
  agentId: z.string(),
  ticketId: z.string().nullable(),
  createdAtMs: z.number().finite(),
});

const jobCompletedSchema = z.object({
  type: z.literal("job-completed"),
  timestamp: z.number().finite(),
  jobType: z.string(),
  agentId: z.string(),
  ticketId: z.string().nullable(),
});

const mergeQueueLandedSchema = z.object({
  type: z.literal("merge-queue-landed"),
  timestamp: z.number().finite(),
  runId: z.string(),
  ticketId: z.string(),
  mergeCommit: z.string().nullable(),
  summary: z.string(),
});

const mergeQueueEvictedSchema = z.object({
  type: z.literal("merge-queue-evicted"),
  timestamp: z.number().finite(),
  runId: z.string(),
  ticketId: z.string(),
  reason: z.string(),
  details: z.string(),
});

const mergeQueueSkippedSchema = z.object({
  type: z.literal("merge-queue-skipped"),
  timestamp: z.number().finite(),
  runId: z.string(),
  ticketId: z.string(),
  reason: z.string(),
});

const passTrackerUpdateSchema = z.object({
  type: z.literal("pass-tracker-update"),
  timestamp: z.number().finite(),
  runId: z.string(),
  summary: z.string(),
  maxConcurrency: z.number().finite(),
});

const workPlanLoadedSchema = z.object({
  type: z.literal("work-plan-loaded"),
  timestamp: z.number().finite(),
  units: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      tier: z.enum(["small", "large"]),
      priority: z.string(),
    }),
  ),
});

const finalReviewDecisionSchema = z.object({
  type: z.literal("final-review-decision"),
  timestamp: z.number().finite(),
  runId: z.string(),
  unitId: z.string(),
  iteration: z.number().finite(),
  status: decisionStatusSchema,
  reasoning: z.string(),
  approvalSupersededRejection: z.boolean(),
  approvalOnlyCorrectedFormatting: z.boolean(),
});

const semanticCompletionUpdateSchema = z.object({
  type: z.literal("semantic-completion-update"),
  timestamp: z.number().finite(),
  runId: z.string(),
  totalUnits: z.number().finite(),
  unitsLanded: stringArrayFilterSchema,
  unitsSemanticallyComplete: stringArrayFilterSchema,
});

// ── Discriminated union ─────────────────────────────────────────

const smithersEventSchema = z.discriminatedUnion("type", [
  nodeStartedSchema,
  nodeCompletedSchema,
  nodeFailedSchema,
  jobScheduledSchema,
  jobCompletedSchema,
  mergeQueueLandedSchema,
  mergeQueueEvictedSchema,
  mergeQueueSkippedSchema,
  passTrackerUpdateSchema,
  workPlanLoadedSchema,
  finalReviewDecisionSchema,
  semanticCompletionUpdateSchema,
]);

// ── Exported types (derived from Zod schemas — single source of truth) ──────

export type SmithersEvent = z.infer<typeof smithersEventSchema>;

export type NodeStartedEvent = z.infer<typeof nodeStartedSchema>;
export type NodeCompletedEvent = z.infer<typeof nodeCompletedSchema>;
export type NodeFailedEvent = z.infer<typeof nodeFailedSchema>;
export type JobScheduledEvent = z.infer<typeof jobScheduledSchema>;
export type JobCompletedEvent = z.infer<typeof jobCompletedSchema>;
export type MergeQueueLandedEvent = z.infer<typeof mergeQueueLandedSchema>;
export type MergeQueueEvictedEvent = z.infer<typeof mergeQueueEvictedSchema>;
export type MergeQueueSkippedEvent = z.infer<typeof mergeQueueSkippedSchema>;
export type PassTrackerUpdateEvent = z.infer<typeof passTrackerUpdateSchema>;
export type WorkPlanLoadedEvent = z.infer<typeof workPlanLoadedSchema>;
export type FinalReviewDecisionEvent = z.infer<typeof finalReviewDecisionSchema>;
export type SemanticCompletionUpdateEvent = z.infer<typeof semanticCompletionUpdateSchema>;

// ── Parser ──────────────────────────────────────────────────────

/** Parse an unknown value into a SmithersEvent, returning null on failure. */
export function parseEvent(value: unknown): SmithersEvent | null {
  const result = smithersEventSchema.safeParse(value);
  return result.success ? result.data : null;
}

// ── Event log reader ────────────────────────────────────────────

export async function readEventLog(path: string): Promise<SmithersEvent[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const events: SmithersEvent[] = [];
  const lines = raw.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const event = parseEvent(parsed);
    if (event) events.push(event);
  }
  return events;
}
