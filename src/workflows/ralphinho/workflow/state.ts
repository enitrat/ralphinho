import { z } from "zod";

import type { WorkUnit } from "../types";
import type { DepSummary } from "../components/QualityPipeline";
import type { AgenticMergeQueueTicket } from "../components/AgenticMergeQueue";
import { buildUnitWorktreePath } from "../components/runtimeNames";
import { MERGE_QUEUE_NODE_ID } from "./contracts";
import { getDecisionAudit, isMergeEligible } from "./decisions";

export type MergeQueueRow = {
  nodeId: string;
  ticketsLanded: Array<{
    ticketId: string;
    mergeCommit: string | null;
    summary: string;
    decisionIteration: number | null;
    testIteration: number | null;
    approvalSupersededRejection: boolean;
  }>;
  ticketsEvicted: Array<{ ticketId: string; reason: string; details: string }>;
};

export type TestRow = {
  nodeId: string;
  iteration: number;
  testsPassed: boolean;
  buildPassed: boolean;
  failingSummary?: string | null;
};

export type FinalReviewRow = {
  nodeId: string;
  iteration: number;
  readyToMoveOn: boolean;
  approved: boolean;
  reasoning: string;
  qualityScore?: number | null;
};

export type ImplementRow = {
  nodeId: string;
  iteration: number;
  whatWasDone: string;
  filesCreated: string[] | null;
  filesModified: string[] | null;
  believesComplete: boolean;
  summary?: string;
};

export type ReviewFixRow = {
  nodeId: string;
  iteration: number;
  summary: string;
  allIssuesResolved: boolean;
  buildPassed: boolean;
  testsPassed: boolean;
};

// ── SQLite row parsing utilities ──────────────────────────────────────────

export function parseStringArray(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
  } catch {
    return [];
  }
}

// Internal raw row schemas (SQLite: snake_case, INTEGER for booleans)

const finalReviewRawSchema = z.object({
  node_id: z.string(),
  iteration: z.number(),
  ready_to_move_on: z.number(),
  approved: z.number(),
  reasoning: z.string(),
  quality_score: z.number().nullable(),
});

export function finalReviewRowFromSqlite(row: Record<string, unknown>): FinalReviewRow | null {
  const r = finalReviewRawSchema.safeParse(row);
  if (!r.success) return null;
  return {
    nodeId: r.data.node_id,
    iteration: r.data.iteration,
    readyToMoveOn: Boolean(r.data.ready_to_move_on),
    approved: Boolean(r.data.approved),
    reasoning: r.data.reasoning ?? "",
    qualityScore: r.data.quality_score,
  };
}

const implementRawSchema = z.object({
  node_id: z.string(),
  iteration: z.number(),
  what_was_done: z.string(),
  files_created: z.string().nullable(),
  files_modified: z.string().nullable(),
  believes_complete: z.number(),
  summary: z.string().nullable(),
});

export function implementRowFromSqlite(row: Record<string, unknown>): ImplementRow | null {
  const r = implementRawSchema.safeParse(row);
  if (!r.success) return null;
  return {
    nodeId: r.data.node_id,
    iteration: r.data.iteration,
    whatWasDone: r.data.what_was_done ?? "",
    filesCreated: parseStringArray(r.data.files_created),
    filesModified: parseStringArray(r.data.files_modified),
    believesComplete: Boolean(r.data.believes_complete),
    summary: r.data.summary ?? undefined,
  };
}

const testRawSchema = z.object({
  node_id: z.string(),
  iteration: z.number(),
  tests_passed: z.number(),
  build_passed: z.number(),
  failing_summary: z.string().nullable(),
});

export function testRowFromSqlite(row: Record<string, unknown>): TestRow | null {
  const r = testRawSchema.safeParse(row);
  if (!r.success) return null;
  return {
    nodeId: r.data.node_id,
    iteration: r.data.iteration,
    testsPassed: Boolean(r.data.tests_passed),
    buildPassed: Boolean(r.data.build_passed),
    failingSummary: r.data.failing_summary,
  };
}

const reviewFixRawSchema = z.object({
  node_id: z.string(),
  iteration: z.number(),
  summary: z.string(),
  all_issues_resolved: z.number(),
  build_passed: z.number(),
  tests_passed: z.number(),
});

export function reviewFixRowFromSqlite(row: Record<string, unknown>): ReviewFixRow | null {
  const r = reviewFixRawSchema.safeParse(row);
  if (!r.success) return null;
  return {
    nodeId: r.data.node_id,
    iteration: r.data.iteration,
    summary: r.data.summary ?? "",
    allIssuesResolved: Boolean(r.data.all_issues_resolved),
    buildPassed: Boolean(r.data.build_passed),
    testsPassed: Boolean(r.data.tests_passed),
  };
}

export type OutputSnapshot = {
  mergeQueueRows: MergeQueueRow[];
  latestTest: (unitId: string) => TestRow | null;
  latestFinalReview: (unitId: string) => FinalReviewRow | null;
  latestImplement: (unitId: string) => ImplementRow | null;
  freshTest: (unitId: string, iteration: number) => TestRow | null;
  testHistory: (unitId: string) => TestRow[];
  finalReviewHistory: (unitId: string) => FinalReviewRow[];
  implementHistory: (unitId: string) => ImplementRow[];
  reviewFixHistory: (unitId: string) => ReviewFixRow[];
  isUnitLanded: (unitId: string) => boolean;
};

export type UnitState = "done" | "not-ready" | "active";

function mergeQueueRows(snapshot: OutputSnapshot): MergeQueueRow[] {
  return snapshot.mergeQueueRows.filter((row) => row.nodeId === MERGE_QUEUE_NODE_ID);
}

function isTicketLandedInMergeQueueRows(rows: MergeQueueRow[], unitId: string): boolean {
  return rows.some(
    (row) => row.nodeId === MERGE_QUEUE_NODE_ID
      && row.ticketsLanded.some((ticket) => ticket.ticketId === unitId),
  );
}

export function isUnitEvicted(snapshot: OutputSnapshot, unitId: string): boolean {
  if (snapshot.isUnitLanded(unitId)) return false;
  return mergeQueueRows(snapshot)
    .some((mq) => mq.ticketsEvicted.some((ticket) => ticket.ticketId === unitId));
}

export function getEvictionContext(snapshot: OutputSnapshot, unitId: string): string | null {
  if (snapshot.isUnitLanded(unitId)) return null;
  const relevantRows = mergeQueueRows(snapshot).slice().reverse();
  for (const row of relevantRows) {
    const evictedEntry = row.ticketsEvicted.find((ticket) => ticket.ticketId === unitId);
    if (evictedEntry) return evictedEntry.details ?? null;
  }
  return null;
}

export function getUnitState(snapshot: OutputSnapshot, units: WorkUnit[], unitId: string): UnitState {
  if (snapshot.isUnitLanded(unitId)) return "done";

  const unit = units.find((u) => u.id === unitId);
  const deps = unit?.deps ?? [];
  if (deps.length > 0 && !deps.every((depId) => snapshot.isUnitLanded(depId))) {
    return "not-ready";
  }

  return "active";
}

export function buildDepSummaries(snapshot: OutputSnapshot, unit: WorkUnit): DepSummary[] {
  return (unit.deps ?? [])
    .map((depId) => {
      const depImplement = snapshot.latestImplement(depId);
      if (!depImplement) return null;
      return {
        id: depId,
        whatWasDone: depImplement.whatWasDone ?? "",
        filesCreated: depImplement.filesCreated ?? [],
        filesModified: depImplement.filesModified ?? [],
      };
    })
    .filter((dep): dep is DepSummary => dep !== null);
}

// --- Shared OutputSnapshot builder ---

export type SnapshotInput = {
  mergeQueueRows: MergeQueueRow[];
  testRows: TestRow[];
  finalReviewRows: FinalReviewRow[];
  implementRows: ImplementRow[];
  reviewFixRows: ReviewFixRow[];
};

export function buildOutputSnapshot(input: SnapshotInput): OutputSnapshot {
  const testByUnit = groupByUnit(input.testRows);
  const finalReviewByUnit = groupByUnit(input.finalReviewRows);
  const implementByUnit = groupByUnit(input.implementRows);
  const reviewFixByUnit = groupByUnit(input.reviewFixRows);

  return {
    mergeQueueRows: input.mergeQueueRows,
    latestTest: (id) => latestRow(testByUnit.get(id) ?? []),
    latestFinalReview: (id) => latestRow(finalReviewByUnit.get(id) ?? []),
    latestImplement: (id) => latestRow(implementByUnit.get(id) ?? []),
    freshTest: (id, iteration) =>
      (testByUnit.get(id) ?? []).find((row) => row.iteration === iteration) ?? null,
    testHistory: (id) => testByUnit.get(id) ?? [],
    finalReviewHistory: (id) => finalReviewByUnit.get(id) ?? [],
    implementHistory: (id) => implementByUnit.get(id) ?? [],
    reviewFixHistory: (id) => reviewFixByUnit.get(id) ?? [],
    isUnitLanded: (id) => isTicketLandedInMergeQueueRows(input.mergeQueueRows, id),
  };
}

/** Extract unitId from a nodeId of the form `{unitId}:{stageName}` */
export function extractUnitId(nodeId: string): string | null {
  const lastColon = nodeId.lastIndexOf(":");
  if (lastColon <= 0) return null;
  return nodeId.slice(0, lastColon);
}

function groupByUnit<T extends { nodeId: string }>(rows: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const unitId = extractUnitId(row.nodeId);
    if (!unitId) continue;
    const current = map.get(unitId) ?? [];
    current.push(row);
    map.set(unitId, current);
  }
  return map;
}

function latestRow<T>(rows: T[]): T | null {
  return rows.at(-1) ?? null;
}

export function buildMergeTickets(
  snapshot: OutputSnapshot,
  units: WorkUnit[],
  runId: string,
  iteration: number,
): AgenticMergeQueueTicket[] {
  return units
    .filter((unit) => {
      if (snapshot.isUnitLanded(unit.id)) return false;
      if (getUnitState(snapshot, units, unit.id) !== "active") return false;
      if (!isMergeEligible(snapshot, unit.id)) return false;

      if (isUnitEvicted(snapshot, unit.id)) {
        const freshTest = snapshot.freshTest(unit.id, iteration);
        if (!freshTest?.testsPassed) return false;
        // Fresh build failed — fall back to latest test's build status via merge eligibility
        if (!freshTest.buildPassed) return isMergeEligible(snapshot, unit.id);
      }

      return true;
    })
    .map((unit) => {
      const latestImplement = snapshot.latestImplement(unit.id);
      const latestTest = snapshot.latestTest(unit.id);
      const audit = getDecisionAudit(snapshot, unit.id);
      return {
        ticketId: unit.id,
        ticketTitle: unit.name,
        ticketCategory: unit.tier,
        priority: "medium",
        reportComplete: true,
        landed: false,
        filesModified: latestImplement?.filesModified ?? [],
        filesCreated: latestImplement?.filesCreated ?? [],
        worktreePath: buildUnitWorktreePath(runId, unit.id),
        eligibilityProof: {
          decisionIteration: audit.finalDecision?.iteration ?? null,
          testIteration: latestTest?.iteration ?? null,
          approvalSupersededRejection: audit.finalDecision?.approvalSupersededRejection ?? false,
        },
      };
    });
}
