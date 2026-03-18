import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import React from "react";
import { Ralph } from "smithers-orchestrator";
import type { AgentLike, SmithersCtx } from "smithers-orchestrator";
import { scheduledOutputSchemas } from "../../schemas";
import type { WorkUnit } from "../../types";
import type { ScheduledOutputs } from "../QualityPipeline";
import { ReviewLoop, type ReviewLoopAgents } from "../ReviewLoop";

function createCtx(latestImpl: (table: string, nodeId: string) => unknown): SmithersCtx<ScheduledOutputs> {
  return {
    runId: "run-1",
    latest: latestImpl,
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

function findRalph(node: React.ReactNode): React.ReactElement | null {
  if (!React.isValidElement(node)) return null;
  if (node.type === Ralph) return node;
  const props = node.props as { children?: React.ReactNode };
  const children = props.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const found = findRalph(child);
      if (found) return found;
    }
    return null;
  }
  if (children != null) return findRalph(children);
  return null;
}

function createLatestMap(entries: Array<[string, string, unknown]>) {
  const map = new Map(entries.map(([table, nodeId, value]) => [`${table}|${nodeId}`, value]));
  return (table: string, nodeId: string) => map.get(`${table}|${nodeId}`) ?? null;
}

describe("ReviewLoop", () => {
  test("uses strict maxIterations equal to maxReviewPasses", () => {
    const unit = createUnit("large");
    const ctx = createCtx(createLatestMap([]));

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

    const ralph = findRalph(element);
    expect(ralph).not.toBeNull();
    expect((ralph?.props as Record<string, unknown>).maxIterations).toBe(3);
  });

  test("keeps loop active until a clean review result is persisted", () => {
    const unit = createUnit("large");
    const ctx = createCtx(createLatestMap([
      ["code_review", `${unit.id}:code-review`, { severity: "minor", issues: null, feedback: "ok" }],
      ["prd_review", `${unit.id}:prd-review`, { severity: "none", issues: null, feedback: "ok" }],
      ["review_loop_result", `${unit.id}:review-loop`, { iterationCount: 1 }],
    ]));

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
    expect(tasks[`${unit.id}:review-fix`].skipIf).toBe(true);
    expect(tasks[`${unit.id}:review-loop`].children).toEqual({
      iterationCount: 2,
      codeSeverity: "minor",
      prdSeverity: "none",
      passed: true,
      exhausted: false,
    });

    const ralph = findRalph(element);
    expect((ralph?.props as Record<string, unknown>).until).toBe(false);
  });

  test("exits loop when a passing review result was already persisted", () => {
    const unit = createUnit("large");
    const ctx = createCtx(createLatestMap([
      ["code_review", `${unit.id}:code-review`, { severity: "minor", issues: null, feedback: "ok" }],
      ["prd_review", `${unit.id}:prd-review`, { severity: "none", issues: null, feedback: "ok" }],
      ["review_loop_result", `${unit.id}:review-loop`, { iterationCount: 1, passed: true, exhausted: false }],
    ]));

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

    const ralph = findRalph(element);
    expect((ralph?.props as Record<string, unknown>).until).toBe(true);
  });

  test("exits loop when an exhausted review result was already persisted", () => {
    const unit = createUnit("large");
    const ctx = createCtx(createLatestMap([
      ["code_review", `${unit.id}:code-review`, { severity: "major", issues: null, feedback: "blocked" }],
      ["prd_review", `${unit.id}:prd-review`, { severity: "none", issues: null, feedback: "ok" }],
      ["review_loop_result", `${unit.id}:review-loop`, { iterationCount: 3, passed: false, exhausted: true }],
    ]));

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

    const ralph = findRalph(element);
    expect((ralph?.props as Record<string, unknown>).until).toBe(true);
  });

  test("increments review-loop counter task output with latest severities", () => {
    const unit = createUnit("large");
    const ctx = createCtx(createLatestMap([
      ["code_review", `${unit.id}:code-review`, { severity: "major", issues: null, feedback: "blocked" }],
      ["prd_review", `${unit.id}:prd-review`, { severity: "minor", issues: null, feedback: "ok" }],
      ["review_loop_result", `${unit.id}:review-loop`, { iterationCount: 1 }],
    ]));

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
      iterationCount: 2,
      codeSeverity: "major",
      prdSeverity: "minor",
      passed: false,
      exhausted: false,
    });
  });

  test("writes backlog only when loop has passed and minor issues exist", () => {
    const unit = createUnit("large");
    const ctx = createCtx(createLatestMap([
      [
        "code_review",
        `${unit.id}:code-review`,
        {
          severity: "minor",
          issues: [{ severity: "minor", description: "nit", file: "a.ts", suggestion: null, reference: null }],
          feedback: "ok",
        },
      ],
      ["prd_review", `${unit.id}:prd-review`, { severity: "none", issues: null, feedback: "ok" }],
      ["review_loop_result", `${unit.id}:review-loop`, { iterationCount: 1 }],
    ]));

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
    const ctx = createCtx(createLatestMap([]));

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
    const ctx = createCtx(createLatestMap([
      [
        "code_review",
        `${unit.id}:code-review`,
        {
          severity: "minor",
          issues: [{ severity: "minor", description: "nit", file: "a.ts", suggestion: null, reference: null }],
          feedback: "ok",
        },
      ],
      ["prd_review", `${unit.id}:prd-review`, { severity: "none", issues: null, feedback: "ok" }],
      ["review_loop_result", `${unit.id}:review-loop`, { iterationCount: 1 }],
    ]));

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
