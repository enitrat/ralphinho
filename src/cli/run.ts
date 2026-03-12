/**
 * ralphinho run — Execute or resume a scheduled workflow.
 *
 * Reads .ralphinho/config.json and the generated workflow file,
 * then launches execution.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  findSmithersCliPath,
  getRalphDir,
  launchSmithers,
  promptChoice,
  type ParsedArgs,
} from "./shared";
import { ralphinhoConfigSchema, type RalphinhoConfig } from "../scheduled/types";

export async function runWorkflow(opts: {
  flags: ParsedArgs["flags"];
  repoRoot: string;
}): Promise<void> {
  const { flags, repoRoot } = opts;
  const ralphDir = getRalphDir(repoRoot);
  const configPath = join(ralphDir, "config.json");

  const resumeRunId =
    typeof flags.resume === "string" ? flags.resume : null;
  const force = flags.force === true;

  // ── Load config ─────────────────────────────────────────────────────
  if (!existsSync(configPath)) {
    console.error(
      "Error: No workflow initialized. Run `ralphinho init` first.",
    );
    process.exit(1);
  }

  const config: RalphinhoConfig = ralphinhoConfigSchema.parse(
    JSON.parse(await readFile(configPath, "utf8")),
  );

  // ── Find Smithers ───────────────────────────────────────────────────
  const smithersCliPath = findSmithersCliPath(repoRoot);
  if (!smithersCliPath) {
    console.error(
      "Error: Could not find smithers CLI. Install smithers-orchestrator:\n  bun add smithers-orchestrator",
    );
    process.exit(1);
  }

  const maxConcurrency =
    typeof flags["max-concurrency"] === "string"
      ? Math.max(1, Number(flags["max-concurrency"]) || config.maxConcurrency)
      : config.maxConcurrency;

  // ── Execute scheduled work ──────────────────────────────────────────
  const planPath = join(ralphDir, "work-plan.json");
  if (!existsSync(planPath)) {
    console.error(
      "Error: No work plan found. Run `ralphinho plan` or `ralphinho init` first.",
    );
    process.exit(1);
  }

  const dbPath = join(ralphDir, "workflow.db");
  const generatedDir = join(ralphDir, "generated");
  const workflowPath = join(generatedDir, "workflow.tsx");

  if (!existsSync(workflowPath)) {
    console.error(
      "Error: No workflow file found. Run `ralphinho init` first.",
    );
    process.exit(1);
  }

  // ── Resume path ─────────────────────────────────────────────────────
  if (resumeRunId) {
    if (!existsSync(dbPath)) {
      console.error("Error: No database found. Cannot resume.");
      process.exit(1);
    }

    return launchAndReport({
      mode: "resume",
      workflowPath,
      repoRoot,
      runId: resumeRunId,
      maxConcurrency,
      smithersCliPath,
      label: "Scheduled Work (resume)",
      force,
    });
  }

  // ── Check for existing run ──────────────────────────────────────────
  if (existsSync(workflowPath) && existsSync(dbPath)) {
    const latestRunId = getLatestRunId(dbPath);

    // --force: auto-resume latest run without prompting
    if (force && latestRunId) {
      return launchAndReport({
        mode: "resume",
        workflowPath,
        repoRoot,
        runId: latestRunId,
        maxConcurrency,
        smithersCliPath,
        label: "Scheduled Work (resume --force)",
        force,
      });
    }

    console.log("Found an existing scheduled-work run.\n");
    const options = [
      "Start fresh (new run ID)",
    ];
    if (latestRunId) {
      options.push(`Resume previous run (${latestRunId})`);
    }
    options.push("Cancel");

    const choice = await promptChoice("What would you like to do?", options);

    if (choice === 1 && latestRunId) {
      return launchAndReport({
        mode: "resume",
        workflowPath,
        repoRoot,
        runId: latestRunId,
        maxConcurrency,
        smithersCliPath,
        label: "Scheduled Work (resume)",
      });
    }
    if (
      (choice === 2 && latestRunId) ||
      (choice === 1 && !latestRunId)
    ) {
      process.exit(0);
    }
    // choice 0: fall through to fresh run
  }

  // ── Confirm before running ──────────────────────────────────────────
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  const unitCount = plan.units?.length ?? 0;

  console.log(`\n🚀 ralphinho — Scheduled Work\n`);
  console.log(`  RFC: ${config.rfcPath}`);
  console.log(`  Work units: ${unitCount}`);
  console.log(`  Max concurrency: ${maxConcurrency}`);
  console.log(`  Agents: claude=${config.agents.claude} codex=${config.agents.codex}\n`);

  const confirmChoice = await promptChoice(
    `Execute ${unitCount} work units?`,
    ["Yes, start", "No, cancel"],
  );
  if (confirmChoice !== 0) {
    console.log("Cancelled.\n");
    process.exit(0);
  }

  const runId = `sw-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;

  return launchAndReport({
    mode: "run",
    workflowPath,
    repoRoot,
    runId,
    maxConcurrency,
    smithersCliPath,
    label: "Scheduled Work",
    force,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────

async function launchAndReport(opts: {
  mode: "run" | "resume";
  workflowPath: string;
  repoRoot: string;
  runId: string;
  maxConcurrency: number;
  smithersCliPath: string;
  label: string;
  force?: boolean;
}): Promise<void> {
  const { label, ...launchOpts } = opts;

  console.log(`🎬 ${label} — Starting execution...`);
  console.log(`  Run ID: ${launchOpts.runId}\n`);

  const exitCode = await launchSmithers(launchOpts);
  reportExit(exitCode, label);
}

function reportExit(exitCode: number, label: string): void {
  if (exitCode === 0) {
    console.log(`\n✅ ${label} completed successfully!\n`);
  } else {
    console.error(`\n❌ ${label} exited with code ${exitCode}\n`);
    process.exit(exitCode);
  }
}

function getLatestRunId(dbPath: string): string | null {
  try {
    const { Database } = require("bun:sqlite");
    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare(
        `SELECT run_id FROM _smithers_runs ORDER BY rowid DESC LIMIT 1`,
      )
      .get() as { run_id: string } | null;
    db.close();
    return row?.run_id ?? null;
  } catch {
    return null;
  }
}
