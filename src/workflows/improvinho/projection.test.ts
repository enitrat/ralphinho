import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Database } from "bun:sqlite";

import { mergeReviewFindings, projectReviewSummaryFromDb } from "./projection";
import type { ReviewFinding } from "./types";

const createdDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function buildFinding(overrides: Partial<ReviewFinding>): ReviewFinding {
  return {
    id: "f1",
    lens: "refactor-hunter",
    status: "confirmed",
    dedupeKey: "refactor-hunter:bug:src-auth-login-ts:handle-login:null-session",
    kind: "bug",
    priority: "high",
    confidence: "high",
    summary: "Null session can escape the login guard",
    evidence: "The handler reads session.user.id before the session null check.",
    primaryFile: "src/auth/login.ts",
    lineRefs: ["src/auth/login.ts:14", "src/auth/login.ts:18"],
    symbol: "handleLogin",
    pattern: "null-session",
    suggestedDiff: "- const id = session.user.id\n+ if (!session) return null\n+ const id = session.user.id",
    acceptIf: null,
    dismissIf: null,
    rejectionReason: null,
    scopeId: "slice-auth",
    scopeMode: "slice",
    scopeLabel: "src/auth/login.ts",
    discoveredAt: "2026-03-16T00:00:00.000Z",
    ...overrides,
  };
}

describe("mergeReviewFindings", () => {
  test("merges duplicate confirmed findings across lenses and scopes deterministically", () => {
    const merged = mergeReviewFindings([
      buildFinding({ id: "f1" }),
      buildFinding({
        id: "f2",
        lens: "type-system-purist",
        dedupeKey: "type-system-purist:simplification:src-auth-login-ts:handle-login:null-session",
        kind: "simplification",
        confidence: "medium",
        summary: "This branch defends against a nullable session the contract already excludes.",
        evidence: "The function signature already receives an authenticated session.",
      }),
      buildFinding({
        id: "f3",
        lens: "app-logic-architecture",
        scopeId: "cross-auth",
        scopeMode: "cross-cutting",
        scopeLabel: "src/auth",
        dedupeKey: "app-logic-architecture:architecture:src-auth-login-ts:handle-login:null-session",
        kind: "architecture",
        confidence: "medium",
      }),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.sourceLenses).toEqual([
      "refactor-hunter",
      "type-system-purist",
      "app-logic-architecture",
    ]);
    expect(merged[0]?.sourceScopes).toEqual(["src/auth", "src/auth/login.ts"]);
    expect(merged[0]?.supportCount).toBe(3);
    expect(merged[0]?.kind).toBe("bug");
    expect(merged[0]?.summary).toBe("Null session can escape the login guard");
  });
});

describe("projectReviewSummaryFromDb", () => {
  test("writes a single merged summary grouped by priority from DB findings", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "super-ralph-projection-"));
    createdDirs.push(repoRoot);

    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE finding (
        run_id TEXT NOT NULL,
        iteration INTEGER NOT NULL,
        findings TEXT NOT NULL
      );
    `);

    const confirmed = buildFinding({ id: "f1" });
    const duplicateFromOtherLens = buildFinding({
      id: "f2",
      lens: "type-system-purist",
      dedupeKey: "type-system-purist:simplification:src-auth-login-ts:handle-login:null-session",
      kind: "simplification",
      confidence: "medium",
      summary: "This branch defends against a nullable session the contract already excludes.",
      evidence: "The function signature already receives an authenticated session.",
    });
    const rejected = buildFinding({
      id: "f3",
      status: "rejected",
      dedupeKey: "refactor-hunter:simplification:src-auth-login-ts:module:style-only",
      kind: "simplification",
      priority: "low",
      confidence: "low",
      summary: "Style-only cleanup",
      evidence: "Low-value style observation.",
      symbol: null,
      pattern: "style-only",
      suggestedDiff: null,
      rejectionReason: "Rejected by validation filter: low confidence or missing required evidence.",
    });

    db.prepare("INSERT INTO finding (run_id, iteration, findings) VALUES (?, ?, ?)")
      .run("rv-test", 1, JSON.stringify([confirmed, duplicateFromOtherLens, rejected]));

    const result = await projectReviewSummaryFromDb({
      repoRoot,
      db,
      runId: "rv-test",
    });

    expect(result.findingCount).toBe(1);
    const summary = await readFile(result.summaryPath, "utf8");
    expect(summary).toContain("# Improvinho Review - ");
    expect(summary).toContain("## High (1)");
    expect(summary).toContain("### IMP-0001 - Null session can escape the login guard");
    expect(summary).toContain("- Seen by: refactor-hunter, type-system-purist");
    expect(summary).toContain("- Support count: 2");
    expect(summary).toContain("The handler reads session.user.id before the session null check.");
    expect(summary).toContain("```diff");
    expect(summary).not.toContain("Style-only cleanup");

    db.close();
  });
});
