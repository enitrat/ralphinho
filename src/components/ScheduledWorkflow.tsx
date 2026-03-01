/**
 * ScheduledWorkflow — Main orchestrator for RFC-driven scheduled work.
 *
 * Composes QualityPipeline + AgenticMergeQueue inside a Ralph loop:
 * 1. Compute DAG layers from work plan
 * 2. For each layer (sequential):
 *    a. Run quality pipelines in parallel (one per unit, in isolated worktrees)
 *    b. Run merge queue to land tier-complete units onto main
 * 3. Repeat until all units land or maxPasses reached
 * 4. Emit completion report
 *
 * Land status is read directly from merge_queue outputs —
 * no separate land-record phase needed.
 */

import React from "react";
import { Ralph, Sequence, Parallel, Task } from "smithers-orchestrator";
import type { SmithersCtx, AgentLike } from "smithers-orchestrator";
import { computeLayers, type WorkUnit, type WorkPlan } from "../scheduled/types";
import { QualityPipeline, type DepSummary, type QualityPipelineAgents, type ScheduledOutputs } from "./QualityPipeline";
import { AgenticMergeQueue, type AgenticMergeQueueTicket } from "./AgenticMergeQueue";

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
  mainBranch?: string;
  agents: ScheduledWorkflowAgents;
  retries?: number;
};

// ── Tier Completion ──────────────────────────────────────────────────

function tierComplete(
  ctx: SmithersCtx<ScheduledOutputs>,
  units: WorkUnit[],
  unitId: string,
): boolean {
  const unit = units.find((u) => u.id === unitId);
  const tier = unit?.tier ?? "large";

  // All tiers require tests to pass
  const test = ctx.latest("test", `${unitId}:test`);
  if (!test?.testsPassed || !test?.buildPassed) return false;

  switch (tier) {
    case "trivial":
      return true;
    case "small": {
      const cr = ctx.latest("code_review", `${unitId}:code-review`);
      return cr?.approved ?? false;
    }
    case "medium": {
      const prd = ctx.latest("prd_review", `${unitId}:prd-review`);
      const cr = ctx.latest("code_review", `${unitId}:code-review`);
      if ((prd?.approved ?? false) && (cr?.approved ?? false)) return true;
      const rf = ctx.latest("review_fix", `${unitId}:review-fix`);
      return rf?.allIssuesResolved ?? false;
    }
    case "large":
    default: {
      const fr = ctx.latest("final_review", `${unitId}:final-review`);
      return fr?.readyToMoveOn ?? false;
    }
  }
}

// ── Component ────────────────────────────────────────────────────────

export function ScheduledWorkflow({
  ctx,
  outputs,
  workPlan,
  repoRoot,
  maxConcurrency,
  maxPasses = 3,
  mainBranch = "main",
  agents,
  retries = 1,
}: ScheduledWorkflowProps) {
  const units = workPlan.units;
  const layers = computeLayers(units);

  // Map each unit to its layer index (for reading merge queue outputs)
  const unitLayerMap = new Map<string, number>();
  layers.forEach((layer, idx) => {
    layer.forEach((u) => unitLayerMap.set(u.id, idx));
  });

  // ── Landing gates ────────────────────────────────────────────────
  // Land status is read directly from merge_queue outputs.

  const unitLanded = (unitId: string): boolean => {
    const layerIdx = unitLayerMap.get(unitId);
    if (layerIdx === undefined) return false;
    const mq = ctx.latest("merge_queue", `merge-queue:layer-${layerIdx}`);
    return mq?.ticketsLanded?.some((t: any) => t.ticketId === unitId) ?? false;
  };

  const unitEvicted = (unitId: string): boolean => {
    if (unitLanded(unitId)) return false;
    const layerIdx = unitLayerMap.get(unitId);
    if (layerIdx === undefined) return false;
    const mq = ctx.latest("merge_queue", `merge-queue:layer-${layerIdx}`);
    return mq?.ticketsEvicted?.some((t: any) => t.ticketId === unitId) ?? false;
  };

  const getEvictionContext = (unitId: string): string | null => {
    if (unitLanded(unitId)) return null;
    const layerIdx = unitLayerMap.get(unitId);
    if (layerIdx === undefined) return null;
    const mq = ctx.latest("merge_queue", `merge-queue:layer-${layerIdx}`);
    const entry = mq?.ticketsEvicted?.find((t: any) => t.ticketId === unitId);
    return entry?.details ?? null;
  };

  const unitComplete = (unitId: string): boolean => unitLanded(unitId);

  // ── Pass tracking ────────────────────────────────────────────────

  const passTracker = ctx.latest("pass_tracker", "pass-tracker");
  const currentPass = passTracker?.totalIterations ?? 0;
  const allUnitsComplete = units.every((u) => unitComplete(u.id));
  const done = currentPass >= maxPasses || allUnitsComplete;

  // ── Dependency summaries ─────────────────────────────────────────

  function buildDepSummaries(unit: WorkUnit): DepSummary[] {
    return (unit.deps ?? [])
      .map((depId) => {
        const depImpl = ctx.latest("implement", `${depId}:implement`);
        if (!depImpl) return null;
        return {
          id: depId,
          whatWasDone: depImpl.whatWasDone ?? "",
          filesCreated: (depImpl.filesCreated as string[] | null) ?? [],
          filesModified: (depImpl.filesModified as string[] | null) ?? [],
        };
      })
      .filter(Boolean) as DepSummary[];
  }

  // ── Merge queue ticket builder ───────────────────────────────────

  function buildMergeTickets(layer: WorkUnit[]): AgenticMergeQueueTicket[] {
    return layer
      .filter((u) => {
        if (unitLanded(u.id)) return false;
        if (!tierComplete(ctx, units, u.id)) return false;
        if (unitEvicted(u.id)) {
          const freshTest = ctx.outputMaybe("test", {
            nodeId: `${u.id}:test`,
            iteration: ctx.iteration,
          });
          return freshTest?.testsPassed === true && freshTest?.buildPassed === true;
        }
        return true;
      })
      .map((u) => {
        const impl = ctx.latest("implement", `${u.id}:implement`);
        return {
          ticketId: u.id,
          ticketTitle: u.name,
          ticketCategory: u.tier,
          priority: "medium" as const,
          reportComplete: true,
          landed: false,
          filesModified: (impl?.filesModified as string[] | null) ?? [],
          filesCreated: (impl?.filesCreated as string[] | null) ?? [],
          worktreePath: `/tmp/workflow-wt-${u.id}`,
        };
      });
  }

  // ── Completion report data ───────────────────────────────────────

  const landedIds = units.filter((u) => unitLanded(u.id)).map((u) => u.id);
  const failedUnits = units
    .filter((u) => !unitLanded(u.id))
    .map((u) => {
      const stages: Array<{
        key: keyof ScheduledOutputs;
        stage: string;
        nodeId: string;
      }> = [
        { key: "final_review", stage: "final-review", nodeId: `${u.id}:final-review` },
        { key: "review_fix", stage: "review-fix", nodeId: `${u.id}:review-fix` },
        { key: "code_review", stage: "code-review", nodeId: `${u.id}:code-review` },
        { key: "prd_review", stage: "prd-review", nodeId: `${u.id}:prd-review` },
        { key: "test", stage: "test", nodeId: `${u.id}:test` },
        { key: "implement", stage: "implement", nodeId: `${u.id}:implement` },
        { key: "plan", stage: "plan", nodeId: `${u.id}:plan` },
        { key: "research", stage: "research", nodeId: `${u.id}:research` },
      ];
      let lastStage = "not-started";
      for (const stage of stages) {
        if (ctx.latest(stage.key, stage.nodeId)) {
          lastStage = stage.stage;
          break;
        }
      }
      let reason = `Did not complete within ${maxPasses} passes`;
      const evCtx = getEvictionContext(u.id);
      if (evCtx) reason = `Evicted from merge queue: ${evCtx.slice(0, 200)}`;
      const testOut = ctx.latest("test", `${u.id}:test`);
      if (testOut && !testOut.testsPassed) {
        reason = `Tests failing: ${testOut.failingSummary ?? "unknown"}`;
      }
      return { unitId: u.id, lastStage, reason };
    });

  // ── Render ───────────────────────────────────────────────────────

  const testCmd =
    Object.values(workPlan.repo.testCmds).join(" && ") || "none configured";

  return (
    <Sequence>
      <Ralph
        until={done}
        maxIterations={maxPasses * units.length * 20}
        onMaxReached="return-last"
      >
        <Sequence>
          {layers.map((layer, layerIdx) => {
            const mergeTickets = buildMergeTickets(layer);

            return (
              <Sequence key={`layer-${layerIdx}`}>
                {/* Phase 1: Parallel quality pipelines */}
                <Parallel maxConcurrency={maxConcurrency}>
                  {layer.map((unit) => {
                    if (unitLanded(unit.id)) return null;

                    return (
                      <QualityPipeline
                        key={unit.id}
                        unit={unit}
                        ctx={ctx}
                        outputs={outputs}
                        agents={agents}
                        workPlan={workPlan}
                        depSummaries={buildDepSummaries(unit)}
                        evictionContext={getEvictionContext(unit.id)}
                        pass={currentPass}
                        maxPasses={maxPasses}
                        retries={retries}
                        branchPrefix="unit/"
                      />
                    );
                  })}
                </Parallel>

                {/* Phase 2: Merge queue — land tier-complete units */}
                <AgenticMergeQueue
                  nodeId={`merge-queue:layer-${layerIdx}`}
                  branchPrefix="unit/"
                  ctx={ctx}
                  tickets={mergeTickets}
                  agent={agents.mergeQueue}
                  output={outputs.merge_queue}
                  outputs={outputs}
                  repoRoot={repoRoot}
                  mainBranch={mainBranch}
                  postLandChecks={[testCmd]}
                  preLandChecks={[]}
                />
              </Sequence>
            );
          })}

          {/* Pass tracker (compute task — no agent needed) */}
          <Task id="pass-tracker" output={outputs.pass_tracker}>
            {{
              totalIterations: currentPass + 1,
              unitsRun: units
                .filter((u) => !unitLanded(u.id))
                .map((u) => u.id),
              unitsComplete: units
                .filter((u) => unitLanded(u.id))
                .map((u) => u.id),
              summary: `Pass ${currentPass + 1} of ${maxPasses}. ${units.filter((u) => unitLanded(u.id)).length}/${units.length} units landed on main.`,
            }}
          </Task>
        </Sequence>
      </Ralph>

      {/* Completion report (compute task — no agent needed) */}
      <Task id="completion-report" output={outputs.completion_report}>
        {{
          totalUnits: units.length,
          unitsLanded: landedIds,
          unitsFailed: failedUnits,
          passesUsed: currentPass + 1,
          summary:
            landedIds.length === units.length
              ? `All ${units.length} units landed successfully in ${currentPass + 1} pass(es).`
              : `${landedIds.length}/${units.length} units landed. ${failedUnits.length} unit(s) failed after ${currentPass + 1} pass(es).`,
          nextSteps:
            failedUnits.length === 0
              ? []
              : [
                  "Review failed units and their eviction/test context in .ralphinho/workflow.db",
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
