import { describe, expect, test } from "bun:test";
import type { WorkUnit } from "../../types";
import {
  buildDepSummaries,
  buildMergeTickets,
  getEvictionContext,
  getUnitState,
  isUnitEvicted,
  type FinalReviewRow,
  type OutputSnapshot,
} from "../state";
import { getDecisionAudit, isMergeEligible } from "../decisions";

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

function snapshot(overrides: Partial<OutputSnapshot> = {}): OutputSnapshot {
  const rows = overrides.mergeQueueRows ?? [];
  return {
    mergeQueueRows: rows,
    latestTest: () => null,
    latestFinalReview: () => null,
    latestImplement: () => null,
    freshTest: () => null,
    testHistory: () => [],
    finalReviewHistory: () => [],
    implementHistory: () => [],
    reviewFixHistory: () => [],
    isUnitLanded: (unitId) =>
      rows.some((row) => row.nodeId === "merge-queue"
        && row.ticketsLanded.some((ticket) => ticket.ticketId === unitId)),
    ...overrides,
  };
}

function finalReview(
  iteration: number,
  overrides: Partial<FinalReviewRow> = {},
): FinalReviewRow {
  return {
    nodeId: "u1:final-review",
    iteration,
    readyToMoveOn: false,
    approved: false,
    reasoning: "needs work",
    qualityScore: 0,
    ...overrides,
  };
}

describe("isUnitLanded", () => {
  test("returns true when merge queue has landed ticket", () => {
    const s = snapshot({
      mergeQueueRows: [{
        nodeId: "merge-queue",
        ticketsLanded: [{ ticketId: "u1", mergeCommit: "abc", summary: "ok", decisionIteration: 1, testIteration: 1, approvalSupersededRejection: false }],
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
          ticketsLanded: [{ ticketId: "u1", mergeCommit: "abc", summary: "ok", decisionIteration: 1, testIteration: 1, approvalSupersededRejection: false }],
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
        ticketsLanded: [{ ticketId: "u1", mergeCommit: "abc", summary: "ok", decisionIteration: 1, testIteration: 1, approvalSupersededRejection: false }],
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
        ticketsLanded: [{ ticketId: "u1", mergeCommit: "abc", summary: "ok", decisionIteration: 1, testIteration: 1, approvalSupersededRejection: false }],
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
        ticketsLanded: [{ ticketId: "dep", mergeCommit: "abc", summary: "ok", decisionIteration: 1, testIteration: 1, approvalSupersededRejection: false }],
        ticketsEvicted: [],
      }],
    });

    expect(getUnitState(s, [unit("dep"), unit("u1", ["dep"])], "u1")).toBe("active");
  });
});

describe("isMergeEligible", () => {
  test("returns false when testsPassed is false", () => {
    const s = snapshot({
      latestTest: () => ({ nodeId: "u1:test", iteration: 1, testsPassed: false, buildPassed: true }),
      latestFinalReview: () => finalReview(1, { readyToMoveOn: true, approved: true, reasoning: "ok" }),
      finalReviewHistory: () => [finalReview(1, { readyToMoveOn: true, approved: true, reasoning: "ok" })],
    });

    expect(isMergeEligible(s, "u1")).toBe(false);
  });

  test("returns false when tests pass but final review is not ready", () => {
    const s = snapshot({
      latestTest: () => ({ nodeId: "u1:test", iteration: 1, testsPassed: true, buildPassed: false }),
      latestFinalReview: () => finalReview(1),
      finalReviewHistory: () => [finalReview(1)],
    });

    expect(isMergeEligible(s, "u1")).toBe(false);
  });

  test("returns true only when tests pass and final review is ready", () => {
    const s = snapshot({
      latestTest: () => ({ nodeId: "u1:test", iteration: 2, testsPassed: true, buildPassed: false }),
      testHistory: () => [{ nodeId: "u1:test", iteration: 2, testsPassed: true, buildPassed: false }],
      latestFinalReview: () => finalReview(2, { readyToMoveOn: true, approved: true, reasoning: "ok" }),
      finalReviewHistory: () => [finalReview(2, { readyToMoveOn: true, approved: true, reasoning: "ok" })],
    });

    expect(isMergeEligible(s, "u1")).toBe(true);
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
  test("includes active, tier-complete units with latest implement outputs", () => {
    const units = [unit("u1")];
    const s = snapshot({
      latestTest: () => ({ nodeId: "u1:test", iteration: 2, testsPassed: true, buildPassed: true }),
      testHistory: () => [{ nodeId: "u1:test", iteration: 2, testsPassed: true, buildPassed: true }],
      latestFinalReview: () => finalReview(2, { readyToMoveOn: true, approved: true, reasoning: "ok" }),
      finalReviewHistory: () => [finalReview(2, { readyToMoveOn: true, approved: true, reasoning: "ok" })],
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
          decisionIteration: 2,
          testIteration: 2,
          approvalSupersededRejection: false,
        },
      },
    ]);
  });

  test("excludes landed units", () => {
    const units = [unit("u1")];
    const s = snapshot({
      mergeQueueRows: [{
        nodeId: "merge-queue",
        ticketsLanded: [{ ticketId: "u1", mergeCommit: "abc", summary: "ok", decisionIteration: 1, testIteration: 1, approvalSupersededRejection: false }],
        ticketsEvicted: [],
      }],
      latestTest: () => ({ nodeId: "u1:test", iteration: 1, testsPassed: true, buildPassed: true }),
      testHistory: () => [{ nodeId: "u1:test", iteration: 1, testsPassed: true, buildPassed: true }],
      latestFinalReview: () => finalReview(1, { readyToMoveOn: true, approved: true, reasoning: "ok" }),
      finalReviewHistory: () => [finalReview(1, { readyToMoveOn: true, approved: true, reasoning: "ok" })],
    });

    expect(buildMergeTickets(s, units, "run-1", 1)).toEqual([]);
  });

  test("excludes not-ready units with unmet dependencies", () => {
    const units = [unit("u1", ["dep"])];
    const s = snapshot({
      latestTest: () => ({ nodeId: "u1:test", iteration: 1, testsPassed: true, buildPassed: true }),
      testHistory: () => [{ nodeId: "u1:test", iteration: 1, testsPassed: true, buildPassed: true }],
      latestFinalReview: () => finalReview(1, { readyToMoveOn: true, approved: true, reasoning: "ok" }),
      finalReviewHistory: () => [finalReview(1, { readyToMoveOn: true, approved: true, reasoning: "ok" })],
    });

    expect(buildMergeTickets(s, units, "run-1", 1)).toEqual([]);
  });

  test("excludes units that are not tier complete", () => {
    const units = [unit("u1")];
    const s = snapshot({
      latestTest: () => ({ nodeId: "u1:test", iteration: 1, testsPassed: true, buildPassed: true }),
      testHistory: () => [{ nodeId: "u1:test", iteration: 1, testsPassed: true, buildPassed: true }],
      latestFinalReview: () => finalReview(1),
      finalReviewHistory: () => [finalReview(1)],
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
      testHistory: () => [{ nodeId: "u1:test", iteration: 3, testsPassed: true, buildPassed: true }],
      latestFinalReview: () => finalReview(3, { readyToMoveOn: true, approved: true, reasoning: "ok" }),
      finalReviewHistory: () => [finalReview(3, { readyToMoveOn: true, approved: true, reasoning: "ok" })],
      freshTest: () => ({ nodeId: "u1:test", iteration: 3, testsPassed: false, buildPassed: true }),
    });

    expect(buildMergeTickets(s, units, "run-1", 3)).toEqual([]);
  });

  test("for evicted units with fresh build failure, requires final review ready", () => {
    const units = [unit("u1")];
    const base = snapshot({
      mergeQueueRows: [{
        nodeId: "merge-queue",
        ticketsLanded: [],
        ticketsEvicted: [{ ticketId: "u1", reason: "conflict", details: "needs rebase" }],
      }],
      latestTest: () => ({ nodeId: "u1:test", iteration: 3, testsPassed: true, buildPassed: true }),
      testHistory: () => [{ nodeId: "u1:test", iteration: 3, testsPassed: true, buildPassed: true }],
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

    const notReady = {
      ...base,
      latestFinalReview: () => finalReview(3),
      finalReviewHistory: () => [finalReview(3)],
    };
    expect(buildMergeTickets(notReady, units, "run-1", 3)).toEqual([]);

    const ready = {
      ...base,
      latestFinalReview: () => finalReview(3, { readyToMoveOn: true, approved: true, reasoning: "ok" }),
      finalReviewHistory: () => [finalReview(3, { readyToMoveOn: true, approved: true, reasoning: "ok" })],
    };
    expect(buildMergeTickets(ready, units, "run-1", 3).map((t) => t.ticketId)).toEqual(["u1"]);
  });
});

describe("decision audits", () => {
  test("treats approval after rejection without new work as invalidated", () => {
    const s = snapshot({
      latestTest: () => ({ nodeId: "u1:test", iteration: 1, testsPassed: true, buildPassed: true }),
      testHistory: () => [{ nodeId: "u1:test", iteration: 1, testsPassed: true, buildPassed: true }],
      finalReviewHistory: () => [
        finalReview(1, { reasoning: "reject" }),
        finalReview(2, { readyToMoveOn: true, approved: true, reasoning: "schema fixed" }),
      ],
      latestFinalReview: () => finalReview(2, { readyToMoveOn: true, approved: true, reasoning: "schema fixed" }),
    });

    const audit = getDecisionAudit(s, "u1");
    expect(audit.status).toBe("invalidated");
    expect(audit.finalDecision?.approvalOnlyCorrectedFormatting).toBe(true);
    expect(isMergeEligible(s, "u1")).toBe(false);
  });

  test("requires landed plus approved durable decision for semantic completion", () => {
    const s = snapshot({
      mergeQueueRows: [{
        nodeId: "merge-queue",
        ticketsLanded: [{ ticketId: "u1", mergeCommit: "abc", summary: "ok", decisionIteration: 2, testIteration: 2, approvalSupersededRejection: true }],
        ticketsEvicted: [],
      }],
      latestTest: () => ({ nodeId: "u1:test", iteration: 2, testsPassed: true, buildPassed: true }),
      testHistory: () => [
        { nodeId: "u1:test", iteration: 1, testsPassed: false, buildPassed: false },
        { nodeId: "u1:test", iteration: 2, testsPassed: true, buildPassed: true },
      ],
      implementHistory: () => [{ nodeId: "u1:implement", iteration: 2, whatWasDone: "fixed", filesCreated: [], filesModified: [], believesComplete: true }],
      reviewFixHistory: () => [{ nodeId: "u1:review-fix", iteration: 2, summary: "fixed", allIssuesResolved: true, buildPassed: true, testsPassed: true }],
      finalReviewHistory: () => [
        finalReview(1, { reasoning: "reject" }),
        finalReview(2, { readyToMoveOn: true, approved: true, reasoning: "approved" }),
      ],
      latestFinalReview: () => finalReview(2, { readyToMoveOn: true, approved: true, reasoning: "approved" }),
      latestImplement: () => ({ nodeId: "u1:implement", iteration: 2, whatWasDone: "fixed", filesCreated: [], filesModified: [], believesComplete: true }),
      isUnitLanded: () => true,
    });

    expect(getDecisionAudit(s, "u1").status).toBe("approved");
    expect(getDecisionAudit(s, "u1").semanticallyComplete).toBe(true);
  });
});
