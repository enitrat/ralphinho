import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { queryRows } from "../event-bridge";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeItemsDb(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  db.run("CREATE TABLE items (id TEXT NOT NULL, value INTEGER NOT NULL)");
  db.run("INSERT INTO items VALUES ('a', 1)");
  db.run("INSERT INTO items VALUES ('b', 0)");
  db.run("INSERT INTO items VALUES ('skip-me', 99)");
  return db;
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
