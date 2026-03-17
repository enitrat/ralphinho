/**
 * ralphinho plan — (Re)generate the work plan from an RFC.
 *
 * Reads the RFC path from .ralphinho/config.json, re-runs decomposition,
 * and overwrites .ralphinho/work-plan.json.
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  getRalphDir,
  readPromptInput,
  scanRepo,
  type ParsedArgs,
} from "./shared";
import { createSpinner } from "./spinner";
import { ralphinhoConfigSchema } from "../config/types";
import { decomposeRFC, printPlanSummary } from "../workflows/ralphinho/decompose";
import type { WorkPlan, WorkUnit } from "../workflows/ralphinho/types";
import { buildReviewPlan } from "../workflows/improvinho/plan";

export async function runPlan(opts: {
  flags: ParsedArgs["flags"];
  repoRoot: string;
}): Promise<void> {
  const { repoRoot } = opts;
  const ralphDir = getRalphDir(repoRoot);
  const configPath = join(ralphDir, "config.json");

  if (!existsSync(configPath)) {
    console.error(
      "Error: No ralphinho config found. Run `ralphinho init ./rfc.md` first.",
    );
    process.exit(1);
  }

  const config = ralphinhoConfigSchema.parse(
    JSON.parse(await readFile(configPath, "utf8")),
  );

  if (config.mode === "scheduled-work") {
    if (!config.rfcPath || !existsSync(config.rfcPath)) {
      console.error(`Error: RFC file not found: ${config.rfcPath}`);
      process.exit(1);
    }

    console.log("🗂️  ralphinho plan — Regenerating work plan\n");
    console.log(`  RFC: ${config.rfcPath}`);

    const rfcContent = await readFile(config.rfcPath, "utf8");
    const repoConfig = await scanRepo(repoRoot);

    const spinner = createSpinner("Decomposing RFC into work units...");
    spinner.start();
    let plan: WorkPlan;
    let layers: WorkUnit[][];
    try {
      ({ plan, layers } = await decomposeRFC(rfcContent, repoConfig));
    } finally {
      spinner.stop();
    }
    plan.source = config.rfcPath;

    printPlanSummary(plan, layers);

    const planPath = join(ralphDir, "work-plan.json");
    await writeFile(planPath, JSON.stringify(plan, null, 2) + "\n", "utf8");

    console.log(`  Updated: ${planPath}`);
    console.log();
    return;
  }

  console.log("🔎 ralphinho plan — Regenerating review plan\n");
  const { promptText, promptSourcePath } = await readPromptInput(
    config.reviewInstructionSource ?? config.reviewInstruction,
    repoRoot,
  );
  const repoConfig = await scanRepo(repoRoot);
  const plan = await buildReviewPlan({
    repoRoot,
    instruction: promptText,
    promptSourcePath,
    explicitPaths: config.reviewPaths,
    repoConfig,
  });

  const planPath = join(ralphDir, "review-plan.json");
  await writeFile(planPath, JSON.stringify(plan, null, 2) + "\n", "utf8");

  console.log(`  Updated: ${planPath}`);
  console.log(`  Slices: ${plan.slices.length}`);
  console.log();
}
