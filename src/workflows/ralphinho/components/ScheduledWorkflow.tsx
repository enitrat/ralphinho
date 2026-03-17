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
import type { WorkPlan } from "../types";
import { QualityPipeline, type QualityPipelineAgents, type QualityPipelineFallbacks, type ScheduledOutputs } from "./QualityPipeline";
import { AgenticMergeQueue, type AgenticMergeQueueTicket } from "./AgenticMergeQueue";
import { PushAndCreatePR, type PushAndCreatePRTicket } from "./PushAndCreatePR";
import { buildUnitBranchPrefix, buildUnitWorktreePath } from "./runtimeNames";
import {
  COMPLETION_REPORT_NODE_ID,
  MERGE_QUEUE_NODE_ID,
  PASS_TRACKER_NODE_ID,
  PR_CREATION_NODE_ID,
} from "../workflow/contracts";
import {
  buildDepSummaries,
  buildFailedUnitReport,
  buildMergeTickets,
  getEvictionContext,
  getUnitState,
  type UnitState,
} from "../workflow/state";
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
  baseBranch = "main",
  landingMode = "merge",
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
  const unitState = (unitId: string): UnitState => getUnitState(snapshot, units, unitId);
  const unitEvictionContext = (unitId: string) => getEvictionContext(snapshot, unitId);

  // ── Pass tracking ──────────────────────────────────────────────

  const passTracker = ctx.latest("pass_tracker", PASS_TRACKER_NODE_ID);
  const currentPass = passTracker?.totalIterations ?? 0;
  const allUnitsLanded = units.every((u) => snapshot.isUnitLanded(u.id));
  const done = currentPass >= maxPasses || allUnitsLanded;

  // ── Completion report data ─────────────────────────────────────

  const landedIds = units.filter((u) => snapshot.isUnitLanded(u.id)).map((u) => u.id);
  const semanticallyCompleteIds = units
    .filter((u) => snapshot.latestReviewLoopResult(u.id)?.passed === true)
    .map((u) => u.id);
  const failedUnits = buildFailedUnitReport(
    snapshot, units, maxPasses,
    (key, nodeId) => !!ctx.latest(key as keyof ScheduledOutputs, nodeId),
  );

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
              if (snapshot.latestReviewLoopResult(unit.id)?.passed === true && !unitEvictionContext(unit.id)) return null;

              return (
                <QualityPipeline
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

          {/* Pass tracker (compute task — no agent needed) */}
          <Task id={PASS_TRACKER_NODE_ID} output={outputs.pass_tracker}>
            {{
              totalIterations: currentPass + 1,
              unitsRun: units
                .filter((u) => unitState(u.id) === "active")
                .map((u) => u.id),
              unitsComplete: semanticallyCompleteIds,
              unitsLanded: units
                .filter((u) => snapshot.isUnitLanded(u.id))
                .map((u) => u.id),
              unitsSemanticallyComplete: semanticallyCompleteIds,
              summary: `Pass ${currentPass + 1} of ${maxPasses}. ${units.filter((u) => snapshot.isUnitLanded(u.id)).length}/${units.length} units landed on ${baseBranch}. ${units.filter((u) => unitState(u.id) === "not-ready").length} units waiting on deps.`,
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
                  "Review failed units, review-loop outputs, and eviction/test context in .ralphinho/workflow.db",
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
