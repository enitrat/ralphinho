import { describe, expect, test } from "bun:test";
import React from "react";
import type { AgentLike, SmithersCtx } from "smithers-orchestrator";
import { scheduledOutputSchemas } from "../../schemas";
import type { WorkPlan, WorkUnit } from "../../types";
import {
  STAGE_RETRY_POLICIES,
  stageNodeId,
} from "../../workflow/contracts";
import {
  QualityPipeline,
  type QualityPipelineAgents,
  type ScheduledOutputs,
} from "../QualityPipeline";
import { ReviewLoop } from "../ReviewLoop";

function createCtx(latestImpl: (table: string, nodeId: string) => unknown): SmithersCtx<ScheduledOutputs> {
  return {
    runId: "run-1",
    latest: latestImpl,
  } as unknown as SmithersCtx<ScheduledOutputs>;
}

function createWorkPlan(unit: WorkUnit): WorkPlan {
  return {
    source: "docs/rfc.md",
    generatedAt: "2026-03-15T00:00:00.000Z",
    repo: {
      projectName: "super-ralph",
      buildCmds: { typecheck: "bun run typecheck" },
      testCmds: { unit: "bun test" },
    },
    units: [unit],
  };
}

function createAgents(): QualityPipelineAgents {
  const a = {} as AgentLike;
  return {
    researcher: a,
    planner: a,
    implementer: a,
    tester: a,
    prdReviewer: a,
    codeReviewer: a,
    reviewFixer: a,
  };
}

function collectTasks(node: React.ReactNode): Record<string, Record<string, unknown>> {
  const tasks: Record<string, Record<string, unknown>> = {};

  function walk(current: React.ReactNode): void {
    if (!React.isValidElement(current)) return;
    const props = (current as React.ReactElement).props as Record<string, unknown>;
    const id = props.id;
    if (typeof id === "string") {
      tasks[id] = props;
    }

    const children = props.children;
    if (Array.isArray(children)) {
      for (const child of children) walk(child);
      return;
    }
    if (children != null) {
      walk(children as React.ReactNode);
    }
  }

  walk(node);
  return tasks;
}

function collectTopSequenceChildren(node: React.ReactNode): React.ReactElement[] {
  if (!React.isValidElement(node)) return [];
  const worktreeChildren = (node.props as { children?: React.ReactNode }).children;
  if (!React.isValidElement(worktreeChildren)) return [];
  const sequenceChildren = (worktreeChildren.props as { children?: React.ReactNode }).children;
  if (Array.isArray(sequenceChildren)) {
    return sequenceChildren.filter(React.isValidElement) as React.ReactElement[];
  }
  return React.isValidElement(sequenceChildren) ? [sequenceChildren] : [];
}

describe("QualityPipeline stage semantics", () => {
  test("learnings depends on review-loop result and final-review stage is absent", () => {
    const unit: WorkUnit = {
      id: "u-learnings",
      name: "Learn unit",
      rfcSections: [],
      description: "desc",
      deps: [],
      acceptance: ["ac1"],
      tier: "small",
    };
    const workPlan = createWorkPlan(unit);
    const ctx = createCtx(() => null);

    const element = QualityPipeline({
      unit,
      ctx,
      outputs: scheduledOutputSchemas,
      agents: {
        ...createAgents(),
        learningsExtractor: {} as AgentLike,
      },
      workPlan,
      depSummaries: [],
      evictionContext: null,
    });

    const tasks = collectTasks(element);
    const learningsTask = tasks[stageNodeId(unit.id, "learnings")];

    expect(learningsTask).toBeDefined();
    expect((learningsTask.meta as Record<string, unknown>).dependsOn).toEqual([
      `${unit.id}:review-loop`,
    ]);
    expect(tasks[`${unit.id}:final-review`]).toBeUndefined();
  });

  test("large-tier QualityPipeline has no direct review stage tasks", () => {
    const unit: WorkUnit = {
      id: "u-large-review-structure",
      name: "Large unit",
      rfcSections: ["sec-a"],
      description: "desc",
      deps: [],
      acceptance: ["ac1"],
      tier: "large",
    };
    const workPlan = createWorkPlan(unit);
    const ctx = createCtx(() => null);

    const element = QualityPipeline({
      unit,
      ctx,
      outputs: scheduledOutputSchemas,
      agents: {
        ...createAgents(),
        learningsExtractor: {} as AgentLike,
      },
      workPlan,
      depSummaries: [],
      evictionContext: null,
    });

    const tasks = collectTasks(element);
    const topChildren = collectTopSequenceChildren(element);
    const implementIndex = topChildren.findIndex(
      (child) => (child.props as Record<string, unknown>).id === stageNodeId(unit.id, "implement"),
    );
    const reviewLoopIndex = topChildren.findIndex((child) => child.type === ReviewLoop);
    const learningsIndex = topChildren.findIndex(
      (child) => (child.props as Record<string, unknown>).id === stageNodeId(unit.id, "learnings"),
    );

    expect(tasks[stageNodeId(unit.id, "implement")]).toBeDefined();
    expect(tasks[stageNodeId(unit.id, "test")]).toBeUndefined();
    expect(tasks[stageNodeId(unit.id, "prd-review")]).toBeUndefined();
    expect(tasks[stageNodeId(unit.id, "code-review")]).toBeUndefined();
    expect(tasks[stageNodeId(unit.id, "review-fix")]).toBeUndefined();
    expect(reviewLoopIndex).toBeGreaterThanOrEqual(0);
    expect(implementIndex).toBeLessThan(reviewLoopIndex);
    expect(reviewLoopIndex).toBeLessThan(learningsIndex);
  });

  test("applies retry policy semantics and input-matched cache skips for large units", () => {
    const unit: WorkUnit = {
      id: "u-large",
      name: "Large unit",
      rfcSections: ["sec-a"],
      description: "desc",
      deps: [],
      acceptance: ["ac1"],
      tier: "large",
    };
    const workPlan = createWorkPlan(unit);

    const researchSig = JSON.stringify({
      unitId: unit.id,
      unitName: unit.name,
      unitDescription: unit.description,
      unitCategory: unit.tier,
      rfcSource: workPlan.source,
      rfcSections: unit.rfcSections,
      referencePaths: [workPlan.source],
      evictionContext: null,
    });

    const planSig = JSON.stringify({
      unitId: unit.id,
      unitName: unit.name,
      unitDescription: unit.description,
      unitCategory: unit.tier,
      acceptanceCriteria: unit.acceptance,
      contextFilePath: `docs/research/${unit.id}.md`,
      researchSummary: undefined,
      evictionContext: null,
    });

    const ctx = createCtx((table, nodeId) => {
      if (table === "research" && nodeId === stageNodeId(unit.id, "research")) {
        return {
          contextFilePath: `docs/research/${unit.id}.md`,
          findings: [],
          referencesRead: [],
          openQuestions: [],
          notes: null,
          inputSignature: researchSig,
        };
      }
      if (table === "plan" && nodeId === stageNodeId(unit.id, "plan")) {
        return {
          planFilePath: `docs/plans/${unit.id}.md`,
          implementationSteps: [],
          filesToCreate: [],
          filesToModify: [],
          complexity: "large",
          inputSignature: planSig,
        };
      }
      return null;
    });

    const element = QualityPipeline({
      unit,
      ctx,
      outputs: scheduledOutputSchemas,
      agents: createAgents(),
      workPlan,
      depSummaries: [],
      evictionContext: null,
    });

    const tasks = collectTasks(element);
    const researchTask = tasks[stageNodeId(unit.id, "research")];
    const planTask = tasks[stageNodeId(unit.id, "plan")];
    const implementTask = tasks[stageNodeId(unit.id, "implement")];

    expect(researchTask.skipIf).toBe(true);
    expect(planTask.skipIf).toBe(true);
    expect((researchTask.meta as Record<string, unknown>).retryPolicy).toEqual(STAGE_RETRY_POLICIES["research"]);
    expect((planTask.meta as Record<string, unknown>).retryPolicy).toEqual(STAGE_RETRY_POLICIES["plan"]);
    expect((implementTask.meta as Record<string, unknown>).retryPolicy).toEqual(STAGE_RETRY_POLICIES["implement"]);
    expect((implementTask.meta as Record<string, unknown>).dependsOn).toEqual([
      stageNodeId(unit.id, "plan"),
    ]);
  });

  test("small-tier QualityPipeline has no direct review stage tasks", () => {
    const unit: WorkUnit = {
      id: "u-small-review-structure",
      name: "Small unit",
      rfcSections: [],
      description: "desc",
      deps: [],
      acceptance: ["ac1"],
      tier: "small",
    };
    const workPlan = createWorkPlan(unit);
    const ctx = createCtx(() => null);

    const element = QualityPipeline({
      unit,
      ctx,
      outputs: scheduledOutputSchemas,
      agents: createAgents(),
      workPlan,
      depSummaries: [],
      evictionContext: null,
    });

    const tasks = collectTasks(element);
    expect(tasks[stageNodeId(unit.id, "test")]).toBeUndefined();
    expect(tasks[stageNodeId(unit.id, "prd-review")]).toBeUndefined();
    expect(tasks[stageNodeId(unit.id, "code-review")]).toBeUndefined();
    expect(tasks[stageNodeId(unit.id, "review-fix")]).toBeUndefined();
  });

  test("does not include a plan dependency for small-tier implement stage", () => {
    const unit: WorkUnit = {
      id: "u-small",
      name: "Small unit",
      rfcSections: [],
      description: "desc",
      deps: [],
      acceptance: ["ac1"],
      tier: "small",
    };
    const workPlan = createWorkPlan(unit);
    const ctx = createCtx(() => null);

    const element = QualityPipeline({
      unit,
      ctx,
      outputs: scheduledOutputSchemas,
      agents: createAgents(),
      workPlan,
      depSummaries: [],
      evictionContext: null,
    });

    const tasks = collectTasks(element);
    const implementTask = tasks[stageNodeId(unit.id, "implement")];

    expect(implementTask).toBeDefined();
    expect((implementTask.meta as Record<string, unknown>).dependsOn).toEqual([]);
  });
});
