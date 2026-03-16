import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Database } from "bun:sqlite";

import type { ReviewFinding, ReviewLens } from "./types";

type FindingRow = {
  run_id: string;
  iteration: number;
  findings: string;
};

export type MergedReviewFinding = {
  id: string;
  mergeKey: string;
  kind: ReviewFinding["kind"];
  priority: ReviewFinding["priority"];
  confidence: ReviewFinding["confidence"];
  summary: string;
  evidence: string;
  primaryFile: string;
  lineRefs: string[];
  symbol: string | null;
  pattern: string;
  suggestedDiff: string | null;
  acceptIf: string | null;
  dismissIf: string | null;
  sourceLenses: ReviewLens[];
  sourceScopes: string[];
  supportCount: number;
};

type ProjectedFinding = MergedReviewFinding & {
  displayId: string;
};

function normalizePart(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "module";
}

function priorityRank(priority: ReviewFinding["priority"]): number {
  return {
    critical: 4,
    high: 3,
    medium: 2,
    low: 1,
  }[priority];
}

function confidenceRank(confidence: ReviewFinding["confidence"]): number {
  return {
    high: 3,
    medium: 2,
    low: 1,
  }[confidence];
}

function kindRank(kind: ReviewFinding["kind"]): number {
  return {
    security: 5,
    bug: 4,
    architecture: 3,
    "test-gap": 2,
    simplification: 1,
  }[kind];
}

function scopeModeRank(mode: ReviewFinding["scopeMode"]): number {
  return mode === "slice" ? 2 : 1;
}

function lensRank(lens: ReviewLens): number {
  return {
    "refactor-hunter": 1,
    "type-system-purist": 2,
    "app-logic-architecture": 3,
  }[lens];
}

function buildMergeKey(finding: ReviewFinding): string {
  return [
    normalizePart(finding.primaryFile),
    normalizePart(finding.symbol),
    normalizePart(finding.pattern),
  ].join(":");
}

function buildMergedFindingId(mergeKey: string): string {
  return createHash("sha1")
    .update(mergeKey)
    .digest("hex")
    .slice(0, 12);
}

function nextDisplayId(index: number): string {
  return `IMP-${String(index).padStart(4, "0")}`;
}

function compareFindings(left: ReviewFinding, right: ReviewFinding): number {
  return (
    confidenceRank(right.confidence) - confidenceRank(left.confidence)
    || priorityRank(right.priority) - priorityRank(left.priority)
    || scopeModeRank(right.scopeMode) - scopeModeRank(left.scopeMode)
    || lensRank(left.lens) - lensRank(right.lens)
    || left.dedupeKey.localeCompare(right.dedupeKey)
  );
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function uniqueSortedLenses(values: ReviewLens[]): ReviewLens[] {
  return [...new Set(values)].sort((left, right) => lensRank(left) - lensRank(right));
}

export function mergeReviewFindings(findings: ReviewFinding[]): MergedReviewFinding[] {
  const groups = new Map<string, ReviewFinding[]>();

  for (const finding of findings) {
    if (finding.status !== "confirmed") continue;
    const mergeKey = buildMergeKey(finding);
    const existing = groups.get(mergeKey);
    if (existing) {
      existing.push(finding);
    } else {
      groups.set(mergeKey, [finding]);
    }
  }

  return [...groups.entries()]
    .map(([mergeKey, group]) => {
      const canonical = [...group].sort(compareFindings)[0]!;
      const highestPriority = group.reduce((best, current) => (
        priorityRank(current.priority) > priorityRank(best)
          ? current.priority
          : best
      ), canonical.priority);
      const highestConfidence = group.reduce((best, current) => (
        confidenceRank(current.confidence) > confidenceRank(best)
          ? current.confidence
          : best
      ), canonical.confidence);
      const canonicalKind = group.reduce((best, current) => (
        kindRank(current.kind) > kindRank(best)
          ? current.kind
          : best
      ), canonical.kind);

      return {
        id: buildMergedFindingId(mergeKey),
        mergeKey,
        kind: canonicalKind,
        priority: highestPriority,
        confidence: highestConfidence,
        summary: canonical.summary,
        evidence: canonical.evidence,
        primaryFile: canonical.primaryFile,
        lineRefs: uniqueSorted(group.flatMap((finding) => finding.lineRefs)),
        symbol: canonical.symbol,
        pattern: canonical.pattern,
        suggestedDiff: canonical.suggestedDiff,
        acceptIf: canonical.acceptIf,
        dismissIf: canonical.dismissIf,
        sourceLenses: uniqueSortedLenses(group.map((finding) => finding.lens)),
        sourceScopes: uniqueSorted(group.map((finding) => finding.scopeLabel)),
        supportCount: group.length,
      };
    })
    .sort((left, right) => (
      priorityRank(right.priority) - priorityRank(left.priority)
      || confidenceRank(right.confidence) - confidenceRank(left.confidence)
      || left.mergeKey.localeCompare(right.mergeKey)
    ));
}

function loadLatestFindingsById(
  db: Database,
  runId: string,
): ReviewFinding[] {
  const rows = db.prepare(
    `
      SELECT run_id, iteration, findings
      FROM finding
      WHERE run_id = ?
      ORDER BY iteration ASC
    `,
  ).all(runId) as FindingRow[];

  const byId = new Map<string, ReviewFinding>();

  for (const row of rows) {
    const findings = JSON.parse(row.findings) as ReviewFinding[];
    for (const finding of findings) {
      byId.set(finding.id, finding);
    }
  }

  return [...byId.values()];
}

function toProjectedFindings(findings: MergedReviewFinding[]): ProjectedFinding[] {
  return findings.map((finding, index) => ({
    ...finding,
    displayId: nextDisplayId(index + 1),
  }));
}

function formatSummaryMarkdown(findings: ProjectedFinding[]): string {
  const generatedAt = new Date().toISOString().slice(0, 10);
  const orderedPriorities = ["critical", "high", "medium", "low"] as const;
  const lines = [`# Improvinho Review - ${generatedAt}`, ""];

  for (const priority of orderedPriorities) {
    const matching = findings.filter((finding) => finding.priority === priority);
    const title = `${priority[0]!.toUpperCase()}${priority.slice(1)} (${matching.length})`;
    lines.push(`## ${title}`);

    if (matching.length === 0) {
      lines.push("No findings.");
      lines.push("");
      continue;
    }

    for (const finding of matching) {
      lines.push(`### ${finding.displayId} - ${finding.summary}`);
      lines.push(`- Kind: ${finding.kind}`);
      lines.push(`- Confidence: ${finding.confidence}`);
      lines.push(`- Seen by: ${finding.sourceLenses.join(", ")}`);
      lines.push(`- Scopes: ${finding.sourceScopes.join(", ")}`);
      lines.push(`- Support count: ${finding.supportCount}`);
      lines.push(`- Files: ${[finding.primaryFile, ...finding.lineRefs].join(", ")}`);
      lines.push(`- Evidence: ${finding.evidence}`);
      if (finding.acceptIf) lines.push(`- Accept if: ${finding.acceptIf}`);
      if (finding.dismissIf) lines.push(`- Dismiss if: ${finding.dismissIf}`);
      if (finding.suggestedDiff) {
        lines.push("");
        lines.push("```diff");
        lines.push(finding.suggestedDiff);
        lines.push("```");
      }
      lines.push("");
    }
  }

  return `${lines.join("\n")}\n`;
}

export function resolveLatestReviewRunId(db: Database): string | null {
  const row = db.prepare(
    `
      SELECT run_id
      FROM completion_report
      ORDER BY iteration DESC
      LIMIT 1
    `,
  ).get() as { run_id?: string } | undefined;

  return row?.run_id ?? null;
}

export async function projectReviewSummaryFromDb(options: {
  repoRoot: string;
  db: Database;
  runId: string;
}): Promise<{ summaryPath: string; findingCount: number }> {
  const { repoRoot, db, runId } = options;
  const ticketsRoot = join(repoRoot, ".tickets");
  const summaryPath = join(ticketsRoot, "summary.md");

  await mkdir(ticketsRoot, { recursive: true });

  const mergedFindings = mergeReviewFindings(loadLatestFindingsById(db, runId));
  const summary = formatSummaryMarkdown(toProjectedFindings(mergedFindings));
  await writeFile(summaryPath, summary, "utf8");

  return {
    summaryPath,
    findingCount: mergedFindings.length,
  };
}
