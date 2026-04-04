import { describe, expect, test } from "bun:test";
import type { SmithersCtx } from "smithers-orchestrator";
import type { WorkUnit } from "../../types";
import type { ScheduledOutputs } from "../../components/QualityPipeline";
import type { z } from "zod";
import { scheduledOutputSchemas } from "../../schemas";
import { resolveTableName } from "../../__tests__/testUtils";
import {
  buildDepSummaries,
  buildMergeTickets,
  getEvictionContext,
  getUnitState,
  isUnitEvicted,
  isUnitLanded,
  shouldRunPipeline,
} from "../state";
import { reviewLoopNodeId, stageNodeId } from "../contracts";

type MergeQueueRow = z.infer<typeof scheduledOutputSchemas.merge_queue>;

function unit(id: string, deps: string[] = []): WorkUnit {
  return {
    id,
    name: id,
    rfcSections: [],
    description: "",
    deps,
    acceptance: [],
    tier: "small",
  };
}

function createCtx(opts?: {
  mergeQueueRows?: MergeQueueRow[];
  latestMap?: Map<string, unknown>;
}): SmithersCtx<ScheduledOutputs> {
  const mergeQueueRows = opts?.mergeQueueRows ?? [];
  const latestMap = opts?.latestMap ?? new Map<string, unknown>();

  const outputsFn = ((table: unknown) => {
    const name = resolveTableName(table);
    if (name === "merge_queue") return mergeQueueRows;
    return [];
  }) as SmithersCtx<ScheduledOutputs>["outputs"];

  return {
    runId: "run-1",
    iteration: 0,
    latest: (table: unknown, nodeId: string) => latestMap.get(`${resolveTableName(table)}|${nodeId}`) ?? null,
    outputs: outputsFn,
  } as unknown as SmithersCtx<ScheduledOutputs>;
}

function mqRow(overrides: Partial<MergeQueueRow> & Pick<MergeQueueRow, "ticketsLanded" | "ticketsEvicted">): MergeQueueRow {
  return {
    ticketsSkipped: [],
    summary: "",
    nextActions: null,
    ...overrides,
  };
}

function reviewLoopResult(iterationCount: number, passed = true) {
  return {
    iterationCount,
    codeSeverity: "none" as const,
    prdSeverity: "none" as const,
    passed,
    exhausted: false,
  };
}

describe("isUnitLanded", () => {
  test("returns true when merge queue has landed ticket", () => {
    const ctx = createCtx({
      mergeQueueRows: [mqRow({
        ticketsLanded: [{ ticketId: "u1", mergeCommit: "abc", summary: "ok", reviewLoopIterationCount: 1, testIteration: 1 }],
        ticketsEvicted: [],
      })],
    });

    expect(isUnitLanded(ctx, "u1")).toBe(true);
  });

  test("returns false when no landed entry exists", () => {
    const ctx = createCtx();
    expect(isUnitLanded(ctx, "u1")).toBe(false);
  });
});

describe("isUnitEvicted", () => {
  test("returns true when evicted and not landed", () => {
    const ctx = createCtx({
      mergeQueueRows: [mqRow({
        ticketsLanded: [],
        ticketsEvicted: [{ ticketId: "u1", reason: "conflict", details: "x" }],
      })],
    });

    expect(isUnitEvicted(ctx, "u1")).toBe(true);
  });

  test("returns false when both landed and evicted", () => {
    const ctx = createCtx({
      mergeQueueRows: [
        mqRow({
          ticketsLanded: [{ ticketId: "u1", mergeCommit: "abc", summary: "ok", reviewLoopIterationCount: 1, testIteration: 1 }],
          ticketsEvicted: [],
        }),
        mqRow({
          ticketsLanded: [],
          ticketsEvicted: [{ ticketId: "u1", reason: "conflict", details: "x" }],
        }),
      ],
    });

    expect(isUnitEvicted(ctx, "u1")).toBe(false);
  });
});

describe("getEvictionContext", () => {
  test("returns latest eviction details", () => {
    const ctx = createCtx({
      mergeQueueRows: [
        mqRow({
          ticketsLanded: [],
          ticketsEvicted: [{ ticketId: "u1", reason: "old", details: "old details" }],
        }),
        mqRow({
          ticketsLanded: [],
          ticketsEvicted: [{ ticketId: "u1", reason: "new", details: "new details" }],
        }),
      ],
    });

    expect(getEvictionContext(ctx, "u1")).toBe("new details");
  });

  test("returns null for landed units", () => {
    const ctx = createCtx({
      mergeQueueRows: [mqRow({
        ticketsLanded: [{ ticketId: "u1", mergeCommit: "abc", summary: "ok", reviewLoopIterationCount: 1, testIteration: 1 }],
        ticketsEvicted: [{ ticketId: "u1", reason: "conflict", details: "x" }],
      })],
    });

    expect(getEvictionContext(ctx, "u1")).toBeNull();
  });
});

describe("getUnitState", () => {
  test("returns done for landed unit", () => {
    const ctx = createCtx({
      mergeQueueRows: [mqRow({
        ticketsLanded: [{ ticketId: "u1", mergeCommit: "abc", summary: "ok", reviewLoopIterationCount: 1, testIteration: 1 }],
        ticketsEvicted: [],
      })],
    });

    expect(getUnitState(ctx, [unit("u1")], "u1")).toBe("done");
  });

  test("returns not-ready when a dependency is not landed", () => {
    const ctx = createCtx();
    expect(getUnitState(ctx, [unit("dep"), unit("u1", ["dep"])], "u1")).toBe("not-ready");
  });

  test("returns active when dependencies are satisfied and not landed", () => {
    const ctx = createCtx({
      mergeQueueRows: [mqRow({
        ticketsLanded: [{ ticketId: "dep", mergeCommit: "abc", summary: "ok", reviewLoopIterationCount: 1, testIteration: 1 }],
        ticketsEvicted: [],
      })],
    });

    expect(getUnitState(ctx, [unit("dep"), unit("u1", ["dep"])], "u1")).toBe("active");
  });
});

describe("shouldRunPipeline", () => {
  test("returns false for landed unit", () => {
    const ctx = createCtx({
      mergeQueueRows: [mqRow({
        ticketsLanded: [{ ticketId: "u1", mergeCommit: "abc", summary: "ok", reviewLoopIterationCount: 1, testIteration: 1 }],
        ticketsEvicted: [],
      })],
    });
    expect(shouldRunPipeline(ctx, unit("u1"), [unit("u1")])).toBe(false);
  });

  test("returns false for not-ready unit", () => {
    const ctx = createCtx();
    expect(shouldRunPipeline(ctx, unit("u1", ["dep"]), [unit("dep"), unit("u1", ["dep"])])).toBe(false);
  });

  test("returns true for active unit without passing review", () => {
    const ctx = createCtx();
    expect(shouldRunPipeline(ctx, unit("u1"), [unit("u1")])).toBe(true);
  });

  test("returns false for active unit with passing review and no eviction", () => {
    const latestMap = new Map<string, unknown>();
    latestMap.set(`review_loop_result|${reviewLoopNodeId("u1")}`, { passed: true });
    const ctx = createCtx({ latestMap });
    expect(shouldRunPipeline(ctx, unit("u1"), [unit("u1")])).toBe(false);
  });

  test("returns true for evicted unit with passing review (needs re-run)", () => {
    const latestMap = new Map<string, unknown>();
    latestMap.set(`review_loop_result|${reviewLoopNodeId("u1")}`, { passed: true });
    const ctx = createCtx({
      mergeQueueRows: [mqRow({
        ticketsLanded: [],
        ticketsEvicted: [{ ticketId: "u1", reason: "conflict", details: "needs rebase" }],
      })],
      latestMap,
    });
    expect(shouldRunPipeline(ctx, unit("u1"), [unit("u1")])).toBe(true);
  });
});

describe("buildDepSummaries", () => {
  test("returns summaries from dependency implement outputs", () => {
    const latestMap = new Map<string, unknown>();
    latestMap.set(`implement|${stageNodeId("dep", "implement")}`, {
      whatWasDone: "did work",
      filesCreated: ["a.ts"],
      filesModified: ["b.ts"],
      believesComplete: true,
    });
    const ctx = createCtx({ latestMap });

    expect(buildDepSummaries(ctx, unit("u1", ["dep"]))).toEqual([
      {
        id: "dep",
        whatWasDone: "did work",
        filesCreated: ["a.ts"],
        filesModified: ["b.ts"],
      },
    ]);
  });
});

describe("buildMergeTickets", () => {
  test("includes active units with passed review loop and latest implement outputs", () => {
    const units = [unit("u1")];
    const latestMap = new Map<string, unknown>();
    latestMap.set(`test|${stageNodeId("u1", "test")}`, { testsPassed: true, buildPassed: true });
    latestMap.set(`review_loop_result|${reviewLoopNodeId("u1")}`, reviewLoopResult(2, true));
    latestMap.set(`implement|${stageNodeId("u1", "implement")}`, {
      whatWasDone: "done",
      filesCreated: ["created.ts"],
      filesModified: ["modified.ts"],
      believesComplete: true,
    });
    const ctx = createCtx({ latestMap });

    expect(buildMergeTickets(ctx, units, "run-1")).toEqual([
      {
        ticketId: "u1",
        ticketTitle: "u1",
        ticketCategory: "small",
        priority: "medium",
        reportComplete: true,
        landed: false,
        filesModified: ["modified.ts"],
        filesCreated: ["created.ts"],
        worktreePath: "/tmp/workflow-wt-run-1-u1",
        eligibilityProof: {
          reviewLoopIterationCount: 2,
          testIteration: null,
        },
      },
    ]);
  });

  test("excludes landed units", () => {
    const units = [unit("u1")];
    const latestMap = new Map<string, unknown>();
    latestMap.set(`test|${stageNodeId("u1", "test")}`, { testsPassed: true, buildPassed: true });
    latestMap.set(`review_loop_result|${reviewLoopNodeId("u1")}`, reviewLoopResult(1, true));
    const ctx = createCtx({
      mergeQueueRows: [mqRow({
        ticketsLanded: [{ ticketId: "u1", mergeCommit: "abc", summary: "ok", reviewLoopIterationCount: 1, testIteration: 1 }],
        ticketsEvicted: [],
      })],
      latestMap,
    });

    expect(buildMergeTickets(ctx, units, "run-1")).toEqual([]);
  });

  test("excludes not-ready units with unmet dependencies", () => {
    const units = [unit("u1", ["dep"])];
    const latestMap = new Map<string, unknown>();
    latestMap.set(`test|${stageNodeId("u1", "test")}`, { testsPassed: true, buildPassed: true });
    latestMap.set(`review_loop_result|${reviewLoopNodeId("u1")}`, reviewLoopResult(1, true));
    const ctx = createCtx({ latestMap });

    expect(buildMergeTickets(ctx, units, "run-1")).toEqual([]);
  });

  test("excludes units without a passing review loop result", () => {
    const units = [unit("u1")];
    const latestMap = new Map<string, unknown>();
    latestMap.set(`test|${stageNodeId("u1", "test")}`, { testsPassed: true, buildPassed: true });
    latestMap.set(`review_loop_result|${reviewLoopNodeId("u1")}`, reviewLoopResult(1, false));
    const ctx = createCtx({ latestMap });

    expect(buildMergeTickets(ctx, units, "run-1")).toEqual([]);
  });

  test("excludes evicted units when latest test fails", () => {
    const units = [unit("u1")];
    const latestMap = new Map<string, unknown>();
    latestMap.set(`test|${stageNodeId("u1", "test")}`, { testsPassed: false, buildPassed: true });
    latestMap.set(`review_loop_result|${reviewLoopNodeId("u1")}`, reviewLoopResult(3, true));
    const ctx = createCtx({
      mergeQueueRows: [mqRow({
        ticketsLanded: [],
        ticketsEvicted: [{ ticketId: "u1", reason: "conflict", details: "needs rebase" }],
      })],
      latestMap,
    });

    expect(buildMergeTickets(ctx, units, "run-1")).toEqual([]);
  });

  test("for evicted units with build failure, keeps eligibility when review loop passed", () => {
    const units = [unit("u1")];
    const latestMap = new Map<string, unknown>();
    latestMap.set(`test|${stageNodeId("u1", "test")}`, { testsPassed: true, buildPassed: false });
    latestMap.set(`review_loop_result|${reviewLoopNodeId("u1")}`, reviewLoopResult(3, true));
    latestMap.set(`implement|${stageNodeId("u1", "implement")}`, {
      whatWasDone: "done",
      filesCreated: [],
      filesModified: [],
      believesComplete: true,
    });
    const ctx = createCtx({
      mergeQueueRows: [mqRow({
        ticketsLanded: [],
        ticketsEvicted: [{ ticketId: "u1", reason: "conflict", details: "needs rebase" }],
      })],
      latestMap,
    });

    expect(buildMergeTickets(ctx, units, "run-1").map((t) => t.ticketId)).toEqual(["u1"]);
  });
});
