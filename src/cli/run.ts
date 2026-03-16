/**
 * ralphinho run — Execute or resume a scheduled workflow.
 *
 * Reads .ralphinho/config.json and launches the built-in preset
 * against the target repo's config/work-plan/database files.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  getRalphinhoPresetPath,
  getRalphDir,
  promptChoice,
  type ParsedArgs,
} from "./shared";
import { ralphinhoConfigSchema } from "../config/types";
import {
  launchSmithers,
  resolveSmithersCliPath,
} from "../runtime/smithers-launch";
import {
  projectReviewSummaryFromDb,
  resolveLatestReviewRunId,
} from "../workflows/improvinho/projection";
import { pushFindingsToLinear } from "../adapters/linear/push-findings";
import {
  consumeTicket,
  markTicketInProgress,
  markTicketDone,
} from "../adapters/linear/consume-tickets";
import { Database } from "bun:sqlite";

function resolveLatestRunId(dbPath: string): string | null {
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.prepare(
        "SELECT run_id FROM _smithers_runs ORDER BY created_at_ms DESC LIMIT 1",
      ).get() as { run_id?: string } | undefined;
      return row?.run_id ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

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
  const linearEnabled = flags.linear === true;
  const linearTeamId = typeof flags.team === "string" ? flags.team : (process.env.LINEAR_TEAM_ID ?? null);
  const linearLabel = typeof flags.label === "string" ? flags.label : (process.env.LINEAR_LABEL ?? "ralph-approved");
  const linearMinPriority = typeof flags["min-priority"] === "string"
    ? flags["min-priority"] as "critical" | "high" | "medium" | "low"
    : undefined;

  if (linearEnabled && !linearTeamId) {
    console.error("Error: --linear requires --team <team-id> or LINEAR_TEAM_ID env var.");
    process.exit(1);
  }

  // Build Linear options (undefined when --linear is not set)
  const linearOpts = linearEnabled && linearTeamId
    ? { teamId: linearTeamId, label: linearLabel, minPriority: linearMinPriority }
    : undefined;

  // ── Linear consume-ticket path (scheduled-work only) ──────────────
  if (linearOpts && !existsSync(configPath)) {
    // No config yet — attempt to consume a Linear ticket and auto-init
    return runFromLinearTicket({ repoRoot, ralphDir, linearOpts, force, flags });
  }

  // ── Load config ─────────────────────────────────────────────────────
  if (!existsSync(configPath)) {
    console.error(
      "Error: No workflow initialized. Run `ralphinho init` first.",
    );
    process.exit(1);
  }

  const config = ralphinhoConfigSchema.parse(
    JSON.parse(await readFile(configPath, "utf8")),
  );

  // ── Find Smithers ───────────────────────────────────────────────────
  const smithersCliPath = resolveSmithersCliPath(join(repoRoot, "package.json"));
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
  const planFileName = config.mode === "review-discovery"
    ? "review-plan.json"
    : "work-plan.json";
  const planPath = join(ralphDir, planFileName);
  if (!existsSync(planPath)) {
    console.error(
      `Error: No ${planFileName} found. Run \`ralphinho plan\` or \`ralphinho init\` first.`,
    );
    process.exit(1);
  }

  const dbPath = join(ralphDir, "workflow.db");
  const workflowPath = getRalphinhoPresetPath(config.mode);
  const envOverrides = buildPresetEnv(ralphDir, dbPath, planPath);

  if (!existsSync(workflowPath)) {
    console.error(
      `Error: Built-in preset not found at ${workflowPath}. Reinstall super-ralph and try again.`,
    );
    process.exit(1);
  }

  // ── Resume path ─────────────────────────────────────────────────────
  if (resumeRunId) {
    if (!existsSync(dbPath)) {
      console.error("Error: No database found. Cannot resume.");
      process.exit(1);
    }
    console.log(`Attempting to resume run ${resumeRunId}...\n`);

    return launchAndReport({
      mode: "resume",
      workflowPath,
      runId: resumeRunId,
      maxConcurrency,
      smithersCliPath,
      envOverrides,
      label: config.mode === "review-discovery" ? "Review Discovery (resume)" : "Scheduled Work (resume)",
      force,
      repoRoot,
      configMode: config.mode,
      linear: linearOpts,
    });
  }

  // ── Check for existing run ──────────────────────────────────────────
  if (existsSync(dbPath)) {
    // --force: auto-resume latest run without prompting
    if (force) {
      const latestRunId = resolveLatestRunId(dbPath);
      if (!latestRunId) {
        console.error("Error: Could not find a run ID to resume in the database.");
        process.exit(1);
      }
      console.log(`Attempting to resume run ${latestRunId} (--force)...\n`);
      return launchAndReport({
        mode: "resume",
        workflowPath,
        runId: latestRunId,
        maxConcurrency,
        smithersCliPath,
        envOverrides,
        label: config.mode === "review-discovery" ? "Review Discovery (resume --force)" : "Scheduled Work (resume --force)",
        force,
        repoRoot,
        configMode: config.mode,
        linear: linearOpts,
      });
    }

    console.log("Found an existing scheduled-work run.\n");
    const options = ["Start fresh (new run ID)", "Resume previous run", "Cancel"];

    const choice = await promptChoice("What would you like to do?", options);

    if (choice === 1) {
      const latestRunId = resolveLatestRunId(dbPath);
      if (!latestRunId) {
        console.error("Error: Could not find a run ID to resume in the database.");
        process.exit(1);
      }
      console.log(`Attempting to resume run ${latestRunId}...\n`);
      return launchAndReport({
        mode: "resume",
        workflowPath,
        runId: latestRunId,
        maxConcurrency,
        smithersCliPath,
        envOverrides,
        label: config.mode === "review-discovery" ? "Review Discovery (resume)" : "Scheduled Work (resume)",
        repoRoot,
        configMode: config.mode,
        linear: linearOpts,
      });
    }
    if (choice === 2) {
      process.exit(0);
    }
    // choice 0: fall through to fresh run
  }

  // ── Confirm before running ──────────────────────────────────────────
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  const unitCount = plan.units?.length ?? 0;

  console.log(`\n🚀 ralphinho — ${config.mode === "review-discovery" ? "Review Discovery" : "Scheduled Work"}\n`);
  if (config.mode === "scheduled-work") {
    console.log(`  RFC: ${config.rfcPath}`);
    console.log(`  Work units: ${unitCount}`);
  } else {
    const reviewPlan = JSON.parse(await readFile(planPath, "utf8"));
    console.log(`  Instruction: ${config.reviewInstruction}`);
    console.log(`  Review slices: ${reviewPlan.slices?.length ?? 0}`);
  }
  console.log(`  Max concurrency: ${maxConcurrency}`);
  console.log(`  Agents: claude=${config.agents.claude} codex=${config.agents.codex}\n`);
  if (linearOpts) {
    console.log(`  Linear: team=${linearOpts.teamId} label=${linearOpts.label}\n`);
  }

  if (!force) {
    const confirmChoice = await promptChoice(
      config.mode === "review-discovery"
        ? "Execute review discovery workflow?"
        : `Execute ${unitCount} work units?`,
      ["Yes, start", "No, cancel"],
    );
    if (confirmChoice !== 0) {
      console.log("Cancelled.\n");
      process.exit(0);
    }
  }

  const runId = `${config.mode === "review-discovery" ? "rv" : "sw"}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;

  return launchAndReport({
    mode: "run",
    workflowPath,
    runId,
    maxConcurrency,
    smithersCliPath,
    envOverrides,
    label: config.mode === "review-discovery" ? "Review Discovery" : "Scheduled Work",
    force,
    repoRoot,
    configMode: config.mode,
    linear: linearOpts,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────

async function launchAndReport(opts: {
  mode: "run" | "resume";
  workflowPath: string;
  repoRoot: string;
  runId?: string;
  maxConcurrency: number;
  smithersCliPath: string;
  envOverrides?: Record<string, string>;
  label: string;
  force?: boolean;
  configMode: "scheduled-work" | "review-discovery";
  linear?: {
    teamId: string;
    label: string;
    minPriority?: "critical" | "high" | "medium" | "low";
    issueId?: string; // populated when consuming a ticket
  };
}): Promise<void> {
  const { label, configMode: _configMode, linear, ...launchOpts } = opts;

  console.log(`🎬 ${label} — Starting execution...`);
  if (launchOpts.runId) {
    console.log(`  Run ID: ${launchOpts.runId}`);
  }
  console.log();

  const exitCode = await launchSmithers(launchOpts);

  if (exitCode === 0 && opts.configMode === "review-discovery") {
    await projectReviewArtifacts(opts.repoRoot);

    // Push findings to Linear if enabled
    if (linear) {
      console.log("\n📤 Pushing findings to Linear...\n");
      const dbPath = join(getRalphDir(opts.repoRoot), "workflow.db");
      const result = await pushFindingsToLinear({
        dbPath,
        teamId: linear.teamId,
        minPriority: linear.minPriority,
      });
      console.log(
        `\n  Linear: ${result.created.length} issues created, ${result.skipped} skipped.`,
      );
    }
  }

  // Mark Linear ticket done after successful scheduled-work
  if (exitCode === 0 && opts.configMode === "scheduled-work" && linear?.issueId) {
    console.log("\n📤 Updating Linear ticket...\n");
    await markTicketDone({
      issueId: linear.issueId,
      summary: `Completed by ralphinho run ${launchOpts.runId ?? "unknown"}.`,
    });
    console.log("  Linear ticket marked as done.");
  }

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

function buildPresetEnv(
  ralphDir: string,
  dbPath: string,
  planPath: string,
): Record<string, string> {
  return {
    RALPHINHO_DIR: ralphDir,
    RALPHINHO_CONFIG_PATH: join(ralphDir, "config.json"),
    RALPHINHO_PLAN_PATH: planPath,
    RALPHINHO_DB_PATH: dbPath,
  };
}

/**
 * Consume a ticket from Linear, auto-init scheduled-work, and run.
 * Used when `--linear` is passed but no config exists yet.
 */
async function runFromLinearTicket(opts: {
  repoRoot: string;
  ralphDir: string;
  linearOpts: { teamId: string; label: string; minPriority?: "critical" | "high" | "medium" | "low" };
  force: boolean;
  flags: ParsedArgs["flags"];
}): Promise<void> {
  const { repoRoot, ralphDir, linearOpts, force, flags } = opts;

  console.log("🔍 Fetching approved ticket from Linear...\n");

  const ticket = await consumeTicket({
    teamId: linearOpts.teamId,
    label: linearOpts.label,
  });

  if (!ticket) {
    console.log("  No approved tickets found in Linear. Nothing to do.\n");
    return;
  }

  console.log(`  Found: ${ticket.issue.identifier} — ${ticket.issue.title}`);
  console.log(`  Priority: ${ticket.issue.priorityLabel}\n`);

  // Mark in-progress
  await markTicketInProgress({
    issueId: ticket.issue.id,
    teamId: linearOpts.teamId,
  });

  // Write RFC content to a temp file and run init
  await mkdir(ralphDir, { recursive: true });
  const rfcPath = join(ralphDir, "linear-task.md");
  await writeFile(rfcPath, ticket.rfcContent, "utf8");
  console.log(`  Written RFC: ${rfcPath}`);

  // Run init-scheduled programmatically
  const { initScheduledWork } = await import("./init-scheduled");
  await initScheduledWork({
    positional: [rfcPath],
    flags: { ...flags, "dry-run": true },
    repoRoot,
  });

  // Now load the config and launch
  const configPath = join(ralphDir, "config.json");
  if (!existsSync(configPath)) {
    console.error("Error: init-scheduled failed to create config.");
    process.exit(1);
  }

  const config = ralphinhoConfigSchema.parse(
    JSON.parse(await readFile(configPath, "utf8")),
  );

  const smithersCliPath = resolveSmithersCliPath(join(repoRoot, "package.json"));
  if (!smithersCliPath) {
    console.error("Error: Could not find smithers CLI.");
    process.exit(1);
  }

  const maxConcurrency =
    typeof flags["max-concurrency"] === "string"
      ? Math.max(1, Number(flags["max-concurrency"]) || config.maxConcurrency)
      : config.maxConcurrency;

  const planPath = join(ralphDir, "work-plan.json");
  const dbPath = join(ralphDir, "workflow.db");
  const workflowPath = getRalphinhoPresetPath(config.mode);
  const envOverrides = buildPresetEnv(ralphDir, dbPath, planPath);

  const runId = `sw-lin-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;

  return launchAndReport({
    mode: "run",
    workflowPath,
    runId,
    maxConcurrency,
    smithersCliPath,
    envOverrides,
    label: `Scheduled Work (Linear: ${ticket.issue.identifier})`,
    force,
    repoRoot,
    configMode: "scheduled-work",
    linear: {
      ...linearOpts,
      issueId: ticket.issue.id,
    },
  });
}

async function projectReviewArtifacts(repoRoot: string): Promise<void> {
  const dbPath = join(getRalphDir(repoRoot), "workflow.db");
  if (!existsSync(dbPath)) return;

  const db = new Database(dbPath, { readonly: true });

  try {
    const runId = resolveLatestReviewRunId(db);
    if (!runId) return;
    await projectReviewSummaryFromDb({ repoRoot, db, runId });
  } finally {
    db.close();
  }
}
