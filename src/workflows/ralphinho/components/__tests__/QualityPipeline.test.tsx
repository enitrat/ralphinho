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

describe("QualityPipeline stage semantics", () => {
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
    const testTask = tasks[stageNodeId(unit.id, "test")];

    expect(researchTask.skipIf).toBe(true);
    expect(planTask.skipIf).toBe(true);
    expect((researchTask.meta as Record<string, unknown>).retryPolicy).toEqual(STAGE_RETRY_POLICIES["research"]);
    expect((planTask.meta as Record<string, unknown>).retryPolicy).toEqual(STAGE_RETRY_POLICIES["plan"]);
    expect((implementTask.meta as Record<string, unknown>).retryPolicy).toEqual(STAGE_RETRY_POLICIES["implement"]);
    expect((testTask.meta as Record<string, unknown>).retryPolicy).toEqual(STAGE_RETRY_POLICIES["test"]);
    expect((implementTask.meta as Record<string, unknown>).dependsOn).toEqual([
      stageNodeId(unit.id, "plan"),
    ]);
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
