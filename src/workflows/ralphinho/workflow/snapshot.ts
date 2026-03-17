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

// ---------------------------------------------------------------------------
// Row validators — each checks only required fields; optional fields are left
// to the consuming code. Throws with a message that names both the table and
// the offending field so callers can diagnose schema drift quickly.
// ---------------------------------------------------------------------------

function requireObject(row: unknown, table: string): Record<string, unknown> {
  if (!row || typeof row !== "object") {
    throw new Error(
      `[snapshot] Invalid row in table "${table}": expected object, got ${typeof row}`,
    );
  }
  return row as Record<string, unknown>;
}

function requireBoolean(row: Record<string, unknown>, field: string, table: string): void {
  if (typeof row[field] !== "boolean") {
    throw new Error(
      `[snapshot] Invalid row in table "${table}": field "${field}" must be a boolean, got ${typeof row[field]}`,
    );
  }
}

function requireString(row: Record<string, unknown>, field: string, table: string): void {
  if (typeof row[field] !== "string") {
    throw new Error(
      `[snapshot] Invalid row in table "${table}": field "${field}" must be a string, got ${typeof row[field]}`,
    );
  }
}

function validateTestRow(row: unknown): TestRow {
  const r = requireObject(row, "test");
  requireBoolean(r, "testsPassed", "test");
  requireBoolean(r, "buildPassed", "test");
  return r as TestRow;
}

function validateFinalReviewRow(row: unknown): FinalReviewRow {
  const r = requireObject(row, "final_review");
  requireBoolean(r, "readyToMoveOn", "final_review");
  requireBoolean(r, "approved", "final_review");
  requireString(r, "reasoning", "final_review");
  return r as FinalReviewRow;
}

function validateImplementRow(row: unknown): ImplementRow {
  const r = requireObject(row, "implement");
  requireString(r, "whatWasDone", "implement");
  requireBoolean(r, "believesComplete", "implement");
  if (r.filesCreated !== null && !Array.isArray(r.filesCreated)) {
    throw new Error(
      `[snapshot] Invalid row in table "implement": field "filesCreated" must be string[] | null`,
    );
  }
  if (r.filesModified !== null && !Array.isArray(r.filesModified)) {
    throw new Error(
      `[snapshot] Invalid row in table "implement": field "filesModified" must be string[] | null`,
    );
  }
  return r as ImplementRow;
}

function validateReviewFixRow(row: unknown): ReviewFixRow {
  const r = requireObject(row, "review_fix");
  requireString(r, "summary", "review_fix");
  requireBoolean(r, "allIssuesResolved", "review_fix");
  requireBoolean(r, "buildPassed", "review_fix");
  requireBoolean(r, "testsPassed", "review_fix");
  return r as ReviewFixRow;
}

export function buildSnapshot(ctx: SmithersCtx<ScheduledOutputs>): OutputSnapshot {
  const rawMergeQueue = runtimeOutputs(ctx, "merge_queue");
  const mergeQueueRows = Array.isArray(rawMergeQueue)
    ? rawMergeQueue.map(normalizeMergeQueueRow)
    : [];

  // Boundary casts: Smithers adds nodeId/iteration at runtime
  // but they're not in the Zod schemas. Row types include optional nodeId/iteration.
  // Each cast is guarded by a runtime shape check that throws on schema drift.
  const testRows = runtimeOutputs(ctx, "test").map(validateTestRow);
  const finalReviewRows = runtimeOutputs(ctx, "final_review").map(validateFinalReviewRow);
  const implementRows = runtimeOutputs(ctx, "implement").map(validateImplementRow);
  const reviewFixRows = runtimeOutputs(ctx, "review_fix").map(validateReviewFixRow);

  return buildOutputSnapshot({
    mergeQueueRows,
    testRows,
    finalReviewRows,
    implementRows,
    reviewFixRows,
  });
}
