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
 * Units become Active only when ALL their deps are Done (landed on main).
 * This replaces the previous fixed-layer model with dynamic dep-based gating.
 */

import React from "react";
import { Ralph, Sequence, Parallel, Task } from "smithers-orchestrator";
import type { SmithersCtx, AgentLike } from "smithers-orchestrator";
import type { WorkUnit, WorkPlan } from "../scheduled/types";
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

// ── Unit States ─────────────────────────────────────────────────────

type UnitState = "done" | "not-ready" | "active";

// ── Tier Completion ─────────────────────────────────────────────────

function tierComplete(
  ctx: SmithersCtx<ScheduledOutputs>,
  units: WorkUnit[],
  unitId: string,
): boolean {
  const unit = units.find((u) => u.id === unitId);
  const tier = unit?.tier ?? "large";

  // All tiers require tests to pass
  const test = ctx.latest("test", `${unitId}:test`);
  if (!test?.testsPassed) return false;

  // buildPassed is required unless a final_review explicitly overrides it
  // (handles pre-existing failures in unrelated packages)
  if (!test?.buildPassed) {
    const fr = ctx.latest("final_review", `${unitId}:final-review`);
    if (!fr?.readyToMoveOn) return false;
  }

  switch (tier) {
    case "small": {
      const fr = ctx.latest("final_review", `${unitId}:final-review`);
      return fr?.readyToMoveOn ?? false;
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
  maxPasses = 9,
  mainBranch = "main",
  agents,
  retries = 1,
}: ScheduledWorkflowProps) {
  const units = workPlan.units;

  // ── Landing status ──────────────────────────────────────────────
  // Land status is read from merge queue outputs (single merge queue node).

  const unitLanded = (unitId: string): boolean => {
    const mq = ctx.latest("merge_queue", "merge-queue");
    if (!mq) return false;
    return mq?.ticketsLanded?.some((t: any) => t.ticketId === unitId) ?? false;
  };

  // Check ALL merge queue outputs across iterations for landed status.
  // ctx.outputs(table) returns all rows; we filter by nodeId manually.
  const unitLandedAcrossIterations = (unitId: string): boolean => {
    const allOutputs = ctx.outputs("merge_queue");
    if (!allOutputs || !Array.isArray(allOutputs)) return unitLanded(unitId);
    return allOutputs
      .filter((row: any) => row?.nodeId === "merge-queue")
      .some(
        (mq: any) => mq?.ticketsLanded?.some((t: any) => t.ticketId === unitId) ?? false,
      );
  };

  // Scan ALL merge queue outputs (not just ctx.latest) so that empty static
  // outputs from iterations with no tickets don't mask prior evictions.
  const unitEvicted = (unitId: string): boolean => {
    if (unitLandedAcrossIterations(unitId)) return false;
    const allOutputs = ctx.outputs("merge_queue");
    if (!allOutputs || !Array.isArray(allOutputs)) return false;
    return allOutputs
      .filter((row: any) => row?.nodeId === "merge-queue")
      .some(
        (mq: any) => mq?.ticketsEvicted?.some((t: any) => t.ticketId === unitId) ?? false,
      );
  };

  const getEvictionContext = (unitId: string): string | null => {
    if (unitLandedAcrossIterations(unitId)) return null;
    const allOutputs = ctx.outputs("merge_queue");
    if (!allOutputs || !Array.isArray(allOutputs)) return null;
    // Scan in reverse (most recent first) to get the latest eviction context
    const relevant = [...allOutputs]
      .filter((row: any) => row?.nodeId === "merge-queue")
      .reverse();
    for (const mq of relevant) {
      const entry = (mq?.ticketsEvicted as any[])?.find((t: any) => t.ticketId === unitId);
      if (entry) return entry?.details ?? null;
    }
    return null;
  };

  // ── Unit state derivation ───────────────────────────────────────

  const getUnitState = (unitId: string): UnitState => {
    // Done: landed on main
    if (unitLandedAcrossIterations(unitId)) return "done";

    // NotReady: at least one dep is not Done
    const unit = units.find((u) => u.id === unitId);
    const deps = unit?.deps ?? [];
    if (deps.length > 0 && !deps.every((depId) => unitLandedAcrossIterations(depId))) {
      return "not-ready";
    }

    // Active: deps satisfied (or none), not landed
    return "active";
  };

  // ── Pass tracking ──────────────────────────────────────────────

  const passTracker = ctx.latest("pass_tracker", "pass-tracker");
  const currentPass = passTracker?.totalIterations ?? 0;
  const allUnitsDone = units.every((u) => unitLandedAcrossIterations(u.id));
  const done = currentPass >= maxPasses || allUnitsDone;

  // ── Dependency summaries ───────────────────────────────────────

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

  // ── Merge queue ticket builder ─────────────────────────────────

  function buildMergeTickets(): AgenticMergeQueueTicket[] {
    return units
      .filter((u) => {
        // Only quality-complete, non-landed units
        if (unitLandedAcrossIterations(u.id)) return false;
        if (getUnitState(u.id) !== "active") return false;
        if (!tierComplete(ctx, units, u.id)) return false;

        // If previously evicted, require fresh passing tests from this iteration
        if (unitEvicted(u.id)) {
          const freshTest = ctx.outputMaybe("test", {
            nodeId: `${u.id}:test`,
            iteration: ctx.iteration,
          });
          if (!freshTest?.testsPassed) return false;
          // buildPassed required unless final_review overrides (pre-existing failures)
          if (!freshTest?.buildPassed) {
            const fr = ctx.latest("final_review", `${u.id}:final-review`);
            return fr?.readyToMoveOn === true;
          }
          return true;
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

  // ── Completion report data ─────────────────────────────────────

  const landedIds = units.filter((u) => unitLandedAcrossIterations(u.id)).map((u) => u.id);
  const failedUnits = units
    .filter((u) => !unitLandedAcrossIterations(u.id))
    .map((u) => {
      const state = getUnitState(u.id);
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
      const evCtx = getEvictionContext(u.id);
      if (evCtx) reason = `Evicted from merge queue: ${evCtx.slice(0, 200)}`;
      const testOut = ctx.latest("test", `${u.id}:test`);
      if (testOut && !testOut.testsPassed) {
        reason = `Tests failing: ${testOut.failingSummary ?? "unknown"}`;
      }
      return { unitId: u.id, lastStage, reason };
    });

  // ── Render ─────────────────────────────────────────────────────

  const testCmd =
    Object.values(workPlan.repo.testCmds).join(" && ") || "none configured";

  const mergeTickets = buildMergeTickets();

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
              const state = getUnitState(unit.id);

              // Done or NotReady → skip
              if (state !== "active") return null;

              // Active + already quality-complete → skip pipeline, enters merge queue
              if (tierComplete(ctx, units, unit.id) && !unitEvicted(unit.id)) return null;

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

          {/* Phase 2: Merge queue — land all quality-complete units */}
          <AgenticMergeQueue
            nodeId="merge-queue"
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

          {/* Pass tracker (compute task — no agent needed) */}
          <Task id="pass-tracker" output={outputs.pass_tracker}>
            {{
              totalIterations: currentPass + 1,
              unitsRun: units
                .filter((u) => getUnitState(u.id) === "active")
                .map((u) => u.id),
              unitsComplete: units
                .filter((u) => unitLandedAcrossIterations(u.id))
                .map((u) => u.id),
              summary: `Pass ${currentPass + 1} of ${maxPasses}. ${units.filter((u) => unitLandedAcrossIterations(u.id)).length}/${units.length} units landed on main. ${units.filter((u) => getUnitState(u.id) === "not-ready").length} units waiting on deps.`,
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
