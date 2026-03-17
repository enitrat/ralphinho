import type { SmithersCtx } from "smithers-orchestrator";
import type { ScheduledOutputs } from "../components/QualityPipeline";
import {
  buildOutputSnapshot,
  type MergeQueueRow,
  type OutputSnapshot,
  type FinalReviewRow,
  type ImplementRow,
  type ReviewFixRow,
  type TestRow,
} from "./state";

function normalizeMergeQueueRow(row: unknown): MergeQueueRow {
  const record = (row && typeof row === "object") ? row as Record<string, unknown> : {};
  return {
    nodeId: String(record.nodeId ?? ""),
    ticketsLanded: Array.isArray(record.ticketsLanded)
      ? (record.ticketsLanded as Array<{
        ticketId: string;
        mergeCommit: string | null;
        summary: string;
        decisionIteration: number | null;
        testIteration: number | null;
        approvalSupersededRejection: boolean;
      }>)
      : [],
    ticketsEvicted: Array.isArray(record.ticketsEvicted)
      ? (record.ticketsEvicted as Array<{ ticketId: string; reason: string; details: string }>)
      : [],
  };
}

/**
 * Single boundary cast: Smithers ctx.outputs() is typed via complex generics
 * that TS can't resolve for ScheduledOutputs. We cast once here to access
 * the runtime rows, then feed them into the shared typed builder.
 */
function runtimeOutputs(ctx: SmithersCtx<ScheduledOutputs>, table: string): unknown[] {
  return (ctx as unknown as { outputs: (t: string) => unknown[] }).outputs(table);
}

export function buildSnapshot(ctx: SmithersCtx<ScheduledOutputs>): OutputSnapshot {
  const rawMergeQueue = runtimeOutputs(ctx, "merge_queue");
  const mergeQueueRows = Array.isArray(rawMergeQueue)
    ? rawMergeQueue.map(normalizeMergeQueueRow)
    : [];

  // Boundary casts: Smithers adds nodeId/iteration at runtime
  // but they're not in the Zod schemas. Row types include optional nodeId/iteration.
  const testRows = runtimeOutputs(ctx, "test") as TestRow[];
  const finalReviewRows = runtimeOutputs(ctx, "final_review") as FinalReviewRow[];
  const implementRows = runtimeOutputs(ctx, "implement") as ImplementRow[];
  const reviewFixRows = runtimeOutputs(ctx, "review_fix") as ReviewFixRow[];

  return buildOutputSnapshot({
    mergeQueueRows,
    testRows,
    finalReviewRows,
    implementRows,
    reviewFixRows,
  });
}
