import type { SmithersCtx } from "smithers-orchestrator";
import type { ScheduledOutputs } from "../components/QualityPipeline";
import { MERGE_QUEUE_NODE_ID, stageNodeId } from "./contracts";
import type {
  FinalReviewRow,
  ImplementRow,
  MergeQueueRow,
  OutputSnapshot,
  ReviewFixRow,
  TestRow,
} from "./state";

type SnapshotCapableCtx = SmithersCtx<ScheduledOutputs> & {
  outputs: (table: string) => unknown;
  outputMaybe: (table: string, where: { nodeId: string; iteration: number }) => unknown;
};

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

function rowsForNode<T extends { nodeId?: string; iteration?: number }>(
  rows: unknown,
  nodeId: string,
): T[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row): row is T => typeof row === "object" && row !== null)
    .filter((row) => row.nodeId === nodeId)
    .sort((a, b) => (a.iteration ?? 0) - (b.iteration ?? 0));
}

export function buildSnapshot(ctx: SmithersCtx<ScheduledOutputs>): OutputSnapshot {
  const runtimeCtx = ctx as SnapshotCapableCtx;
  const rawRows = runtimeCtx.outputs("merge_queue");
  const mergeQueueRows = Array.isArray(rawRows) ? rawRows.map(normalizeMergeQueueRow) : [];
  const testRows = runtimeCtx.outputs("test");
  const finalReviewRows = runtimeCtx.outputs("final_review");
  const implementRows = runtimeCtx.outputs("implement");
  const reviewFixRows = runtimeCtx.outputs("review_fix");

  return {
    mergeQueueRows,
    latestTest: (unitId) =>
      (ctx.latest("test", stageNodeId(unitId, "test")) as TestRow | null) ?? null,
    latestFinalReview: (unitId) =>
      (ctx.latest("final_review", stageNodeId(unitId, "final-review")) as FinalReviewRow | null) ?? null,
    latestImplement: (unitId) =>
      (ctx.latest("implement", stageNodeId(unitId, "implement")) as ImplementRow | null) ?? null,
    freshTest: (unitId, iteration) =>
      (runtimeCtx.outputMaybe("test", {
        nodeId: stageNodeId(unitId, "test"),
        iteration,
      }) as TestRow | null) ?? null,
    testHistory: (unitId) => rowsForNode<TestRow>(testRows, stageNodeId(unitId, "test")),
    finalReviewHistory: (unitId) => rowsForNode<FinalReviewRow>(finalReviewRows, stageNodeId(unitId, "final-review")),
    implementHistory: (unitId) => rowsForNode<ImplementRow>(implementRows, stageNodeId(unitId, "implement")),
    reviewFixHistory: (unitId) => rowsForNode<ReviewFixRow>(reviewFixRows, stageNodeId(unitId, "review-fix")),
    isUnitLanded: (unitId) =>
      mergeQueueRows.some((row) => row.nodeId === MERGE_QUEUE_NODE_ID
        && row.ticketsLanded.some((ticket) => ticket.ticketId === unitId)),
  };
}
