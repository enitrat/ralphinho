import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { pollEventsFromDb, queryRows } from "../event-bridge";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeItemsDb(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  db.run("CREATE TABLE items (id TEXT NOT NULL, value INTEGER NOT NULL)");
  db.run("INSERT INTO items VALUES ('a', 1)");
  db.run("INSERT INTO items VALUES ('b', 0)");
  db.run("INSERT INTO items VALUES ('skip-me', 99)");
  return db;
}

async function makeReviewLoopDb(rows: Array<{
  runId: string;
  nodeId: string;
  iteration: number;
  iterationCount: number;
  codeSeverity: "critical" | "major" | "minor" | "none";
  prdSeverity: "critical" | "major" | "minor" | "none";
  passed: 0 | 1;
  exhausted: 0 | 1;
}>): Promise<{ dir: string; dbPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "event-bridge-test-"));
  const dbPath = join(dir, "events.db");
  const db = new Database(dbPath);
  db.run(`
    CREATE TABLE review_loop_result (
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      iteration INTEGER NOT NULL,
      iteration_count INTEGER NOT NULL,
      code_severity TEXT NOT NULL,
      prd_severity TEXT NOT NULL,
      passed INTEGER NOT NULL,
      exhausted INTEGER NOT NULL
    )
  `);
  for (const row of rows) {
    db.run(
      `INSERT INTO review_loop_result
       (run_id, node_id, iteration, iteration_count, code_severity, prd_severity, passed, exhausted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.runId,
        row.nodeId,
        row.iteration,
        row.iterationCount,
        row.codeSeverity,
        row.prdSeverity,
        row.passed,
        row.exhausted,
      ],
    );
  }
  db.close();
  return { dir, dbPath };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("queryRows", () => {
  test("returns correctly mapped rows for valid data", () => {
    const db = makeItemsDb();
    const result = queryRows(
      db,
      "SELECT id, value FROM items WHERE id != 'skip-me'",
      [],
      (row) => {
        const r = row as { id: string; value: number };
        return { id: r.id, flag: Boolean(r.value) };
      },
    );
    expect(result).toEqual([
      { id: "a", flag: true },
      { id: "b", flag: false },
    ]);
    db.close();
  });

  test("filters out null when mapper returns null", () => {
    const db = makeItemsDb();
    const result = queryRows(
      db,
      "SELECT id, value FROM items",
      [],
      (row) => {
        const r = row as { id: string; value: number };
        if (r.id === "skip-me") return null;
        return { id: r.id };
      },
    );
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.id !== "skip-me")).toBe(true);
    db.close();
  });

  test("returns [] when DB throws (non-existent table)", () => {
    const db = new Database(":memory:");
    const result = queryRows(
      db,
      "SELECT * FROM non_existent_table",
      [],
      (row) => row,
    );
    expect(result).toEqual([]);
    db.close();
  });

  test("returns [] for empty result set", () => {
    const db = makeItemsDb();
    const result = queryRows(
      db,
      "SELECT id FROM items WHERE id = 'not-there'",
      [],
      (row) => row,
    );
    expect(result).toEqual([]);
    db.close();
  });

  test("passes params correctly to query", () => {
    const db = makeItemsDb();
    const result = queryRows(
      db,
      "SELECT id, value FROM items WHERE id = ?",
      ["a"],
      (row) => row as { id: string; value: number },
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("a");
    db.close();
  });
});

describe("pollEventsFromDb", () => {
  test("keeps final review decision pending while review loop is not passed and not exhausted", async () => {
    const { dir, dbPath } = await makeReviewLoopDb([
      {
        runId: "run-1",
        nodeId: "ticket-1:review-fix",
        iteration: 1,
        iterationCount: 1,
        codeSeverity: "major",
        prdSeverity: "none",
        passed: 0,
        exhausted: 0,
      },
    ]);
    try {
      const events = await pollEventsFromDb(dbPath, "run-1", join(dir, "missing-plan.json"));
      const decision = events.find(
        (event) => event.type === "final-review-decision" && event.unitId === "ticket-1",
      );
      expect(decision?.type).toBe("final-review-decision");
      expect(decision && decision.type === "final-review-decision" ? decision.status : null).toBe("pending");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
