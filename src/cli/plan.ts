/**
 * ralphinho plan — (Re)generate the work plan from an RFC.
 *
 * Reads the RFC path from .ralphinho/config.json, re-runs decomposition,
 * and overwrites .ralphinho/work-plan.json.
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getRalphDir, scanRepo, type ParsedArgs } from "./shared";
import { decomposeRFC, printPlanSummary } from "../scheduled/decompose";
import { ralphinhoConfigSchema, type RalphinhoConfig } from "../scheduled/types";

export async function runPlan(opts: {
  flags: ParsedArgs["flags"];
  repoRoot: string;
}): Promise<void> {
  const { repoRoot } = opts;
  const ralphDir = getRalphDir(repoRoot);
  const configPath = join(ralphDir, "config.json");

  if (!existsSync(configPath)) {
    console.error(
      "Error: No ralphinho config found. Run `ralphinho init scheduled-work ./rfc.md` first.",
    );
    process.exit(1);
  }

  const config: RalphinhoConfig = ralphinhoConfigSchema.parse(
    JSON.parse(await readFile(configPath, "utf8")),
  );

  if (config.mode !== "scheduled-work") {
    console.error(
      "Error: `ralphinho plan` only works in scheduled-work mode.",
    );
    process.exit(1);
  }

  if (!config.rfcPath || !existsSync(config.rfcPath)) {
    console.error(`Error: RFC file not found: ${config.rfcPath}`);
    process.exit(1);
  }

  console.log("🗂️  ralphinho plan — Regenerating work plan\n");
  console.log(`  RFC: ${config.rfcPath}`);

  const rfcContent = await readFile(config.rfcPath, "utf8");
  const repoConfig = await scanRepo(repoRoot);

  const { plan, layers } = await decomposeRFC(rfcContent, repoConfig);
  plan.source = config.rfcPath;

  printPlanSummary(plan, layers);

  const planPath = join(ralphDir, "work-plan.json");
  await writeFile(planPath, JSON.stringify(plan, null, 2) + "\n", "utf8");

  console.log(`  Updated: ${planPath}`);
  console.log();
}
