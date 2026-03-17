import { describe, expect, test } from "bun:test";
import React from "react";
import type { AgentLike, SmithersCtx } from "smithers-orchestrator";
import { scheduledOutputSchemas } from "../../schemas";
import type { WorkPlan, WorkUnit } from "../../types";
import type { QualityPipelineAgents, ScheduledOutputs } from "../QualityPipeline";
import { ScheduledWorkflow, type ScheduledWorkflowAgents } from "../ScheduledWorkflow";

// ── Helpers ──────────────────────────────────────────────────────────

function createCtx(latestImpl?: (table: string, nodeId: string) => unknown): SmithersCtx<ScheduledOutputs> {
  return {
    runId: "run-1",
    iteration: 0,
    latest: latestImpl ?? (() => null),
  } as unknown as SmithersCtx<ScheduledOutputs>;
}

function createWorkPlan(): WorkPlan {
  const unit: WorkUnit = {
    id: "u-1",
    name: "Unit 1",
    rfcSections: [],
    description: "desc",
    deps: [],
    acceptance: ["ac1"],
    tier: "small",
  };
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

function createAgents(): ScheduledWorkflowAgents {
  const a = {} as AgentLike;
  return {
    researcher: a,
    planner: a,
    implementer: a,
    tester: a,
    prdReviewer: a,
    codeReviewer: a,
    reviewFixer: a,
    finalReviewer: a,
    mergeQueue: a,
  };
}

/**
 * Walk the React element tree and collect component display names and their props.
 * We look for components named "AgenticMergeQueue" or "PushAndCreatePR".
 */
function findComponentsByName(
  node: React.ReactNode,
  targetNames: string[],
): Array<{ name: string; props: Record<string, unknown> }> {
  const found: Array<{ name: string; props: Record<string, unknown> }> = [];

  function walk(current: React.ReactNode): void {
    if (!React.isValidElement(current)) return;

    const element = current as React.ReactElement;
    const type = element.type;

    // Check function component name
    if (typeof type === "function") {
      const name = (type as any).displayName || (type as any).name || "";
      if (targetNames.includes(name)) {
        found.push({ name, props: element.props as Record<string, unknown> });
      }
    }

    // Walk children
    const props = element.props as Record<string, unknown>;
    const children = props.children;
    if (Array.isArray(children)) {
      for (const child of children) walk(child);
    } else if (children != null) {
      walk(children as React.ReactNode);
    }
  }

  walk(node);
  return found;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("ScheduledWorkflow landingMode", () => {
  test("renders AgenticMergeQueue when landingMode is omitted (backward compat)", () => {
    const element = ScheduledWorkflow({
      ctx: createCtx(),
      outputs: scheduledOutputSchemas,
      workPlan: createWorkPlan(),
      repoRoot: "/repo",
      maxConcurrency: 1,
      agents: createAgents(),
    });

    const components = findComponentsByName(element, [
      "AgenticMergeQueue",
      "PushAndCreatePR",
    ]);
    const names = components.map((c) => c.name);
    expect(names).toContain("AgenticMergeQueue");
    expect(names).not.toContain("PushAndCreatePR");
  });

  test("renders AgenticMergeQueue when landingMode is 'merge'", () => {
    const element = ScheduledWorkflow({
      ctx: createCtx(),
      outputs: scheduledOutputSchemas,
      workPlan: createWorkPlan(),
      repoRoot: "/repo",
      maxConcurrency: 1,
      agents: createAgents(),
      landingMode: "merge",
    });

    const components = findComponentsByName(element, [
      "AgenticMergeQueue",
      "PushAndCreatePR",
    ]);
    const names = components.map((c) => c.name);
    expect(names).toContain("AgenticMergeQueue");
    expect(names).not.toContain("PushAndCreatePR");
  });

  test("renders PushAndCreatePR when landingMode is 'pr'", () => {
    const element = ScheduledWorkflow({
      ctx: createCtx(),
      outputs: scheduledOutputSchemas,
      workPlan: createWorkPlan(),
      repoRoot: "/repo",
      maxConcurrency: 1,
      agents: createAgents(),
      landingMode: "pr",
    });

    const components = findComponentsByName(element, [
      "AgenticMergeQueue",
      "PushAndCreatePR",
    ]);
    const names = components.map((c) => c.name);
    expect(names).toContain("PushAndCreatePR");
    expect(names).not.toContain("AgenticMergeQueue");
  });
});
