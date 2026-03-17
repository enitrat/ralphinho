import { describe, expect, test } from "bun:test";
import type { SmithersCtx } from "smithers-orchestrator";
import type { ScheduledOutputs } from "../../components/QualityPipeline";
import { buildSnapshot } from "../snapshot";

/** Minimal ctx factory: returns the provided tables from outputs(), all others are empty. */
function makeCtx(tables: Record<string, unknown[]>): SmithersCtx<ScheduledOutputs> {
  return {
    outputs: (table: string) => tables[table] ?? [],
  } as unknown as SmithersCtx<ScheduledOutputs>;
}

describe("buildSnapshot", () => {
  test("returns a valid snapshot from well-formed data", () => {
    const ctx = makeCtx({
      merge_queue: [{
        nodeId: "merge-queue",
        ticketsLanded: [{ ticketId: "u1", mergeCommit: "abc", summary: "ok", reviewLoopIteration: 1, testIteration: 1 }],
        ticketsEvicted: [],
      }],
      test: [{ nodeId: "u1:test", iteration: 1, testsPassed: true, buildPassed: true }],
      review_loop_result: [{ nodeId: "u1:review-loop", iteration: 1, passed: true, summary: "ok" }],
      implement: [{ nodeId: "u1:implement", iteration: 1, whatWasDone: "done", believesComplete: true, filesCreated: null, filesModified: ["a.ts"] }],
      review_fix: [{ nodeId: "u1:review-fix", iteration: 1, summary: "fixed", allIssuesResolved: true, buildPassed: true, testsPassed: true }],
    });

    const snapshot = buildSnapshot(ctx);
    expect(snapshot.mergeQueueRows).toHaveLength(1);
    expect(snapshot.latestTest("u1")).toEqual({ nodeId: "u1:test", iteration: 1, testsPassed: true, buildPassed: true });
    expect(snapshot.latestReviewLoopResult("u1")).toEqual({ nodeId: "u1:review-loop", iteration: 1, passed: true, summary: "ok" });
    expect(snapshot.latestImplement("u1")).toEqual({ nodeId: "u1:implement", iteration: 1, whatWasDone: "done", believesComplete: true, filesCreated: null, filesModified: ["a.ts"] });
  });
});
