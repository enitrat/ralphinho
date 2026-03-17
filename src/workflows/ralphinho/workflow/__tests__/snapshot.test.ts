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

describe("buildSnapshot – boundary validation", () => {
  describe("test rows", () => {
    test("throws when testsPassed is missing", () => {
      const ctx = makeCtx({
        test: [{ nodeId: "u1:test", buildPassed: true }], // missing testsPassed
      });
      expect(() => buildSnapshot(ctx)).toThrow(/testsPassed/);
    });

    test("throws when buildPassed is missing", () => {
      const ctx = makeCtx({
        test: [{ nodeId: "u1:test", testsPassed: true }], // missing buildPassed
      });
      expect(() => buildSnapshot(ctx)).toThrow(/buildPassed/);
    });

    test("accepts a well-formed test row", () => {
      const ctx = makeCtx({
        test: [{ nodeId: "u1:test", testsPassed: true, buildPassed: false }],
      });
      expect(() => buildSnapshot(ctx)).not.toThrow();
    });
  });

  describe("final_review rows", () => {
    test("throws when readyToMoveOn is missing", () => {
      const ctx = makeCtx({
        final_review: [{ nodeId: "u1:final_review", approved: false, reasoning: "ok" }],
      });
      expect(() => buildSnapshot(ctx)).toThrow(/readyToMoveOn/);
    });

    test("throws when approved is missing", () => {
      const ctx = makeCtx({
        final_review: [{ nodeId: "u1:final_review", readyToMoveOn: false, reasoning: "ok" }],
      });
      expect(() => buildSnapshot(ctx)).toThrow(/approved/);
    });

    test("throws when reasoning is missing", () => {
      const ctx = makeCtx({
        final_review: [{ nodeId: "u1:final_review", readyToMoveOn: false, approved: false }],
      });
      expect(() => buildSnapshot(ctx)).toThrow(/reasoning/);
    });

    test("accepts a well-formed final_review row", () => {
      const ctx = makeCtx({
        final_review: [{ nodeId: "u1:final_review", readyToMoveOn: false, approved: false, reasoning: "needs work" }],
      });
      expect(() => buildSnapshot(ctx)).not.toThrow();
    });
  });

  describe("implement rows", () => {
    test("throws when whatWasDone is missing", () => {
      const ctx = makeCtx({
        implement: [{ nodeId: "u1:implement", believesComplete: true, filesCreated: null, filesModified: null }],
      });
      expect(() => buildSnapshot(ctx)).toThrow(/whatWasDone/);
    });

    test("throws when believesComplete is missing", () => {
      const ctx = makeCtx({
        implement: [{ nodeId: "u1:implement", whatWasDone: "done", filesCreated: null, filesModified: null }],
      });
      expect(() => buildSnapshot(ctx)).toThrow(/believesComplete/);
    });

    test("accepts a well-formed implement row", () => {
      const ctx = makeCtx({
        implement: [{ nodeId: "u1:implement", whatWasDone: "done", believesComplete: true, filesCreated: null, filesModified: ["a.ts"] }],
      });
      expect(() => buildSnapshot(ctx)).not.toThrow();
    });
  });

  describe("review_fix rows", () => {
    test("throws when summary is missing", () => {
      const ctx = makeCtx({
        review_fix: [{ nodeId: "u1:review_fix", allIssuesResolved: true, buildPassed: true, testsPassed: true }],
      });
      expect(() => buildSnapshot(ctx)).toThrow(/summary/);
    });

    test("throws when allIssuesResolved is missing", () => {
      const ctx = makeCtx({
        review_fix: [{ nodeId: "u1:review_fix", summary: "fixed", buildPassed: true, testsPassed: true }],
      });
      expect(() => buildSnapshot(ctx)).toThrow(/allIssuesResolved/);
    });

    test("accepts a well-formed review_fix row", () => {
      const ctx = makeCtx({
        review_fix: [{ nodeId: "u1:review_fix", summary: "fixed", allIssuesResolved: true, buildPassed: true, testsPassed: true }],
      });
      expect(() => buildSnapshot(ctx)).not.toThrow();
    });
  });

  test("error message includes the table name and field name", () => {
    const ctx = makeCtx({
      test: [{ nodeId: "u1:test" }], // both required fields missing
    });
    expect(() => buildSnapshot(ctx)).toThrow(/table.*test|test.*table/i);
  });
});
