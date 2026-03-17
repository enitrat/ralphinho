import { z } from "zod";

import type { WorkUnit } from "../types";
import type { DepSummary } from "../components/QualityPipeline";
import type { AgenticMergeQueueTicket } from "../components/AgenticMergeQueue";
import { buildUnitWorktreePath } from "../components/runtimeNames";
import { MERGE_QUEUE_NODE_ID, TIER_STAGES, stageNodeId } from "./contracts";

export type MergeQueueRow = {
  nodeId: string;
  ticketsLanded: Array<{
    ticketId: string;
    mergeCommit: string | null;
    summary: string;
    reviewLoopIteration: number | null;
    testIteration: number | null;
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

export type ReviewLoopResult = {
  nodeId: string;
  iteration: number;
  passed: boolean;
  summary: string;
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

const reviewLoopResultRawSchema = z.object({
  node_id: z.string(),
  iteration: z.number(),
  passed: z.number(),
  summary: z.string(),
});

export function reviewLoopResultRowFromSqlite(row: Record<string, unknown>): ReviewLoopResult | null {
  const r = reviewLoopResultRawSchema.safeParse(row);
  if (!r.success) return null;
  return {
    nodeId: r.data.node_id,
    iteration: r.data.iteration,
    passed: Boolean(r.data.passed),
    summary: r.data.summary,
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
  latestReviewLoopResult: (unitId: string) => ReviewLoopResult | null;
  latestImplement: (unitId: string) => ImplementRow | null;
  freshTest: (unitId: string, iteration: number) => TestRow | null;
  testHistory: (unitId: string) => TestRow[];
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
  reviewLoopResultRows: ReviewLoopResult[];
  implementRows: ImplementRow[];
  reviewFixRows: ReviewFixRow[];
};

export function buildOutputSnapshot(input: SnapshotInput): OutputSnapshot {
  const testByUnit = groupByUnit(input.testRows);
  const reviewLoopResultByUnit = groupByUnit(input.reviewLoopResultRows);
  const implementByUnit = groupByUnit(input.implementRows);
  const reviewFixByUnit = groupByUnit(input.reviewFixRows);

  return {
    mergeQueueRows: input.mergeQueueRows,
    latestTest: (id) => latestRow(testByUnit.get(id) ?? []),
    latestReviewLoopResult: (id) => latestRow(reviewLoopResultByUnit.get(id) ?? []),
    latestImplement: (id) => latestRow(implementByUnit.get(id) ?? []),
    freshTest: (id, iteration) =>
      (testByUnit.get(id) ?? []).find((row) => row.iteration === iteration) ?? null,
    testHistory: (id) => testByUnit.get(id) ?? [],
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

export type FailedUnitReport = {
  unitId: string;
  lastStage: string;
  reason: string;
};

export function buildFailedUnitReport(
  snapshot: OutputSnapshot,
  units: WorkUnit[],
  maxPasses: number,
  stageExists: (key: string, nodeId: string) => boolean,
): FailedUnitReport[] {
  return units
    .filter((u) => !snapshot.isUnitLanded(u.id))
    .map((u) => {
      const state = getUnitState(snapshot, units, u.id);
      const tierStages = TIER_STAGES[u.tier] ?? TIER_STAGES.large;
      const allStages = [
        { key: "review_fix", stage: "review-fix", nodeId: stageNodeId(u.id, "review-fix") },
        { key: "code_review", stage: "code-review", nodeId: stageNodeId(u.id, "code-review") },
        { key: "prd_review", stage: "prd-review", nodeId: stageNodeId(u.id, "prd-review") },
        { key: "test", stage: "test", nodeId: stageNodeId(u.id, "test") },
        { key: "implement", stage: "implement", nodeId: stageNodeId(u.id, "implement") },
        { key: "plan", stage: "plan", nodeId: stageNodeId(u.id, "plan") },
        { key: "research", stage: "research", nodeId: stageNodeId(u.id, "research") },
      ] as const;
      const stages = allStages
        .filter((s) => tierStages.includes(s.stage as typeof tierStages[number]))
        .map((s) => ({ key: s.key, stage: s.stage, nodeId: s.nodeId }));
      let lastStage = state === "not-ready" ? "blocked-by-deps" : "not-started";
      for (const stage of stages) {
        if (stageExists(stage.key, stage.nodeId)) {
          lastStage = stage.stage;
          break;
        }
      }
      let reason = state === "not-ready"
        ? `Blocked: dependencies not landed (${(units.find((x) => x.id === u.id)?.deps ?? []).filter((d) => !snapshot.isUnitLanded(d)).join(", ")})`
        : `Did not complete within ${maxPasses} passes`;
      const evCtx = getEvictionContext(snapshot, u.id);
      if (evCtx) reason = `Evicted from merge queue: ${evCtx.slice(0, 200)}`;
      const testRow = snapshot.latestTest(u.id);
      if (testRow && !testRow.testsPassed) {
        reason = `Tests failing: ${testRow.failingSummary ?? "unknown"}`;
      }
      const loopResult = snapshot.latestReviewLoopResult(u.id);
      if (loopResult?.passed === false) {
        reason = `Review loop did not pass: ${loopResult.summary ?? "missing summary"}`;
      }
      return { unitId: u.id, lastStage, reason };
    });
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

      const loopResult = snapshot.latestReviewLoopResult(unit.id);
      if (!loopResult?.passed) return false;

      if (isUnitEvicted(snapshot, unit.id)) {
        const freshTest = snapshot.freshTest(unit.id, iteration);
        if (!freshTest?.testsPassed) return false;
        // Fresh build failed — fall back to latest review-loop pass status.
        if (!freshTest.buildPassed) return snapshot.latestReviewLoopResult(unit.id)?.passed === true;
      }

      return true;
    })
    .map((unit) => {
      const latestImplement = snapshot.latestImplement(unit.id);
      const latestTest = snapshot.latestTest(unit.id);
      const loopResult = snapshot.latestReviewLoopResult(unit.id);
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
          reviewLoopIteration: loopResult?.iteration ?? null,
          testIteration: latestTest?.iteration ?? null,
        },
      };
    });
}
