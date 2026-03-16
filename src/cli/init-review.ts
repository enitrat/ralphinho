import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  detectAgents,
  getRalphDir,
  readPromptInput,
  scanRepo,
  type ParsedArgs,
} from "./shared";
import {
  reviewAgentOverrideSchema,
  type ReviewDiscoveryConfig,
  type ReviewAgentOverride,
} from "../config/types";
import { buildReviewPlan } from "../workflows/improvinho/plan";

function collectReviewPaths(
  positional: string[],
  flags: ParsedArgs["flags"],
): string[] {
  const fromFlag = typeof flags.paths === "string"
    ? flags.paths.split(",").map((entry) => entry.trim()).filter(Boolean)
    : [];

  return [...fromFlag, ...positional].filter(Boolean);
}

function parseReviewAgentOverride(
  flags: ParsedArgs["flags"],
): ReviewAgentOverride | null {
  if (typeof flags.agent !== "string") return null;

  const parsed = reviewAgentOverrideSchema.safeParse(flags.agent.trim().toLowerCase());
  if (!parsed.success) {
    console.error(
      'Error: Invalid --agent value for review mode. Use one of: "sonnet", "opus", "codex".',
    );
    process.exit(1);
  }

  return parsed.data;
}

export async function initReviewDiscovery(opts: {
  positional: string[];
  flags: ParsedArgs["flags"];
  repoRoot: string;
}): Promise<void> {
  const { positional, flags, repoRoot } = opts;

  console.log("🔎 ralphinho — Review Discovery Mode\n");

  const rawInstruction = positional[0];
  if (!rawInstruction) {
    console.error("Error: Review instruction is required.");
    console.error('Usage: ralphinho init review "<instruction>" --paths src/foo src/bar');
    process.exit(1);
  }

  const reviewPaths = collectReviewPaths(positional.slice(1), flags);
  if (reviewPaths.length === 0) {
    console.error("Error: Review mode requires at least one path via `--paths`.");
    process.exit(1);
  }

  const { promptText, promptSourcePath } = await readPromptInput(rawInstruction, repoRoot);
  const repoConfig = await scanRepo(repoRoot);
  const agents = await detectAgents(repoRoot);
  const reviewAgentOverride = parseReviewAgentOverride(flags);

  if (!agents.claude && !agents.codex) {
    console.error(
      "\nError: No supported agent CLI detected. Install claude and/or codex.",
    );
    process.exit(1);
  }

  const reviewPlan = await buildReviewPlan({
    repoRoot,
    instruction: promptText,
    promptSourcePath,
    explicitPaths: reviewPaths,
    repoConfig,
  });

  const maxConcurrency =
    typeof flags["max-concurrency"] === "string"
      ? Math.max(1, Number(flags["max-concurrency"]) || 4)
      : 4;

  const config: ReviewDiscoveryConfig = {
    mode: "review-discovery",
    repoRoot,
    reviewInstruction: promptText,
    reviewInstructionSource: promptSourcePath,
    reviewPaths: reviewPlan.slices.map((slice) => slice.path),
    reviewAgentOverride,
    agents,
    maxConcurrency,
    createdAt: new Date().toISOString(),
  };

  const ralphDir = getRalphDir(repoRoot);
  await mkdir(ralphDir, { recursive: true });

  const configPath = join(ralphDir, "config.json");
  const planPath = join(ralphDir, "review-plan.json");

  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await writeFile(planPath, `${JSON.stringify(reviewPlan, null, 2)}\n`, "utf8");

  console.log(`  Repo: ${repoRoot}`);
  console.log(`  Instruction: ${promptSourcePath ?? promptText}`);
  console.log(`  Review paths: ${reviewPlan.slices.map((slice) => slice.path).join(", ")}`);
  console.log(`  Slices: ${reviewPlan.slices.length}`);
  console.log(`  Agents: claude=${agents.claude} codex=${agents.codex}`);
  if (reviewAgentOverride) {
    console.log(`  Agent override: ${reviewAgentOverride}`);
  }
  console.log("  Written:");
  console.log(`    ${configPath}`);
  console.log(`    ${planPath}`);
  console.log();
  console.log("  Run:");
  console.log("    ralphinho run");
  console.log();
}
