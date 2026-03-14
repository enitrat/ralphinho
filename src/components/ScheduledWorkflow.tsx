/**
 * ScheduledWorkflow — Main orchestrator for RFC-driven scheduled work.
 *
 * Composes QualityPipeline + AgenticMergeQueue inside a single Ralph loop
 * with dynamic dependency-based scheduling:
 *
 * 1. On each iteration, classify every unit: Done / NotReady / Active
 * 2. Run quality pipelines in parallel for all Active units
 * 3. Run merge queue for all freshly quality-complete units
 * 4. Repeat until all units are Done (landed) or maxPasses reached
 * 5. Emit completion report
 *
 * Units become Active only when ALL their deps are Done (landed on the base branch).
 * This replaces the previous fixed-layer model with dynamic dep-based gating.
 */

import React from "react";
import { Ralph, Sequence, Parallel, Task } from "smithers-orchestrator";
import type { SmithersCtx } from "smithers-orchestrator";
import type { AgentLike } from "smithers-orchestrator";
import type { WorkPlan } from "../scheduled/types";
import { QualityPipeline, type QualityPipelineAgents, type QualityPipelineFallbacks, type ScheduledOutputs } from "./QualityPipeline";
import { AgenticMergeQueue, type AgenticMergeQueueTicket } from "./AgenticMergeQueue";
import { buildUnitBranchPrefix, buildUnitWorktreePath } from "./runtimeNames";
import {
  COMPLETION_REPORT_NODE_ID,
  MERGE_QUEUE_NODE_ID,
  PASS_TRACKER_NODE_ID,
  stageNodeId,
  TIER_STAGES,
} from "../workflow/contracts";
import {
  buildDepSummaries,
  buildMergeTickets,
  getEvictionContext,
  getUnitState,
  isTierComplete,
  isUnitLanded,
  type UnitState,
} from "../workflow/state";
import { type DecisionAudit, getDecisionAudit } from "../workflow/decisions";
import { buildSnapshot } from "../workflow/snapshot";

// ── Types ────────────────────────────────────────────────────────────

export type ScheduledWorkflowAgents = QualityPipelineAgents & {
  mergeQueue: AgentLike | AgentLike[];
};

export type ScheduledWorkflowProps = {
  ctx: SmithersCtx<ScheduledOutputs>;
  outputs: ScheduledOutputs;
  workPlan: WorkPlan;
  repoRoot: string;
  maxConcurrency: number;
  maxPasses?: number;
  baseBranch?: string;
  agents: ScheduledWorkflowAgents;
  fallbacks?: QualityPipelineFallbacks & { mergeQueue?: AgentLike };
};

// ── Component ────────────────────────────────────────────────────────

export function ScheduledWorkflow({
  ctx,
  outputs,
  workPlan,
  repoRoot,
  maxConcurrency,
  maxPasses = 9,
  baseBranch = "main",
  agents,
  fallbacks,
}: ScheduledWorkflowProps) {
  const units = workPlan.units;
  const unitBranchPrefix = buildUnitBranchPrefix(ctx.runId, "unit/");
  const buildChecks = Object.values(workPlan.repo.buildCmds);
  const testChecks = Object.values(workPlan.repo.testCmds);
  const verificationChecks = Array.from(new Set([...buildChecks, ...testChecks]));
  const snapshot = buildSnapshot(ctx);

  // ── Landing status ──────────────────────────────────────────────
  const unitLandedAcrossIterations = (unitId: string) => isUnitLanded(snapshot, unitId);
  const unitState = (unitId: string): UnitState => getUnitState(snapshot, units, unitId);
  const unitEvictionContext = (unitId: string) => getEvictionContext(snapshot, unitId);

  // ── Decision audit (computed once per unit) ────────────────────
  const auditMap = new Map<string, DecisionAudit>(
    units.map((u) => [u.id, getDecisionAudit(snapshot, u.id)]),
  );
  const unitAudit = (unitId: string) => auditMap.get(unitId)!;
  const isSemanticComplete = (unitId: string) => unitAudit(unitId).semanticallyComplete;

  // ── Pass tracking ──────────────────────────────────────────────

  const passTracker = ctx.latest("pass_tracker", PASS_TRACKER_NODE_ID);
  const currentPass = passTracker?.totalIterations ?? 0;
  const allUnitsLanded = units.every((u) => unitLandedAcrossIterations(u.id));
  const allUnitsSemanticallyComplete = units.every((u) => isSemanticComplete(u.id));
  const done = currentPass >= maxPasses || allUnitsLanded || allUnitsSemanticallyComplete;

  // ── Completion report data ─────────────────────────────────────

  const landedIds = units.filter((u) => unitLandedAcrossIterations(u.id)).map((u) => u.id);
  const semanticallyCompleteIds = units.filter((u) => isSemanticComplete(u.id)).map((u) => u.id);
  const failedUnits = units
    .filter((u) => !isSemanticComplete(u.id))
    .map((u) => {
      const state = unitState(u.id);
      const audit = unitAudit(u.id);
      const tierStages = TIER_STAGES[u.tier] ?? TIER_STAGES.large;
      const allStages = [
        { key: "final_review", stage: "final-review", nodeId: stageNodeId(u.id, "final-review") },
        { key: "review_fix", stage: "review-fix", nodeId: stageNodeId(u.id, "review-fix") },
        { key: "code_review", stage: "code-review", nodeId: stageNodeId(u.id, "code-review") },
        { key: "prd_review", stage: "prd-review", nodeId: stageNodeId(u.id, "prd-review") },
        { key: "test", stage: "test", nodeId: stageNodeId(u.id, "test") },
        { key: "implement", stage: "implement", nodeId: stageNodeId(u.id, "implement") },
        { key: "plan", stage: "plan", nodeId: stageNodeId(u.id, "plan") },
        { key: "research", stage: "research", nodeId: stageNodeId(u.id, "research") },
      ] as const;
      const stages: Array<{ key: keyof ScheduledOutputs; stage: string; nodeId: string }> = allStages
        .filter((stage) => tierStages.includes(stage.stage as typeof tierStages[number]))
        .map((stage) => ({ key: stage.key, stage: stage.stage, nodeId: stage.nodeId }));
      let lastStage = state === "not-ready" ? "blocked-by-deps" : "not-started";
      for (const stage of stages) {
        if (ctx.latest(stage.key, stage.nodeId)) {
          lastStage = stage.stage;
          break;
        }
      }
      let reason = state === "not-ready"
        ? `Blocked: dependencies not landed (${(units.find((x) => x.id === u.id)?.deps ?? []).filter((d) => !unitLandedAcrossIterations(d)).join(", ")})`
        : `Did not complete within ${maxPasses} passes`;
      const evCtx = unitEvictionContext(u.id);
      if (evCtx) reason = `Evicted from merge queue: ${evCtx.slice(0, 200)}`;
      const testOut = ctx.latest("test", stageNodeId(u.id, "test"));
      if (testOut && !testOut.testsPassed) {
        reason = `Tests failing: ${testOut.failingSummary ?? "unknown"}`;
      }
      if (audit.status === "rejected") {
        reason = `Final review rejected: ${audit.finalDecision?.reasoning ?? "missing reasoning"}`;
      }
      if (audit.status === "invalidated") {
        reason = audit.finalDecision?.approvalOnlyCorrectedFormatting
          ? "Final review approval only repaired formatting/schema after a rejection; no new substantive evidence was recorded."
          : "Final review approval is stale or invalidated.";
      }
      if (unitLandedAcrossIterations(u.id) && !isSemanticComplete(u.id)) {
        reason = `Landed without semantic completion: ${reason}`;
      }
      return { unitId: u.id, lastStage, reason };
    });

  // ── Render ─────────────────────────────────────────────────────

  const mergeTickets: AgenticMergeQueueTicket[] = buildMergeTickets(
    snapshot,
    units,
    ctx.runId,
    ctx.iteration,
  );

  return (
    <Sequence>
      <Ralph
        until={done}
        maxIterations={maxPasses * units.length * 20}
        onMaxReached="return-last"
      >
        <Sequence>
          {/* Phase 1: Quality pipelines for all Active units */}
          <Parallel maxConcurrency={maxConcurrency}>
            {units.map((unit) => {
              const state = unitState(unit.id);

              // Done or NotReady → skip
              if (state !== "active") return null;

              // Active + already quality-complete → skip pipeline, enters merge queue
              if (isTierComplete(snapshot, unit.id) && !unitEvictionContext(unit.id)) return null;

              return (
                <QualityPipeline
                  key={unit.id}
                  unit={unit}
                  ctx={ctx}
                  outputs={outputs}
                  agents={agents}
                  fallbacks={fallbacks}
                  workPlan={workPlan}
                  depSummaries={buildDepSummaries(snapshot, unit)}
                  evictionContext={unitEvictionContext(unit.id)}
                  pass={currentPass}
                  maxPasses={maxPasses}
                  branchPrefix={unitBranchPrefix}
                  worktreePath={buildUnitWorktreePath(ctx.runId, unit.id)}
                />
              );
            })}
          </Parallel>

          {/* Phase 2: Merge queue — land all quality-complete units */}
          <AgenticMergeQueue
            nodeId={MERGE_QUEUE_NODE_ID}
            branchPrefix={unitBranchPrefix}
            ctx={ctx}
            tickets={mergeTickets}
            agent={agents.mergeQueue}
            fallbackAgent={fallbacks?.mergeQueue}
            output={outputs.merge_queue}
            outputs={outputs}
            repoRoot={repoRoot}
            baseBranch={baseBranch}
            postLandChecks={verificationChecks}
            preLandChecks={verificationChecks}
          />

          {/* Pass tracker (compute task — no agent needed) */}
          <Task id={PASS_TRACKER_NODE_ID} output={outputs.pass_tracker}>
            {{
              totalIterations: currentPass + 1,
              unitsRun: units
                .filter((u) => unitState(u.id) === "active")
                .map((u) => u.id),
              unitsComplete: semanticallyCompleteIds,
              unitsLanded: units
                .filter((u) => unitLandedAcrossIterations(u.id))
                .map((u) => u.id),
              unitsSemanticallyComplete: semanticallyCompleteIds,
              summary: `Pass ${currentPass + 1} of ${maxPasses}. ${units.filter((u) => unitLandedAcrossIterations(u.id)).length}/${units.length} units landed on ${baseBranch}. ${units.filter((u) => unitState(u.id) === "not-ready").length} units waiting on deps.`,
            }}
          </Task>
        </Sequence>
      </Ralph>

      {/* Completion report (compute task — no agent needed) */}
      <Task id={COMPLETION_REPORT_NODE_ID} output={outputs.completion_report}>
        {{
          totalUnits: units.length,
          unitsLanded: landedIds,
          unitsSemanticallyComplete: semanticallyCompleteIds,
          unitsFailed: failedUnits,
          passesUsed: currentPass + 1,
          summary:
            semanticallyCompleteIds.length === units.length
              ? `All ${units.length} units landed and are semantically complete in ${currentPass + 1} pass(es).`
              : landedIds.length === units.length
                ? `All ${units.length} units landed, but only ${semanticallyCompleteIds.length} are semantically complete after ${currentPass + 1} pass(es).`
                : `${landedIds.length}/${units.length} units landed and ${semanticallyCompleteIds.length}/${units.length} are semantically complete after ${currentPass + 1} pass(es).`,
          nextSteps:
            failedUnits.length === 0
              ? []
              : [
                  "Review failed units and their decision history, merge eligibility, and eviction/test context in .ralphinho/workflow.db",
                  "Consider running 'ralphinho run --resume' to retry failed units",
                  ...failedUnits.map(
                    (f) =>
                      `${f.unitId}: last reached ${f.lastStage} — ${f.reason}`,
                  ),
                ],
        }}
      </Task>
    </Sequence>
  );
}
