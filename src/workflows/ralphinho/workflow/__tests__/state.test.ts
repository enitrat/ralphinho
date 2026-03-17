import { describe, expect, test } from "bun:test";
import type { WorkUnit } from "../../types";
import {
  buildDepSummaries,
  buildMergeTickets,
  getEvictionContext,
  getUnitState,
  isUnitEvicted,
  type OutputSnapshot,
  type ReviewLoopResult,
} from "../state";

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

function reviewLoopResult(iteration: number, overrides: Partial<ReviewLoopResult> = {}): ReviewLoopResult {
  return {
    nodeId: "u1:review-loop",
    iteration,
    passed: true,
    summary: "ok",
    ...overrides,
  };
}

function snapshot(overrides: Partial<OutputSnapshot> = {}): OutputSnapshot {
  const rows = overrides.mergeQueueRows ?? [];
  return {
    mergeQueueRows: rows,
    latestTest: () => null,
    latestReviewLoopResult: () => null,
    latestImplement: () => null,
    freshTest: () => null,
    testHistory: () => [],
    implementHistory: () => [],
    reviewFixHistory: () => [],
    isUnitLanded: (unitId) =>
      rows.some((row) => row.nodeId === "merge-queue"
        && row.ticketsLanded.some((ticket) => ticket.ticketId === unitId)),
    ...overrides,
  };
}

describe("isUnitLanded", () => {
  test("returns true when merge queue has landed ticket", () => {
    const s = snapshot({
      mergeQueueRows: [{
        nodeId: "merge-queue",
        ticketsLanded: [{ ticketId: "u1", mergeCommit: "abc", summary: "ok", reviewLoopIteration: 1, testIteration: 1 }],
        ticketsEvicted: [],
      }],
    });

    expect(s.isUnitLanded("u1")).toBe(true);
  });

  test("returns false when no landed entry exists", () => {
    const s = snapshot();
    expect(s.isUnitLanded("u1")).toBe(false);
  });
});

describe("isUnitEvicted", () => {
  test("returns true when evicted and not landed", () => {
    const s = snapshot({
      mergeQueueRows: [{
        nodeId: "merge-queue",
        ticketsLanded: [],
        ticketsEvicted: [{ ticketId: "u1", reason: "conflict", details: "x" }],
      }],
    });

    expect(isUnitEvicted(s, "u1")).toBe(true);
  });

  test("returns false when both landed and evicted", () => {
    const s = snapshot({
      mergeQueueRows: [
        {
          nodeId: "merge-queue",
          ticketsLanded: [{ ticketId: "u1", mergeCommit: "abc", summary: "ok", reviewLoopIteration: 1, testIteration: 1 }],
          ticketsEvicted: [],
        },
        {
          nodeId: "merge-queue",
          ticketsLanded: [],
          ticketsEvicted: [{ ticketId: "u1", reason: "conflict", details: "x" }],
        },
      ],
    });

    expect(isUnitEvicted(s, "u1")).toBe(false);
  });
});

describe("getEvictionContext", () => {
  test("returns latest eviction details", () => {
    const s = snapshot({
      mergeQueueRows: [
        {
          nodeId: "merge-queue",
          ticketsLanded: [],
          ticketsEvicted: [{ ticketId: "u1", reason: "old", details: "old details" }],
        },
        {
          nodeId: "merge-queue",
          ticketsLanded: [],
          ticketsEvicted: [{ ticketId: "u1", reason: "new", details: "new details" }],
        },
      ],
    });

    expect(getEvictionContext(s, "u1")).toBe("new details");
  });

  test("returns null for landed units", () => {
    const s = snapshot({
      mergeQueueRows: [{
        nodeId: "merge-queue",
        ticketsLanded: [{ ticketId: "u1", mergeCommit: "abc", summary: "ok", reviewLoopIteration: 1, testIteration: 1 }],
        ticketsEvicted: [{ ticketId: "u1", reason: "conflict", details: "x" }],
      }],
    });

    expect(getEvictionContext(s, "u1")).toBeNull();
  });
});

describe("getUnitState", () => {
  test("returns done for landed unit", () => {
    const s = snapshot({
      mergeQueueRows: [{
        nodeId: "merge-queue",
        ticketsLanded: [{ ticketId: "u1", mergeCommit: "abc", summary: "ok", reviewLoopIteration: 1, testIteration: 1 }],
        ticketsEvicted: [],
      }],
    });

    expect(getUnitState(s, [unit("u1")], "u1")).toBe("done");
  });

  test("returns not-ready when a dependency is not landed", () => {
    const s = snapshot();
    expect(getUnitState(s, [unit("dep"), unit("u1", ["dep"])], "u1")).toBe("not-ready");
  });

  test("returns active when dependencies are satisfied and not landed", () => {
    const s = snapshot({
      mergeQueueRows: [{
        nodeId: "merge-queue",
        ticketsLanded: [{ ticketId: "dep", mergeCommit: "abc", summary: "ok", reviewLoopIteration: 1, testIteration: 1 }],
        ticketsEvicted: [],
      }],
    });

    expect(getUnitState(s, [unit("dep"), unit("u1", ["dep"])], "u1")).toBe("active");
  });
});

describe("buildDepSummaries", () => {
  test("returns summaries from dependency implement outputs", () => {
    const s = snapshot({
      latestImplement: (unitId) => {
        if (unitId === "dep") {
          return {
            nodeId: "dep:implement",
            iteration: 1,
            whatWasDone: "did work",
            filesCreated: ["a.ts"],
            filesModified: ["b.ts"],
            believesComplete: true,
          };
        }
        return null;
      },
    });

    expect(buildDepSummaries(s, unit("u1", ["dep"]))).toEqual([
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
  test("includes active, review-loop-passed units with latest implement outputs", () => {
    const units = [unit("u1")];
    const s = snapshot({
      latestTest: () => ({ nodeId: "u1:test", iteration: 2, testsPassed: true, buildPassed: true }),
      testHistory: () => [{ nodeId: "u1:test", iteration: 2, testsPassed: true, buildPassed: true }],
      latestReviewLoopResult: () => reviewLoopResult(2),
      latestImplement: () => ({
        nodeId: "u1:implement",
        iteration: 2,
        whatWasDone: "done",
        filesCreated: ["created.ts"],
        filesModified: ["modified.ts"],
        believesComplete: true,
      }),
      implementHistory: () => [{
        nodeId: "u1:implement",
        iteration: 2,
        whatWasDone: "done",
        filesCreated: ["created.ts"],
        filesModified: ["modified.ts"],
        believesComplete: true,
      }],
    });

    expect(buildMergeTickets(s, units, "run-1", 2)).toEqual([
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
          reviewLoopIteration: 2,
          testIteration: 2,
        },
      },
    ]);
  });

  test("excludes landed units", () => {
    const units = [unit("u1")];
    const s = snapshot({
      mergeQueueRows: [{
        nodeId: "merge-queue",
        ticketsLanded: [{ ticketId: "u1", mergeCommit: "abc", summary: "ok", reviewLoopIteration: 1, testIteration: 1 }],
        ticketsEvicted: [],
      }],
      latestTest: () => ({ nodeId: "u1:test", iteration: 1, testsPassed: true, buildPassed: true }),
      latestReviewLoopResult: () => reviewLoopResult(1),
    });

    expect(buildMergeTickets(s, units, "run-1", 1)).toEqual([]);
  });

  test("excludes not-ready units with unmet dependencies", () => {
    const units = [unit("u1", ["dep"])];
    const s = snapshot({
      latestTest: () => ({ nodeId: "u1:test", iteration: 1, testsPassed: true, buildPassed: true }),
      latestReviewLoopResult: () => reviewLoopResult(1),
    });

    expect(buildMergeTickets(s, units, "run-1", 1)).toEqual([]);
  });

  test("excludes units that do not pass review loop", () => {
    const units = [unit("u1")];
    const s = snapshot({
      latestTest: () => ({ nodeId: "u1:test", iteration: 1, testsPassed: true, buildPassed: true }),
      latestReviewLoopResult: () => reviewLoopResult(1, { passed: false, summary: "fail" }),
    });

    expect(buildMergeTickets(s, units, "run-1", 1)).toEqual([]);
  });

  test("requires fresh passing tests for evicted units", () => {
    const units = [unit("u1")];
    const s = snapshot({
      mergeQueueRows: [{
        nodeId: "merge-queue",
        ticketsLanded: [],
        ticketsEvicted: [{ ticketId: "u1", reason: "conflict", details: "needs rebase" }],
      }],
      latestTest: () => ({ nodeId: "u1:test", iteration: 3, testsPassed: true, buildPassed: true }),
      latestReviewLoopResult: () => reviewLoopResult(3),
      freshTest: () => ({ nodeId: "u1:test", iteration: 3, testsPassed: false, buildPassed: true }),
    });

    expect(buildMergeTickets(s, units, "run-1", 3)).toEqual([]);
  });

  test("for evicted units with fresh build failure, requires review-loop pass", () => {
    const units = [unit("u1")];
    const base = snapshot({
      mergeQueueRows: [{
        nodeId: "merge-queue",
        ticketsLanded: [],
        ticketsEvicted: [{ ticketId: "u1", reason: "conflict", details: "needs rebase" }],
      }],
      latestTest: () => ({ nodeId: "u1:test", iteration: 3, testsPassed: true, buildPassed: true }),
      freshTest: () => ({ nodeId: "u1:test", iteration: 3, testsPassed: true, buildPassed: false }),
      latestImplement: () => ({
        nodeId: "u1:implement",
        iteration: 3,
        whatWasDone: "done",
        filesCreated: [],
        filesModified: [],
        believesComplete: true,
      }),
      implementHistory: () => [{
        nodeId: "u1:implement",
        iteration: 3,
        whatWasDone: "done",
        filesCreated: [],
        filesModified: [],
        believesComplete: true,
      }],
    });

    const notPassed = {
      ...base,
      latestReviewLoopResult: () => reviewLoopResult(3, { passed: false }),
    };
    expect(buildMergeTickets(notPassed, units, "run-1", 3)).toEqual([]);

    const passed = {
      ...base,
      latestReviewLoopResult: () => reviewLoopResult(3, { passed: true }),
    };
    expect(buildMergeTickets(passed, units, "run-1", 3).map((t) => t.ticketId)).toEqual(["u1"]);
  });
});
