import { readFile } from "node:fs/promises";

import { z } from "zod";

import type { StageName } from "../workflows/ralphinho/workflow/contracts";
import type { DecisionStatus } from "../workflows/ralphinho/workflow/decisions";

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

// ── Exported types (kept for consumers + documentation) ─────────

export type SmithersEvent =
  | NodeStartedEvent
  | NodeCompletedEvent
  | NodeFailedEvent
  | JobScheduledEvent
  | JobCompletedEvent
  | MergeQueueLandedEvent
  | MergeQueueEvictedEvent
  | MergeQueueSkippedEvent
  | PassTrackerUpdateEvent
  | WorkPlanLoadedEvent
  | FinalReviewDecisionEvent
  | SemanticCompletionUpdateEvent;

export interface NodeStartedEvent {
  type: "node-started";
  timestamp: number;
  runId: string;
  nodeId: string;
  unitId: string;
  stageName: StageName;
}

export interface NodeCompletedEvent {
  type: "node-completed";
  timestamp: number;
  runId: string;
  nodeId: string;
  unitId: string;
  stageName: StageName;
}

export interface NodeFailedEvent {
  type: "node-failed";
  timestamp: number;
  runId: string;
  nodeId: string;
  unitId: string;
  stageName: StageName;
  error?: string;
}

export interface JobScheduledEvent {
  type: "job-scheduled";
  timestamp: number;
  jobType: string;
  agentId: string;
  ticketId: string | null;
  createdAtMs: number;
}

export interface JobCompletedEvent {
  type: "job-completed";
  timestamp: number;
  jobType: string;
  agentId: string;
  ticketId: string | null;
}

export interface MergeQueueLandedEvent {
  type: "merge-queue-landed";
  timestamp: number;
  runId: string;
  ticketId: string;
  mergeCommit: string | null;
  summary: string;
}

export interface MergeQueueEvictedEvent {
  type: "merge-queue-evicted";
  timestamp: number;
  runId: string;
  ticketId: string;
  reason: string;
  details: string;
}

export interface MergeQueueSkippedEvent {
  type: "merge-queue-skipped";
  timestamp: number;
  runId: string;
  ticketId: string;
  reason: string;
}

export interface PassTrackerUpdateEvent {
  type: "pass-tracker-update";
  timestamp: number;
  runId: string;
  summary: string;
  maxConcurrency: number;
}

export interface WorkPlanLoadedEvent {
  type: "work-plan-loaded";
  timestamp: number;
  units: Array<{
    id: string;
    name: string;
    tier: "small" | "large";
    priority: string;
  }>;
}

export interface FinalReviewDecisionEvent {
  type: "final-review-decision";
  timestamp: number;
  runId: string;
  unitId: string;
  iteration: number;
  status: DecisionStatus;
  reasoning: string;
  approvalSupersededRejection: boolean;
  approvalOnlyCorrectedFormatting: boolean;
}

export interface SemanticCompletionUpdateEvent {
  type: "semantic-completion-update";
  timestamp: number;
  runId: string;
  totalUnits: number;
  unitsLanded: string[];
  unitsSemanticallyComplete: string[];
}

// ── Parser ──────────────────────────────────────────────────────

/**
 * Parse an unknown value into a SmithersEvent, returning null on failure.
 *
 * Note: We cast `result.data` because Zod 4's `discriminatedUnion` type
 * inference for `.nullable()` / `.transform()` fields doesn't exactly match
 * our hand-written interfaces. Behavioral correctness is verified by tests.
 */
export function parseEvent(value: unknown): SmithersEvent | null {
  const result = smithersEventSchema.safeParse(value);
  return result.success ? (result.data as SmithersEvent) : null;
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
