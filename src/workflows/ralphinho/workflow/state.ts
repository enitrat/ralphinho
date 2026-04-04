import type { SmithersCtx } from "smithers-orchestrator";
import type { z } from "zod";
import type { WorkUnit } from "../types";
import type { DepSummary, ScheduledOutputs } from "../components/QualityPipeline";
import type { AgenticMergeQueueTicket } from "../components/AgenticMergeQueue";
import { scheduledOutputSchemas } from "../schemas";
import { buildUnitWorktreePath } from "../components/runtimeNames";
import { TIER_STAGES, stageNodeId, reviewLoopNodeId } from "./contracts";

// ── Derived types from schemas ──────────────────────────────────────

type MergeQueueRow = z.infer<typeof scheduledOutputSchemas.merge_queue>;

// ── ctx helpers ──────────────────────────────────────────────────────

function mergeQueueRows(ctx: SmithersCtx<ScheduledOutputs>): MergeQueueRow[] {
  return ctx.outputs("merge_queue");
}

export function isUnitLanded(ctx: SmithersCtx<ScheduledOutputs>, unitId: string): boolean {
  return mergeQueueRows(ctx).some(
    (row) => row.ticketsLanded.some((ticket) => ticket.ticketId === unitId),
  );
}

export function isUnitEvicted(ctx: SmithersCtx<ScheduledOutputs>, unitId: string): boolean {
  if (isUnitLanded(ctx, unitId)) return false;
  return mergeQueueRows(ctx)
    .some((mq) => mq.ticketsEvicted.some((ticket) => ticket.ticketId === unitId));
}

export function getEvictionContext(ctx: SmithersCtx<ScheduledOutputs>, unitId: string): string | null {
  if (isUnitLanded(ctx, unitId)) return null;
  const relevantRows = mergeQueueRows(ctx).slice().reverse();
  for (const row of relevantRows) {
    const evictedEntry = row.ticketsEvicted.find((ticket) => ticket.ticketId === unitId);
    if (evictedEntry) return evictedEntry.details ?? null;
  }
  return null;
}

export type UnitState = "done" | "not-ready" | "active";

export function getUnitState(ctx: SmithersCtx<ScheduledOutputs>, units: WorkUnit[], unitId: string): UnitState {
  if (isUnitLanded(ctx, unitId)) return "done";

  const unit = units.find((u) => u.id === unitId);
  const deps = unit?.deps ?? [];
  if (deps.length > 0 && !deps.every((depId) => isUnitLanded(ctx, depId))) {
    return "not-ready";
  }

  return "active";
}

// ── Unit-skip helpers ────────────────────────────────────────────────

export function shouldRunPipeline(ctx: SmithersCtx<ScheduledOutputs>, unit: WorkUnit, units: WorkUnit[]): boolean {
  const state = getUnitState(ctx, units, unit.id);
  if (state !== "active") return false;
  const reviewResult = ctx.latest(scheduledOutputSchemas.review_loop_result, reviewLoopNodeId(unit.id));
  if (reviewResult?.passed && !getEvictionContext(ctx, unit.id)) return false;
  return true;
}

// ── Dependency summaries ─────────────────────────────────────────────

export function buildDepSummaries(ctx: SmithersCtx<ScheduledOutputs>, unit: WorkUnit): DepSummary[] {
  return (unit.deps ?? [])
    .map((depId) => {
      const depImplement = ctx.latest(scheduledOutputSchemas.implement, stageNodeId(depId, "implement"));
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

// ── Failed unit report ───────────────────────────────────────────────

export type FailedUnitReport = {
  unitId: string;
  lastStage: string;
  reason: string;
};

export function buildFailedUnitReport(
  ctx: SmithersCtx<ScheduledOutputs>,
  units: WorkUnit[],
  maxPasses: number,
  stageExists: (key: keyof ScheduledOutputs & string, nodeId: string) => boolean,
): FailedUnitReport[] {
  return units
    .filter((u) => !isUnitLanded(ctx, u.id) && !ctx.latest(scheduledOutputSchemas.review_loop_result, reviewLoopNodeId(u.id))?.passed)
    .map((u) => {
      const state = getUnitState(ctx, units, u.id);
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
        ? `Blocked: dependencies not landed (${(units.find((x) => x.id === u.id)?.deps ?? []).filter((d) => !isUnitLanded(ctx, d)).join(", ")})`
        : `Did not complete within ${maxPasses} passes`;
      const evCtx = getEvictionContext(ctx, u.id);
      if (evCtx) reason = `Evicted from merge queue: ${evCtx.slice(0, 200)}`;
      const testRow = ctx.latest(scheduledOutputSchemas.test, stageNodeId(u.id, "test"));
      if (testRow && !testRow.testsPassed) {
        reason = `Tests failing: ${testRow.failingSummary ?? "unknown"}`;
      }
      return { unitId: u.id, lastStage, reason };
    });
}

// ── Merge ticket building ────────────────────────────────────────────

export function buildMergeTickets(
  ctx: SmithersCtx<ScheduledOutputs>,
  units: WorkUnit[],
  runId: string,
): AgenticMergeQueueTicket[] {
  return units
    .filter((unit) => {
      if (isUnitLanded(ctx, unit.id)) return false;
      if (getUnitState(ctx, units, unit.id) !== "active") return false;
      const reviewResult = ctx.latest(scheduledOutputSchemas.review_loop_result, reviewLoopNodeId(unit.id));
      if (!reviewResult?.passed) return false;

      if (isUnitEvicted(ctx, unit.id)) {
        const latestTest = ctx.latest(scheduledOutputSchemas.test, stageNodeId(unit.id, "test"));
        if (!latestTest?.testsPassed) return false;
        if (!latestTest.buildPassed) return reviewResult.passed ?? false;
      }

      return true;
    })
    .map((unit) => {
      const latestImplement = ctx.latest(scheduledOutputSchemas.implement, stageNodeId(unit.id, "implement"));
      const reviewLoopResult = ctx.latest(scheduledOutputSchemas.review_loop_result, reviewLoopNodeId(unit.id));
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
          reviewLoopIterationCount: reviewLoopResult?.iterationCount ?? null,
          testIteration: null,
        },
      };
    });
}

