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
import { Sequence, Parallel, Task, Loop } from "smithers-orchestrator";
import type { SmithersCtx } from "smithers-orchestrator";
import type { AgentLike } from "smithers-orchestrator";
import type { WorkPlan } from "../types";
import { QualityPipeline, type QualityPipelineAgents, type QualityPipelineFallbacks, type ScheduledOutputs } from "./QualityPipeline";
import { AgenticMergeQueue, type AgenticMergeQueueTicket } from "./AgenticMergeQueue";
import { PushAndCreatePR, type PushAndCreatePRTicket } from "./PushAndCreatePR";
import { buildUnitBranchPrefix, buildUnitWorktreePath } from "./runtimeNames";
import {
  COMPLETION_REPORT_NODE_ID,
  MERGE_QUEUE_NODE_ID,
  PR_CREATION_NODE_ID,
  reviewLoopNodeId,
  stageNodeId,
} from "../workflow/contracts";
import { scheduledOutputSchemas } from "../schemas";
import {
  buildDepSummaries,
  buildFailedUnitReport,
  buildMergeTickets,
  getEvictionContext,
  getUnitState,
  isUnitLanded,
  shouldRunPipeline,
  type UnitState,
} from "../workflow/state";

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
  landingMode?: "merge" | "pr";
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
  landingMode = "merge",
  agents,
  fallbacks,
}: ScheduledWorkflowProps) {
  const baseBranch = workPlan.baseBranch;
  const units = workPlan.units;
  const unitBranchPrefix = buildUnitBranchPrefix(ctx.runId, "unit/");
  const buildChecks = Object.values(workPlan.repo.buildCmds);
  const testChecks = Object.values(workPlan.repo.testCmds);
  const verificationChecks = Array.from(new Set([...buildChecks, ...testChecks]));

  // ── Termination condition ──
  const completionReports = ctx.outputs("completion_report") ?? [];
  const currentPass = completionReports.length;
  const allUnitsLanded = units.every((u) => isUnitLanded(ctx, u.id));
  const allUnitsReviewComplete = units.every(
    (u) => isUnitLanded(ctx, u.id) || ctx.latest(scheduledOutputSchemas.review_loop_result, reviewLoopNodeId(u.id))?.passed,
  );
  const done = currentPass >= maxPasses || allUnitsLanded || (landingMode === "pr" && allUnitsReviewComplete);

  // ── Completion report data ─────────────────────────────────────

  const landedIds = units.filter((u) => isUnitLanded(ctx, u.id)).map((u) => u.id);
  const reviewCompleteIds = units
    .filter((u) => isUnitLanded(ctx, u.id) && (ctx.latest(scheduledOutputSchemas.review_loop_result, reviewLoopNodeId(u.id))?.passed ?? false))
    .map((u) => u.id);
  const failedUnits = buildFailedUnitReport(
    ctx, units, maxPasses,
    (key, nodeId) => !!ctx.latest(key, nodeId),
  );

  // ── Render ─────────────────────────────────────────────────────

  const mergeTickets: AgenticMergeQueueTicket[] = buildMergeTickets(
    ctx,
    units,
    ctx.runId,
  );

  return (
    <Sequence>
      <Loop
        id="outer-ralph-loop"
        until={done}
        maxIterations={maxPasses * units.length * 20}
        onMaxReached="return-last"
      >
        <Sequence>
          {/* Phase 1: Quality pipelines for all Active units */}
          <Parallel maxConcurrency={maxConcurrency}>
            {units.filter((u) => shouldRunPipeline(ctx, u, units)).map((unit) => (
              <QualityPipeline
                key={unit.id}
                unit={unit}
                ctx={ctx}
                outputs={outputs}
                agents={agents}
                fallbacks={fallbacks}
                workPlan={workPlan}
                depSummaries={buildDepSummaries(ctx, unit)}
                evictionContext={getEvictionContext(ctx, unit.id)}
                pass={currentPass}
                maxPasses={maxPasses}
                branchPrefix={unitBranchPrefix}
                worktreePath={buildUnitWorktreePath(ctx.runId, unit.id)}
              />
            ))}
          </Parallel>

          {/* Phase 2: Land completed units via merge queue or PR creation */}
          {landingMode === "pr" ? (
            <PushAndCreatePR
              ctx={ctx}
              tickets={mergeTickets.map((t) => ({
                ticketId: t.ticketId,
                ticketTitle: t.ticketTitle,
                branch: `${unitBranchPrefix}${t.ticketId}`,
                worktreePath: t.worktreePath,
                filesModified: t.filesModified,
                filesCreated: t.filesCreated,
              }))}
              agent={agents.mergeQueue}
              fallbackAgent={fallbacks?.mergeQueue}
              repoRoot={repoRoot}
              baseBranch={baseBranch}
              branchPrefix={unitBranchPrefix}
              output={outputs.pr_creation}
              nodeId={PR_CREATION_NODE_ID}
            />
          ) : (
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
          )}
        </Sequence>
      </Loop>

      {/* Completion report (compute task — no agent needed) */}
      <Task id={COMPLETION_REPORT_NODE_ID} output={outputs.completion_report}>
        {{
          totalUnits: units.length,
          unitsLanded: landedIds,
          unitsSemanticallyComplete: reviewCompleteIds,
          unitsFailed: failedUnits,
          passesUsed: currentPass + 1,
          summary:
            reviewCompleteIds.length === units.length
              ? `All ${units.length} units landed and are semantically complete in ${currentPass + 1} pass(es).`
              : landedIds.length === units.length
                ? `All ${units.length} units landed, but only ${reviewCompleteIds.length} are semantically complete after ${currentPass + 1} pass(es).`
                : `${landedIds.length}/${units.length} units landed and ${reviewCompleteIds.length}/${units.length} are semantically complete after ${currentPass + 1} pass(es).`,
          nextSteps:
            failedUnits.length === 0
              ? []
              : [
                  "Review failed units and their review loop result, merge eligibility, and eviction/test context in .ralphinho/smithers.db",
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
