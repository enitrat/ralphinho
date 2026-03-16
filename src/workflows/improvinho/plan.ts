import { existsSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";

import type { RepoConfig } from "../../cli/shared";
import type { ReviewPlan, ReviewSlice } from "./types";

type BuildReviewPlanOptions = {
  repoRoot: string;
  instruction: string;
  promptSourcePath: string | null;
  explicitPaths: string[];
  repoConfig: RepoConfig;
};

function normalizeRelativePath(repoRoot: string, inputPath: string): string {
  const absolute = resolve(repoRoot, inputPath);
  if (!existsSync(absolute)) {
    throw new Error(`Review path does not exist: ${absolute}`);
  }

  const repoRelative = relative(repoRoot, absolute);
  if (!repoRelative || repoRelative.startsWith("..")) {
    throw new Error(`Review path must stay within the repo: ${inputPath}`);
  }

  return repoRelative.split(sep).join("/");
}

function isAncestorPath(ancestor: string, candidate: string): boolean {
  return candidate === ancestor || candidate.startsWith(`${ancestor}/`);
}

function dedupeNonOverlappingPaths(paths: string[]): string[] {
  const sorted = [...new Set(paths)].sort((left, right) => right.length - left.length);
  const kept: string[] = [];

  for (const candidate of sorted) {
    if (kept.some((existing) => isAncestorPath(candidate, existing))) {
      continue;
    }
    kept.push(candidate);
  }

  return kept.sort();
}

function collectFocusAreas(instruction: string): string[] {
  const lower = instruction.toLowerCase();
  const focusAreas: string[] = [];

  if (lower.includes("bug")) focusAreas.push("bugs");
  if (lower.includes("security")) focusAreas.push("security");
  if (lower.includes("smell") || lower.includes("simplif")) {
    focusAreas.push("simplification");
  }
  if (lower.includes("architect")) focusAreas.push("architecture");
  if (lower.includes("test")) focusAreas.push("test-gaps");

  return focusAreas.length > 0 ? focusAreas : ["bugs", "simplification", "architecture"];
}

async function inferRisk(repoRoot: string, repoRelativePath: string): Promise<ReviewSlice["risk"]> {
  if (/(auth|security|token|session|crypto|payment|admin)/i.test(repoRelativePath)) {
    return "high";
  }

  const absolute = resolve(repoRoot, repoRelativePath);
  const stat = await lstat(absolute);
  if (stat.isDirectory()) {
    return /api|server|db|data/i.test(repoRelativePath) ? "high" : "medium";
  }

  try {
    const contents = await readFile(absolute, "utf8");
    const lineCount = contents.split("\n").length;
    if (lineCount > 600) return "high";
    if (lineCount > 250) return "medium";
  } catch {
    return "medium";
  }

  return "low";
}

function buildSliceId(prefix: string, seed: string): string {
  const hash = createHash("sha1").update(seed).digest("hex").slice(0, 8);
  const stem = seed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || prefix;

  return `${prefix}-${stem}-${hash}`;
}

async function buildSlice(
  repoRoot: string,
  repoRelativePath: string,
  focusAreas: string[],
): Promise<ReviewSlice> {
  const absolute = resolve(repoRoot, repoRelativePath);
  const stat = await lstat(absolute);
  const entryType = stat.isDirectory() ? "directory" : "file";
  const risk = await inferRisk(repoRoot, repoRelativePath);
  const rationale =
    entryType === "directory"
      ? `Review the ${basename(repoRelativePath)} module boundary without overlapping sibling slices.`
      : `Review the focused file ${basename(repoRelativePath)} as a single bounded slice.`;

  return {
    id: buildSliceId("slice", repoRelativePath),
    mode: "slice",
    path: repoRelativePath,
    entryType,
    focusAreas,
    rationale,
    risk,
    inferredPaths: [],
  };
}

function pickCrossCuttingFocusAreas(focusAreas: string[]): string[] {
  const crossCutting = focusAreas.filter((entry) => (
    entry === "architecture"
    || entry === "simplification"
    || entry === "test-gaps"
  ));
  return crossCutting.length > 0 ? crossCutting : ["architecture", "simplification"];
}

async function buildCrossCuttingSlice(
  repoRoot: string,
  paths: string[],
  focusAreas: string[],
): Promise<ReviewSlice> {
  const risks = await Promise.all(paths.map((path) => inferRisk(repoRoot, path)));
  const risk = risks.includes("high")
    ? "high"
    : (risks.includes("medium") ? "medium" : "low");

  return {
    id: buildSliceId("cross", paths.join("|")),
    mode: "cross-cutting",
    path: paths[0] ?? "cross-cutting-scope",
    entryType: "virtual",
    focusAreas: pickCrossCuttingFocusAreas(focusAreas),
    rationale:
      "Review the selected scope for duplication, inconsistent abstractions, and boundary failures that span multiple local slices.",
    risk,
    inferredPaths: paths.slice(1),
  };
}

export async function buildReviewPlan(
  options: BuildReviewPlanOptions,
): Promise<ReviewPlan> {
  const { repoRoot, instruction, promptSourcePath, explicitPaths, repoConfig } = options;

  if (explicitPaths.length === 0) {
    throw new Error("Review mode requires at least one explicit path via `--paths`.");
  }

  const normalizedPaths = dedupeNonOverlappingPaths(
    explicitPaths.map((entry) => normalizeRelativePath(repoRoot, entry)),
  );
  const focusAreas = collectFocusAreas(instruction);
  const localSlices = await Promise.all(
    normalizedPaths.map((repoRelativePath) => buildSlice(repoRoot, repoRelativePath, focusAreas)),
  );

  const slices = [...localSlices];
  if (normalizedPaths.length > 1) {
    slices.push(await buildCrossCuttingSlice(repoRoot, normalizedPaths, focusAreas));
  }

  return {
    source: promptSourcePath,
    instruction,
    generatedAt: new Date().toISOString(),
    repo: {
      projectName: repoConfig.projectName,
      buildCmds: repoConfig.buildCmds,
      testCmds: repoConfig.testCmds,
    },
    slices,
  };
}
