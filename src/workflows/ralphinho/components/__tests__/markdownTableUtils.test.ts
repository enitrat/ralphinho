import { describe, expect, test } from "bun:test";
import {
  buildFileSummary,
  buildMarkdownTable,
  getAllFiles,
  type MarkdownColumn,
  type TicketWithFiles,
} from "../markdownTableUtils";

// ── getAllFiles ──────────────────────────────────────────────────────

describe("getAllFiles", () => {
  test("combines modified and created files", () => {
    const ticket: TicketWithFiles = {
      filesModified: ["a.ts", "b.ts"],
      filesCreated: ["c.ts"],
    };
    expect(getAllFiles(ticket)).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  test("returns empty array when both lists are empty", () => {
    const ticket: TicketWithFiles = { filesModified: [], filesCreated: [] };
    expect(getAllFiles(ticket)).toEqual([]);
  });
});

// ── buildFileSummary ────────────────────────────────────────────────

describe("buildFileSummary", () => {
  test("returns '(unknown)' when no files are listed", () => {
    const ticket: TicketWithFiles = { filesModified: [], filesCreated: [] };
    expect(buildFileSummary(ticket)).toBe("(unknown)");
  });

  test("lists all files when count <= maxFiles", () => {
    const ticket: TicketWithFiles = {
      filesModified: ["a.ts", "b.ts"],
      filesCreated: ["c.ts"],
    };
    expect(buildFileSummary(ticket)).toBe("a.ts, b.ts, c.ts");
  });

  test("truncates and appends count when files exceed maxFiles", () => {
    const ticket: TicketWithFiles = {
      filesModified: ["a.ts", "b.ts", "c.ts"],
      filesCreated: ["d.ts", "e.ts", "f.ts"],
    };
    expect(buildFileSummary(ticket)).toBe("a.ts, b.ts, c.ts, d.ts, e.ts (+1 more)");
  });

  test("respects custom maxFiles parameter", () => {
    const ticket: TicketWithFiles = {
      filesModified: ["a.ts", "b.ts", "c.ts"],
      filesCreated: [],
    };
    expect(buildFileSummary(ticket, 2)).toBe("a.ts, b.ts (+1 more)");
  });

  test("shows exact maxFiles without truncation message at boundary", () => {
    const ticket: TicketWithFiles = {
      filesModified: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
      filesCreated: [],
    };
    // Exactly 5 files with default maxFiles=5 → no truncation
    expect(buildFileSummary(ticket)).toBe("a.ts, b.ts, c.ts, d.ts, e.ts");
  });
});

// ── buildMarkdownTable ──────────────────────────────────────────────

describe("buildMarkdownTable", () => {
  type Row = { name: string; value: number };

  const columns: MarkdownColumn<Row>[] = [
    { header: "Name", cell: (r) => r.name },
    { header: "Value", cell: (r) => String(r.value) },
  ];

  test("builds a table with header, separator, and rows", () => {
    const rows: Row[] = [
      { name: "alpha", value: 1 },
      { name: "beta", value: 2 },
    ];
    const result = buildMarkdownTable(columns, rows);
    const lines = result.split("\n");

    expect(lines[0]).toBe("| Name | Value |");
    expect(lines[1]).toBe("|---|---|");
    expect(lines[2]).toBe("| alpha | 1 |");
    expect(lines[3]).toBe("| beta | 2 |");
    expect(lines).toHaveLength(4);
  });

  test("returns header and separator only when rows are empty", () => {
    const result = buildMarkdownTable(columns, []);
    const lines = result.split("\n");

    expect(lines[0]).toBe("| Name | Value |");
    expect(lines[1]).toBe("|---|---|");
    expect(lines).toHaveLength(2);
  });

  test("defaults separator to '---' when not specified", () => {
    const result = buildMarkdownTable(columns, []);
    expect(result).toContain("|---|---|");
  });

  test("uses custom separator when provided", () => {
    const customColumns: MarkdownColumn<Row>[] = [
      { header: "Name", separator: "--------", cell: (r) => r.name },
      { header: "Value", separator: ":---:", cell: (r) => String(r.value) },
    ];
    const result = buildMarkdownTable(customColumns, []);
    expect(result).toContain("|--------|:---:|");
  });

  test("passes row index to cell function", () => {
    const indexColumns: MarkdownColumn<Row>[] = [
      { header: "#", cell: (_r, i) => String(i + 1) },
      { header: "Name", cell: (r) => r.name },
    ];
    const rows: Row[] = [
      { name: "first", value: 0 },
      { name: "second", value: 0 },
    ];
    const result = buildMarkdownTable(indexColumns, rows);
    const lines = result.split("\n");

    expect(lines[2]).toBe("| 1 | first |");
    expect(lines[3]).toBe("| 2 | second |");
  });
});
