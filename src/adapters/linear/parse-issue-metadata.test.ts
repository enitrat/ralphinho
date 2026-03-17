import { describe, expect, test } from "bun:test";
import { parseIssueMetadata } from "./parse-issue-metadata";
import type { IssueMetadata } from "./parse-issue-metadata";

describe("parseIssueMetadata", () => {
  test("extracts all six fields from a well-formed improvinho description", () => {
    const description = [
      "**Kind:** bug",
      "**Priority:** high",
      "**Confidence:** confirmed",
      "**File:** `src/auth/token.ts`",
      "**Lines:** `src/auth/token.ts:10`, `src/auth/token.ts:20`, `src/auth/token.ts:30`",
      "**Symbol:** `refreshToken`",
    ].join("\n");

    const result: IssueMetadata = parseIssueMetadata(description);

    expect(result.kind).toBe("bug");
    expect(result.priority).toBe("high");
    expect(result.confidence).toBe("confirmed");
    expect(result.primaryFile).toBe("src/auth/token.ts");
    expect(result.lineRefs).toEqual([
      "src/auth/token.ts:10",
      "src/auth/token.ts:20",
      "src/auth/token.ts:30",
    ]);
    expect(result.symbol).toBe("refreshToken");
  });

  test("returns all-null metadata with empty lineRefs for null description", () => {
    const result = parseIssueMetadata(null);

    expect(result).toEqual({
      kind: null,
      priority: null,
      confidence: null,
      primaryFile: null,
      lineRefs: [],
      symbol: null,
    });
  });

  test("returns null for each missing field individually", () => {
    // Only Kind and Priority present — rest should be null/empty
    const description = [
      "**Kind:** enhancement",
      "**Priority:** medium",
    ].join("\n");

    const result = parseIssueMetadata(description);

    expect(result.kind).toBe("enhancement");
    expect(result.priority).toBe("medium");
    expect(result.confidence).toBeNull();
    expect(result.primaryFile).toBeNull();
    expect(result.lineRefs).toEqual([]);
    expect(result.symbol).toBeNull();
  });

  test("handles backtick-wrapped and non-backtick primaryFile values", () => {
    const withBackticks = "**File:** `src/foo.ts`";
    const withoutBackticks = "**File:** src/foo.ts";

    const r1 = parseIssueMetadata(withBackticks);
    const r2 = parseIssueMetadata(withoutBackticks);

    expect(r1.primaryFile).toBe("src/foo.ts");
    expect(r2.primaryFile).toBe("src/foo.ts");
  });

  test("splits comma-separated Lines into array and strips backticks", () => {
    const description = "**Lines:** `file.ts:10`, `file.ts:20`, `file.ts:30`";

    const result = parseIssueMetadata(description);

    expect(result.lineRefs).toEqual(["file.ts:10", "file.ts:20", "file.ts:30"]);
  });

  test("handles extra whitespace around values", () => {
    const description = [
      "**Kind:**   bug  ",
      "**Priority:**  high  ",
      "**Confidence:**  confirmed  ",
      "**File:**   `src/foo.ts`  ",
      "**Symbol:**   `myFunc`  ",
    ].join("\n");

    const result = parseIssueMetadata(description);

    expect(result.kind).toBe("bug");
    expect(result.priority).toBe("high");
    expect(result.confidence).toBe("confirmed");
    expect(result.primaryFile).toBe("src/foo.ts");
    expect(result.symbol).toBe("myFunc");
  });
});
