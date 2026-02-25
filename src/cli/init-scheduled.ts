/**
 * ralphinho init scheduled-work — Initialize an RFC-driven workflow.
 *
 * 1. Reads the RFC file
 * 2. Scans the repo for build/test commands
 * 3. Detects available agents
 * 4. AI decomposes RFC into work units + dependency DAG
 * 5. Writes .ralphinho/config.json and .ralphinho/work-plan.json
 * 6. Prints summary
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  detectAgents,
  ensureJjAvailable,
  getRalphDir,
  scanRepo,
  type ParsedArgs,
} from "./shared";
import { decomposeRFC, printPlanSummary } from "../scheduled/decompose";
import type { RalphinhoConfig } from "../scheduled/types";

export async function initScheduledWork(opts: {
  positional: string[];
  flags: ParsedArgs["flags"];
  repoRoot: string;
}): Promise<void> {
  const { positional, flags, repoRoot } = opts;

  console.log("🗂️  ralphinho — Scheduled Work Mode\n");

  // ── Read RFC file ───────────────────────────────────────────────────
  const rfcArg = positional[0];
  if (!rfcArg) {
    console.error("Error: RFC file path is required.");
    console.error("Usage: ralphinho init scheduled-work ./path/to/rfc.md");
    process.exit(1);
  }

  const rfcPath = resolve(repoRoot, rfcArg);
  if (!existsSync(rfcPath)) {
    console.error(`Error: RFC file not found: ${rfcPath}`);
    process.exit(1);
  }

  const rfcContent = await readFile(rfcPath, "utf8");
  console.log(`  RFC: ${rfcPath}`);
  console.log(`  Repo: ${repoRoot}`);

  // ── Check prerequisites ─────────────────────────────────────────────
  await ensureJjAvailable(repoRoot);

  // ── Scan repo ───────────────────────────────────────────────────────
  const repoConfig = await scanRepo(repoRoot);
  console.log(`  Project: ${repoConfig.projectName}`);
  console.log(`  Package manager: ${repoConfig.runner}`);

  if (Object.keys(repoConfig.buildCmds).length > 0) {
    console.log(
      `  Build: ${Object.values(repoConfig.buildCmds).join(", ")}`,
    );
  }
  if (Object.keys(repoConfig.testCmds).length > 0) {
    console.log(
      `  Test: ${Object.values(repoConfig.testCmds).join(", ")}`,
    );
  }

  // ── Detect agents ───────────────────────────────────────────────────
  const agents = await detectAgents(repoRoot);
  console.log(
    `  Agents: claude=${agents.claude} codex=${agents.codex}`,
  );

  if (!agents.claude && !agents.codex) {
    console.error(
      "\nError: No supported agent CLI detected. Install claude and/or codex.",
    );
    process.exit(1);
  }

  // ── Decompose RFC ───────────────────────────────────────────────────
  console.log();
  const { plan, layers } = await decomposeRFC(rfcContent, repoConfig);
  plan.source = rfcPath;

  printPlanSummary(plan, layers);

  // ── Write outputs ───────────────────────────────────────────────────
  const ralphDir = getRalphDir(repoRoot);
  await mkdir(ralphDir, { recursive: true });

  const maxConcurrency =
    typeof flags["max-concurrency"] === "string"
      ? Math.max(1, Number(flags["max-concurrency"]) || 6)
      : 6;

  const config: RalphinhoConfig = {
    mode: "scheduled-work",
    repoRoot,
    rfcPath,
    agents,
    maxConcurrency,
    createdAt: new Date().toISOString(),
  };

  const configPath = join(ralphDir, "config.json");
  const planPath = join(ralphDir, "work-plan.json");

  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  await writeFile(planPath, JSON.stringify(plan, null, 2) + "\n", "utf8");

  console.log(`  Written:`);
  console.log(`    ${configPath}`);
  console.log(`    ${planPath}`);
  console.log();
  console.log(
    `  Review and edit ${planPath} if needed, then run:`,
  );
  console.log(`    ralphinho run`);
  console.log();

  if (flags["dry-run"]) {
    console.log("  (dry-run: workflow not executed)\n");
    return;
  }
}
