import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import React from "react";
import { Ralph } from "smithers-orchestrator";
import type { AgentLike, SmithersCtx } from "smithers-orchestrator";
import { scheduledOutputSchemas } from "../../schemas";
import type { WorkUnit } from "../../types";
import { stageNodeId } from "../../workflow/contracts";
import type { ScheduledOutputs } from "../QualityPipeline";
import { ReviewLoop, type ReviewLoopAgents } from "../ReviewLoop";
import { resolveTableName } from "../../__tests__/testUtils";

function createCtx(opts?: {
  latestMap?: Map<string, unknown>;
  outputsByTable?: Record<string, unknown[]>;
}): SmithersCtx<ScheduledOutputs> {
  const latestMap = opts?.latestMap ?? new Map<string, unknown>();
  const outputsByTable = opts?.outputsByTable ?? {};

  const outputsFn = ((table: unknown) => outputsByTable[resolveTableName(table)] ?? []) as SmithersCtx<ScheduledOutputs>["outputs"];

  return {
    runId: "run-1",
    latest: (table: unknown, nodeId: string) => latestMap.get(`${resolveTableName(table)}|${nodeId}`) ?? null,
    iterationCount: (table: unknown, nodeId: string) => {
      const rows = outputsByTable[resolveTableName(table)] ?? [];
      return rows.filter((r: any) => r.nodeId === nodeId).length;
    },
    outputs: outputsFn,
  } as unknown as SmithersCtx<ScheduledOutputs>;
}

function createUnit(tier: WorkUnit["tier"] = "large"): WorkUnit {
  return {
    id: "u-review-loop",
    name: "Review loop unit",
    description: "desc",
    rfcSections: [],
    deps: [],
    acceptance: ["ac1"],
    tier,
  };
}

function createAgents(): ReviewLoopAgents {
  const a = {} as AgentLike;
  return {
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

function findLoop(node: React.ReactNode): React.ReactElement | null {
  if (!React.isValidElement(node)) return null;
  if (node.type === Ralph) return node;
  const props = node.props as { children?: React.ReactNode };
  const children = props.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const found = findLoop(child);
      if (found) return found;
    }
    return null;
  }
  if (children != null) return findLoop(children);
  return null;
}

function createLatestMap(entries: Array<[string, string, unknown]>) {
  const map = new Map(entries.map(([table, nodeId, value]) => [`${table}|${nodeId}`, value]));
  return map;
}

describe("ReviewLoop", () => {
  test("uses strict maxIterations equal to maxReviewPasses", () => {
    const unit = createUnit("large");
    const ctx = createCtx();

    const element = ReviewLoop({
      unit,
      ctx,
      outputs: scheduledOutputSchemas,
      agents: createAgents(),
      implOutput: null,
      testSuites: [],
      verifyCommands: [],
      maxReviewPasses: 3,
    });

    const ralph = findLoop(element);
    expect(ralph).not.toBeNull();
    expect((ralph?.props as Record<string, unknown>).maxIterations).toBe(3);
  });

  test("loop stays active when code_review.approved is false", () => {
    const unit = createUnit("large");
    const ctx = createCtx({
      latestMap: createLatestMap([
        ["code_review", stageNodeId(unit.id, "code-review"), { severity: "major", approved: false, issues: null, feedback: "blocked" }],
        ["prd_review", stageNodeId(unit.id, "prd-review"), { severity: "none", approved: true, issues: null, feedback: "ok" }],
      ]),
    });

    const element = ReviewLoop({
      unit,
      ctx,
      outputs: scheduledOutputSchemas,
      agents: createAgents(),
      implOutput: null,
      testSuites: [],
      verifyCommands: [],
      maxReviewPasses: 3,
    });

    const ralph = findLoop(element);
    expect((ralph?.props as Record<string, unknown>).until).toBe(false);
  });

  test("loop exits when code_review.approved is true", () => {
    const unit = createUnit("large");
    const ctx = createCtx({
      latestMap: createLatestMap([
        ["code_review", stageNodeId(unit.id, "code-review"), { severity: "minor", approved: true, issues: null, feedback: "ok" }],
        ["prd_review", stageNodeId(unit.id, "prd-review"), { severity: "none", approved: true, issues: null, feedback: "ok" }],
      ]),
    });

    const element = ReviewLoop({
      unit,
      ctx,
      outputs: scheduledOutputSchemas,
      agents: createAgents(),
      implOutput: null,
      testSuites: [],
      verifyCommands: [],
      maxReviewPasses: 3,
    });

    const ralph = findLoop(element);
    expect((ralph?.props as Record<string, unknown>).until).toBe(true);
  });

  test("review-fix is skipped when code_review.approved is true", () => {
    const unit = createUnit("large");
    const ctx = createCtx({
      latestMap: createLatestMap([
        ["code_review", stageNodeId(unit.id, "code-review"), { severity: "minor", approved: true, issues: null, feedback: "ok" }],
        ["prd_review", stageNodeId(unit.id, "prd-review"), { severity: "none", approved: true, issues: null, feedback: "ok" }],
      ]),
    });

    const element = ReviewLoop({
      unit,
      ctx,
      outputs: scheduledOutputSchemas,
      agents: createAgents(),
      implOutput: null,
      testSuites: [],
      verifyCommands: [],
      maxReviewPasses: 3,
    });

    const tasks = collectTasks(element);
    expect(tasks[stageNodeId(unit.id, "review-fix")].skipIf).toBe(true);
  });

  test("post-loop review_loop_result reflects passed state from approved reviews", () => {
    const unit = createUnit("large");
    const ctx = createCtx({
      latestMap: createLatestMap([
        ["code_review", stageNodeId(unit.id, "code-review"), { severity: "minor", approved: true, issues: null, feedback: "ok" }],
        ["prd_review", stageNodeId(unit.id, "prd-review"), { severity: "none", approved: true, issues: null, feedback: "ok" }],
      ]),
      outputsByTable: {
        code_review: [{ nodeId: stageNodeId(unit.id, "code-review") }],
      },
    });

    const element = ReviewLoop({
      unit,
      ctx,
      outputs: scheduledOutputSchemas,
      agents: createAgents(),
      implOutput: null,
      testSuites: [],
      verifyCommands: [],
      maxReviewPasses: 3,
    });

    const tasks = collectTasks(element);
    expect(tasks[`${unit.id}:review-loop`].children).toEqual({
      iterationCount: 1,
      codeSeverity: "minor",
      prdSeverity: "none",
      passed: true,
      exhausted: false,
    });
  });

  test("post-loop review_loop_result marks exhausted when code not approved", () => {
    const unit = createUnit("large");
    const ctx = createCtx({
      latestMap: createLatestMap([
        ["code_review", stageNodeId(unit.id, "code-review"), { severity: "major", approved: false, issues: null, feedback: "blocked" }],
        ["prd_review", stageNodeId(unit.id, "prd-review"), { severity: "none", approved: true, issues: null, feedback: "ok" }],
      ]),
      outputsByTable: {
        code_review: [
          { nodeId: stageNodeId(unit.id, "code-review") },
          { nodeId: stageNodeId(unit.id, "code-review") },
          { nodeId: stageNodeId(unit.id, "code-review") },
        ],
      },
    });

    const element = ReviewLoop({
      unit,
      ctx,
      outputs: scheduledOutputSchemas,
      agents: createAgents(),
      implOutput: null,
      testSuites: [],
      verifyCommands: [],
      maxReviewPasses: 3,
    });

    const tasks = collectTasks(element);
    expect(tasks[`${unit.id}:review-loop`].children).toEqual({
      iterationCount: 3,
      codeSeverity: "major",
      prdSeverity: "none",
      passed: false,
      exhausted: true,
    });
  });

  test("test task runs before the review loop (outside)", () => {
    const unit = createUnit("large");
    const ctx = createCtx();

    const element = ReviewLoop({
      unit,
      ctx,
      outputs: scheduledOutputSchemas,
      agents: createAgents(),
      implOutput: null,
      testSuites: [],
      verifyCommands: [],
      maxReviewPasses: 3,
    });

    // Collect the top-level Sequence children
    if (!React.isValidElement(element)) throw new Error("expected element");
    const seqChildren = ((element.props as Record<string, unknown>).children as React.ReactNode[])
      .filter(React.isValidElement) as React.ReactElement[];

    // Test task should be first child of the outer Sequence
    const firstChild = seqChildren[0];
    expect((firstChild.props as Record<string, unknown>).id).toBe(stageNodeId(unit.id, "test"));

    // The Loop should not contain the test task
    const tasks = collectTasks(element);
    const ralph = findLoop(element);
    if (!ralph) throw new Error("expected loop");
    const loopTasks = collectTasks(ralph);
    expect(loopTasks[stageNodeId(unit.id, "test")]).toBeUndefined();
  });

  test("prd_review runs before the review loop (outside)", () => {
    const unit = createUnit("large");
    const ctx = createCtx();

    const element = ReviewLoop({
      unit,
      ctx,
      outputs: scheduledOutputSchemas,
      agents: createAgents(),
      implOutput: null,
      testSuites: [],
      verifyCommands: [],
      maxReviewPasses: 3,
    });

    // The loop should not contain prd_review
    const ralph = findLoop(element);
    if (!ralph) throw new Error("expected loop");
    const loopTasks = collectTasks(ralph);
    expect(loopTasks[stageNodeId(unit.id, "prd-review")]).toBeUndefined();

    // But the overall tree should contain it
    const allTasks = collectTasks(element);
    expect(allTasks[stageNodeId(unit.id, "prd-review")]).toBeDefined();
  });

  test("writes backlog only when reviews passed and minor issues exist", () => {
    const unit = createUnit("large");
    const ctx = createCtx({
      latestMap: createLatestMap([
        [
          "code_review",
          stageNodeId(unit.id, "code-review"),
          {
            severity: "minor",
            approved: true,
            issues: [{ severity: "minor", description: "nit", file: "a.ts", suggestion: null, reference: null }],
            feedback: "ok",
          },
        ],
        ["prd_review", stageNodeId(unit.id, "prd-review"), { severity: "none", approved: true, issues: null, feedback: "ok" }],
      ]),
      outputsByTable: {
        code_review: [{ nodeId: stageNodeId(unit.id, "code-review") }],
      },
    });

    const element = ReviewLoop({
      unit,
      ctx,
      outputs: scheduledOutputSchemas,
      agents: createAgents(),
      implOutput: null,
      testSuites: [],
      verifyCommands: [],
      maxReviewPasses: 3,
    });

    const tasks = collectTasks(element);
    expect(tasks[`${unit.id}:review-backlog`].skipIf).toBe(false);
  });

  test("uses dedicated output for backlog task instead of review_loop_result", () => {
    const unit = createUnit("large");
    const ctx = createCtx();

    const element = ReviewLoop({
      unit,
      ctx,
      outputs: scheduledOutputSchemas,
      agents: createAgents(),
      implOutput: null,
      testSuites: [],
      verifyCommands: [],
      maxReviewPasses: 3,
    });

    const tasks = collectTasks(element);
    expect(tasks[`${unit.id}:review-backlog`].output).toBe(scheduledOutputSchemas.review_backlog);
  });

  test("backlog writer resolves path from explicit cwd context", async () => {
    const unit = createUnit("large");
    const ctx = createCtx({
      latestMap: createLatestMap([
        [
          "code_review",
          stageNodeId(unit.id, "code-review"),
          {
            severity: "minor",
            approved: true,
            issues: [{ severity: "minor", description: "nit", file: "a.ts", suggestion: null, reference: null }],
            feedback: "ok",
          },
        ],
        ["prd_review", stageNodeId(unit.id, "prd-review"), { severity: "none", approved: true, issues: null, feedback: "ok" }],
      ]),
      outputsByTable: {
        code_review: [{ nodeId: stageNodeId(unit.id, "code-review") }],
      },
    });

    const element = ReviewLoop({
      unit,
      ctx,
      outputs: scheduledOutputSchemas,
      agents: createAgents(),
      implOutput: null,
      testSuites: [],
      verifyCommands: [],
      maxReviewPasses: 3,
    });

    const tasks = collectTasks(element);
    const backlogWriter = tasks[`${unit.id}:review-backlog`].children as (() => Promise<{
      backlogPath: string;
      wroteBacklog: boolean;
      iterationCount: number;
      codeMinorIssueCount: number;
      prdMinorIssueCount: number;
    }>);

    const originalCwd = process.cwd();
    const tempRoot = await mkdtemp(join(tmpdir(), "review-loop-test-"));
    try {
      process.chdir(tempRoot);
      const result = await backlogWriter();
      expect(isAbsolute(result.backlogPath)).toBe(true);
      expect(result.backlogPath.endsWith(join("docs", "review-backlog", `${unit.id}.md`))).toBe(true);
      const content = await readFile(result.backlogPath, "utf8");
      expect(content).toContain("# Minor issues - Review loop unit");
    } finally {
      process.chdir(originalCwd);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
