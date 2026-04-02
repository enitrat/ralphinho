import { describe, expect, test } from "bun:test";
import React from "react";
import type { AgentLike, SmithersCtx } from "smithers-orchestrator";
import { scheduledOutputSchemas } from "../../schemas";
import type { WorkPlan, WorkUnit } from "../../types";
import type { QualityPipelineAgents, ScheduledOutputs } from "../QualityPipeline";
import { ScheduledWorkflow, type ScheduledWorkflowAgents } from "../ScheduledWorkflow";

// ── Helpers ──────────────────────────────────────────────────────────

const BASE_PROPS = {
  repoRoot: "/repo",
  maxConcurrency: 1,
  dbPath: "/repo/.ralphinho/workflow.db",
  prompt: "test prompt",
} as const;

function createCtx(opts?: {
  latestImpl?: (table: string, nodeId: string) => unknown;
  outputsByTable?: Record<string, unknown[]>;
}): SmithersCtx<ScheduledOutputs> {
  const outputsByTable = opts?.outputsByTable ?? {};
  const latestImpl = opts?.latestImpl ?? ((table: string, nodeId: string) => {
    const rows = outputsByTable[table] ?? [];
    let best: any = null;
    let bestIteration = -Infinity;
    for (const row of rows) {
      if (!row || (row as { nodeId?: string }).nodeId !== nodeId) continue;
      const iteration = Number((row as { iteration?: number }).iteration ?? 0);
      if (best == null || iteration >= bestIteration) {
        best = row;
        bestIteration = iteration;
      }
    }
    return best;
  });

  const outputsFn = ((table: string) => outputsByTable[table] ?? []) as ((table: string) => unknown[]) & Record<string, unknown[]>;
  for (const [table, rows] of Object.entries(outputsByTable)) {
    outputsFn[table] = rows;
  }

  return {
    runId: "run-1",
    iteration: 0,
    latest: latestImpl,
    outputs: outputsFn,
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
    baseBranch: "main",
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
    mergeQueue: a,
  };
}

/**
 * Walk the React element tree and collect component display names and their props.
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

function findLoop(node: React.ReactNode): Record<string, unknown> | null {
  const matches = findComponentsByName(node, ["Loop"]);
  const outer = matches.find((match) => match.props.id === "outer-ralph-loop");
  return outer?.props ?? null;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("ScheduledWorkflow Monitor embed", () => {
  const savedEnv = process.env.SUPER_RALPH_SKIP_MONITOR;
  const savedIsTTY = process.stdout.isTTY;

  function cleanup() {
    if (savedEnv === undefined) delete process.env.SUPER_RALPH_SKIP_MONITOR;
    else process.env.SUPER_RALPH_SKIP_MONITOR = savedEnv;
    Object.defineProperty(process.stdout, "isTTY", { value: savedIsTTY, writable: true, configurable: true });
  }

  test("renders Monitor when SUPER_RALPH_SKIP_MONITOR is unset and stdout is a TTY", () => {
    delete process.env.SUPER_RALPH_SKIP_MONITOR;
    Object.defineProperty(process.stdout, "isTTY", { value: true, writable: true, configurable: true });

    const element = ScheduledWorkflow({
      ctx: createCtx(),
      outputs: scheduledOutputSchemas,
      workPlan: createWorkPlan(),
      agents: createAgents(),
      ...BASE_PROPS,
    });

    const monitors = findComponentsByName(element, ["Monitor"]);
    expect(monitors).toHaveLength(1);
    expect(monitors[0]!.props.dbPath).toBe("/repo/.ralphinho/workflow.db");
    expect(monitors[0]!.props.runId).toBe("run-1");
    expect(monitors[0]!.props.prompt).toBe("test prompt");
    expect(monitors[0]!.props.repoRoot).toBe("/repo");

    cleanup();
  });

  test("does not render Monitor when SUPER_RALPH_SKIP_MONITOR=1", () => {
    process.env.SUPER_RALPH_SKIP_MONITOR = "1";
    Object.defineProperty(process.stdout, "isTTY", { value: true, writable: true, configurable: true });

    const element = ScheduledWorkflow({
      ctx: createCtx(),
      outputs: scheduledOutputSchemas,
      workPlan: createWorkPlan(),
      agents: createAgents(),
      ...BASE_PROPS,
    });

    const monitors = findComponentsByName(element, ["Monitor"]);
    expect(monitors).toHaveLength(0);

    cleanup();
  });

  test("does not render Monitor when stdout is not a TTY", () => {
    delete process.env.SUPER_RALPH_SKIP_MONITOR;
    Object.defineProperty(process.stdout, "isTTY", { value: undefined, writable: true, configurable: true });

    const element = ScheduledWorkflow({
      ctx: createCtx(),
      outputs: scheduledOutputSchemas,
      workPlan: createWorkPlan(),
      agents: createAgents(),
      ...BASE_PROPS,
    });

    const monitors = findComponentsByName(element, ["Monitor"]);
    expect(monitors).toHaveLength(0);

    cleanup();
  });
});

describe("ScheduledWorkflow landingMode", () => {
  test("renders AgenticMergeQueue when landingMode is omitted (backward compat)", () => {
    const element = ScheduledWorkflow({
      ctx: createCtx(),
      outputs: scheduledOutputSchemas,
      workPlan: createWorkPlan(),
      agents: createAgents(),
      ...BASE_PROPS,
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
      agents: createAgents(),
      landingMode: "merge",
      ...BASE_PROPS,
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
      agents: createAgents(),
      landingMode: "pr",
      ...BASE_PROPS,
    });

    const components = findComponentsByName(element, [
      "AgenticMergeQueue",
      "PushAndCreatePR",
    ]);
    const names = components.map((c) => c.name);
    expect(names).toContain("PushAndCreatePR");
    expect(names).not.toContain("AgenticMergeQueue");
  });

  test("merge mode does not finish outer loop on review completion alone", () => {
    const workPlan = createWorkPlan();
    const element = ScheduledWorkflow({
      ctx: createCtx({
        outputsByTable: {
          review_loop_result: [
            {
              nodeId: "u-1:review-loop",
              iteration: 0,
              iterationCount: 1,
              codeSeverity: "none",
              prdSeverity: "none",
              passed: true,
              exhausted: false,
            },
          ],
        },
      }),
      outputs: scheduledOutputSchemas,
      workPlan,
      agents: createAgents(),
      landingMode: "merge",
      ...BASE_PROPS,
    });

    const loop = findLoop(element);
    expect(loop).not.toBeNull();
    expect(loop?.until).toBe(false);
  });

  test("pr mode may finish outer loop on review completion alone", () => {
    const workPlan = createWorkPlan();
    const element = ScheduledWorkflow({
      ctx: createCtx({
        outputsByTable: {
          review_loop_result: [
            {
              nodeId: "u-1:review-loop",
              iteration: 0,
              iterationCount: 1,
              codeSeverity: "none",
              prdSeverity: "none",
              passed: true,
              exhausted: false,
            },
          ],
        },
      }),
      outputs: scheduledOutputSchemas,
      workPlan,
      agents: createAgents(),
      landingMode: "pr",
      ...BASE_PROPS,
    });

    const loop = findLoop(element);
    expect(loop).not.toBeNull();
    expect(loop?.until).toBe(true);
  });
});
