/**
 * Tests for ralphinho scores command.
 *
 * Strategy: mock the smithers DB APIs and assert CLI behavior
 * (success output, error exit, argument parsing).
 */

import { describe, expect, test, mock, beforeEach } from "bun:test";
import { formatScoresTable, type ScoresRow } from "../scores";

// ── Mock infrastructure ──────────────────────────────────────────────

const mockAggregateScores = mock(() => Promise.resolve([]));

const mockOpenSmithersDb = mock(() =>
  Promise.resolve({
    adapter: {} as any,
    cleanup: mock(() => {}),
  }),
);

mock.module("smithers-orchestrator/src/cli/find-db", () => ({
  openSmithersDb: mockOpenSmithersDb,
}));

mock.module("smithers-orchestrator", () => ({
  aggregateScores: mockAggregateScores,
}));

// Import after mocks
const { runScores } = await import("../scores");

// ── Pure function tests ──────────────────────────────────────────────

describe("formatScoresTable", () => {
  test("returns formatted table with correct columns", () => {
    const rows: ScoresRow[] = [
      {
        scorerId: "schema-adherence",
        scorerName: "Schema Adherence",
        count: 10,
        mean: 0.95,
        min: 0.8,
        max: 1.0,
        p50: 0.97,
      },
      {
        scorerId: "relevancy",
        scorerName: "Relevancy",
        count: 5,
        mean: 0.72,
        min: 0.5,
        max: 0.9,
        p50: 0.75,
      },
    ];

    const table = formatScoresTable(rows);
    expect(table).toContain("scorer");
    expect(table).toContain("count");
    expect(table).toContain("mean");
    expect(table).toContain("min");
    expect(table).toContain("max");
    expect(table).toContain("p50");
    expect(table).toContain("Schema Adherence");
    expect(table).toContain("Relevancy");
    expect(table).toContain("0.95");
    expect(table).toContain("0.72");
  });

  test("returns empty message when no rows", () => {
    const table = formatScoresTable([]);
    expect(table).toContain("No scores found");
  });
});

// ── runScores integration tests ──────────────────────────────────────

describe("runScores", () => {
  beforeEach(() => {
    mockAggregateScores.mockReset();
    mockOpenSmithersDb.mockReset();

    mockOpenSmithersDb.mockResolvedValue({
      adapter: {} as any,
      cleanup: mock(() => {}),
    });
  });

  test("opens DB and calls aggregateScores with correct runId", async () => {
    const fakeScores: ScoresRow[] = [
      {
        scorerId: "schema-adherence",
        scorerName: "Schema Adherence",
        count: 3,
        mean: 0.9,
        min: 0.8,
        max: 1.0,
        p50: 0.9,
      },
    ];
    mockAggregateScores.mockResolvedValue(fakeScores);

    await runScores({ runId: "run-001", dbPath: "/tmp/test.db" });

    expect(mockOpenSmithersDb).toHaveBeenCalledWith("/tmp/test.db");
    expect(mockAggregateScores).toHaveBeenCalledWith(
      expect.anything(),
      { runId: "run-001" },
    );
  });

  test("calls cleanup after successful execution", async () => {
    const cleanupFn = mock(() => {});
    mockOpenSmithersDb.mockResolvedValue({
      adapter: {} as any,
      cleanup: cleanupFn,
    });
    mockAggregateScores.mockResolvedValue([
      {
        scorerId: "s1",
        scorerName: "S1",
        count: 1,
        mean: 1.0,
        min: 1.0,
        max: 1.0,
        p50: 1.0,
      },
    ]);

    await runScores({ runId: "run-001", dbPath: "/tmp/test.db" });

    expect(cleanupFn).toHaveBeenCalled();
  });
});
