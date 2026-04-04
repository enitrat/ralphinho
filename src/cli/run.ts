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
import { createLogger } from "../runtime/logger";

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
import {
  pushFindingsToLinear,
  consumeTicket,
  consumeAllTickets,
  markTicketInProgress,
  markTicketDone,
} from "../adapters/linear";
import {
  groupByFileOverlap,
  groupToWorkPlan,
} from "../workflows/ralphinho/scheduler";
import { Database } from "bun:sqlite";

const log = createLogger({ context: { phase: "cli" } });

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
    log.error("Error: --linear requires --team <team-id> or LINEAR_TEAM_ID env var.");
    process.exit(1);
  }

  // Build Linear options (undefined when --linear is not set)
  const linearOpts = linearEnabled && linearTeamId
    ? { teamId: linearTeamId, label: linearLabel, minPriority: linearMinPriority }
    : undefined;

  // ── Linear consume-ticket path (scheduled-work only) ──────────────
  const linearBatch = flags.batch === true;
  if (linearOpts && !existsSync(configPath)) {
    if (linearBatch) {
      return runBatchFromLinear({ repoRoot, ralphDir, linearOpts, force, flags });
    }
    // No config yet — attempt to consume a Linear ticket and auto-init
    return runFromLinearTicket({ repoRoot, ralphDir, linearOpts, force, flags });
  }

  // ── Load config ─────────────────────────────────────────────────────
  if (!existsSync(configPath)) {
    log.error(
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
    log.error(
      "Error: Could not find smithers CLI. Install smithers-orchestrator:\n  bun add smithers-orchestrator",
    );
    process.exit(1);
  }

  const maxConcurrency = parseMaxConcurrency(flags, config.maxConcurrency);

  // ── Execute scheduled work ──────────────────────────────────────────
  const planFileName = config.mode === "review-discovery"
    ? "review-plan.json"
    : "work-plan.json";
  const planPath = join(ralphDir, planFileName);
  if (!existsSync(planPath)) {
    log.error(
      `Error: No ${planFileName} found. Run \`ralphinho plan\` or \`ralphinho init\` first.`,
    );
    process.exit(1);
  }

  const dbPath = join(ralphDir, "smithers.db");
  const workflowPath = getRalphinhoPresetPath(config.mode);
  const envOverrides = buildPresetEnv(ralphDir, dbPath, planPath);

  if (!existsSync(workflowPath)) {
    log.error(
      `Error: Built-in preset not found at ${workflowPath}. Reinstall super-ralph and try again.`,
    );
    process.exit(1);
  }

  // ── Resume path ─────────────────────────────────────────────────────
  if (resumeRunId) {
    if (!existsSync(dbPath)) {
      log.error("Error: No database found. Cannot resume.");
      process.exit(1);
    }
    log.info(`Attempting to resume run ${resumeRunId}...\n`);

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
        log.error("Error: Could not find a run ID to resume in the database.");
        process.exit(1);
      }
      log.info(`Attempting to resume run ${latestRunId} (--force)...\n`);
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

    log.info("Found an existing scheduled-work run.\n");
    const options = ["Start fresh (new run ID)", "Resume previous run", "Cancel"];

    const choice = await promptChoice("What would you like to do?", options);

    if (choice === 1) {
      const latestRunId = resolveLatestRunId(dbPath);
      if (!latestRunId) {
        log.error("Error: Could not find a run ID to resume in the database.");
        process.exit(1);
      }
      log.info(`Attempting to resume run ${latestRunId}...\n`);
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

  log.info(`\n🚀 ralphinho — ${config.mode === "review-discovery" ? "Review Discovery" : "Scheduled Work"}\n`);
  if (config.mode === "scheduled-work") {
    log.info(`  RFC: ${config.rfcPath}`);
    log.info(`  Work units: ${unitCount}`);
  } else {
    const reviewPlan = JSON.parse(await readFile(planPath, "utf8"));
    log.info(`  Instruction: ${config.reviewInstruction}`);
    log.info(`  Review slices: ${reviewPlan.slices?.length ?? 0}`);
  }
  log.info(`  Max concurrency: ${maxConcurrency}`);
  const agentOverride = config.mode === "review-discovery"
    ? config.reviewAgentOverride
    : config.mode === "scheduled-work"
      ? config.agentOverride
      : null;
  if (agentOverride) {
    log.info(`  Agent: ${agentOverride}`);
  } else {
    log.info(`  Agents: claude=${config.agents.claude} codex=${config.agents.codex}`);
  }
  if (linearOpts) {
    log.info(`  Linear: team=${linearOpts.teamId} label=${linearOpts.label}\n`);
  }

  if (!force) {
    const confirmChoice = await promptChoice(
      config.mode === "review-discovery"
        ? "Execute review discovery workflow?"
        : `Execute ${unitCount} work units?`,
      ["Yes, start", "No, cancel"],
    );
    if (confirmChoice !== 0) {
      log.info("Cancelled.\n");
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

  log.info(`🎬 ${label} — Starting execution...`);
  if (launchOpts.runId) {
    log.info(`  Run ID: ${launchOpts.runId}`);
  }
  log.info("");

  const exitCode = await launchSmithers(launchOpts);

  if (exitCode === 0 && opts.configMode === "review-discovery") {
    await projectReviewArtifacts(opts.repoRoot);

    // Push findings to Linear if enabled
    if (linear) {
      log.info("\n📤 Pushing findings to Linear...\n");
      const dbPath = join(getRalphDir(opts.repoRoot), "smithers.db");
      const result = await pushFindingsToLinear({
        dbPath,
        teamId: linear.teamId,
        minPriority: linear.minPriority,
      });
      log.info(
        `\n  Linear: ${result.created.length} issues created, ${result.skipped} skipped.`,
      );
    }
  }

  // Mark Linear ticket done after successful scheduled-work
  if (exitCode === 0 && opts.configMode === "scheduled-work" && linear?.issueId) {
    log.info("\n📤 Updating Linear ticket...\n");
    await markTicketDone({
      issueId: linear.issueId,
      teamId: linear.teamId,
      summary: `Completed by ralphinho run ${launchOpts.runId ?? "unknown"}.`,
    });
    log.info("  Linear ticket marked as done.");
  }

  reportExit(exitCode, label);
}

function reportExit(exitCode: number, label: string): void {
  if (exitCode === 0) {
    log.info(`\n✅ ${label} completed successfully!\n`);
  } else {
    log.error(`\n❌ ${label} exited with code ${exitCode}\n`);
    process.exit(exitCode);
  }
}

function parseMaxConcurrency(
  flags: ParsedArgs["flags"],
  fallback: number,
): number {
  return typeof flags["max-concurrency"] === "string"
    ? Math.max(1, Number(flags["max-concurrency"]) || fallback)
    : fallback;
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

  log.info("🔍 Fetching approved ticket from Linear...\n");

  const ticket = await consumeTicket({
    teamId: linearOpts.teamId,
    label: linearOpts.label,
  });

  if (!ticket) {
    log.info("  No approved tickets found in Linear. Nothing to do.\n");
    return;
  }

  log.info(`  Found: ${ticket.issue.identifier} — ${ticket.issue.title}`);
  log.info(`  Priority: ${ticket.issue.priorityLabel}\n`);

  // Mark in-progress
  await markTicketInProgress({
    issueId: ticket.issue.id,
    teamId: linearOpts.teamId,
  });

  // Write RFC content to a temp file and run init
  await mkdir(ralphDir, { recursive: true });
  const rfcPath = join(ralphDir, "linear-task.md");
  await writeFile(rfcPath, ticket.rfcContent, "utf8");
  log.info(`  Written RFC: ${rfcPath}`);

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
    log.error("Error: init-scheduled failed to create config.");
    process.exit(1);
  }

  const config = ralphinhoConfigSchema.parse(
    JSON.parse(await readFile(configPath, "utf8")),
  );

  const smithersCliPath = resolveSmithersCliPath(join(repoRoot, "package.json"));
  if (!smithersCliPath) {
    log.error("Error: Could not find smithers CLI.");
    process.exit(1);
  }

  const maxConcurrency = parseMaxConcurrency(flags, config.maxConcurrency);

  const planPath = join(ralphDir, "work-plan.json");
  const dbPath = join(ralphDir, "smithers.db");
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

/**
 * Consume all actionable tickets from Linear, group by file overlap,
 * and run each group sequentially via Smithers with landingMode: "pr".
 */
export async function runBatchFromLinear(opts: {
  repoRoot: string;
  ralphDir: string;
  linearOpts: {
    teamId: string;
    label: string;
    minPriority?: "critical" | "high" | "medium" | "low";
  };
  force: boolean;
  flags: ParsedArgs["flags"];
}): Promise<void> {
  const { repoRoot, ralphDir, linearOpts, force, flags } = opts;

  log.info("🔍 Fetching all approved tickets from Linear...\n");

  const { tickets, unparseable } = await consumeAllTickets({
    teamId: linearOpts.teamId,
    label: linearOpts.label,
  });

  if (tickets.length === 0 && unparseable.length === 0) {
    log.info("  No approved tickets found. Nothing to do.\n");
    return;
  }

  if (tickets.length === 0) {
    log.info(
      "  No parseable tickets found (all tickets lack metadata). Nothing to do.\n",
    );
    return;
  }

  // Log unparseable tickets
  if (unparseable.length > 0) {
    log.info(
      `  ⚠️  Skipping ${unparseable.length} unparseable ticket(s):`,
    );
    for (const t of unparseable) {
      log.info(`    - ${t.issue.identifier}: ${t.issue.title}`);
    }
    log.info("");
  }

  log.info(`  Found ${tickets.length} parseable ticket(s).\n`);

  // Group by file overlap
  const groups = groupByFileOverlap(tickets);

  // Log grouping plan
  log.info(`  📋 Batch plan: ${groups.length} group(s)\n`);
  for (const group of groups) {
    const ticketIds = group.tickets
      .map((t) => t.issue.identifier)
      .join(", ");
    log.info(`    ${group.id}: files=[${group.files.join(", ")}] tickets=[${ticketIds}]`);
  }
  log.info("");

  // Mark all parseable tickets in-progress before executing groups
  await Promise.all(
    tickets.map((ticket) =>
      markTicketInProgress({
        issueId: ticket.issue.id,
        teamId: linearOpts.teamId,
      }),
    ),
  );

  // Find Smithers
  const smithersCliPath = resolveSmithersCliPath(
    join(repoRoot, "package.json"),
  );
  if (!smithersCliPath) {
    log.error("Error: Could not find smithers CLI.");
    process.exit(1);
  }

  // Scan repo for build/test commands
  const { scanRepo } = await import("./shared");
  const repoConfig = await scanRepo(repoRoot);

  // Ensure ralphDir exists before writing group artifacts
  await mkdir(ralphDir, { recursive: true });

  // Execute groups sequentially
  for (const group of groups) {
    log.info(`\n🚀 Executing ${group.id}...\n`);

    const workPlan = groupToWorkPlan(group, repoConfig);

    // Write group-specific plan
    const planPath = join(ralphDir, `batch-plan-${group.id}.json`);
    await writeFile(planPath, JSON.stringify(workPlan, null, 2), "utf8");

    // Synthesize a minimal config.json for the Smithers subprocess.
    // loadScheduledPreset() reads landingMode from this file.
    const batchConfigPath = join(ralphDir, "config.json");
    await writeFile(
      batchConfigPath,
      JSON.stringify(
        {
          mode: "scheduled-work",
          repoRoot,
          rfcPath: planPath,
          baseBranch: "main",
          landingMode: "pr",
          agentOverride: null,
          agents: { claude: true, codex: true, gh: false },
          maxConcurrency: parseMaxConcurrency(flags, 4),
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );

    const dbPath = join(ralphDir, `batch-${group.id}.db`);
    const workflowPath = getRalphinhoPresetPath("scheduled-work");
    const envOverrides = buildPresetEnv(ralphDir, dbPath, planPath);

    const runId = `sw-batch-${group.id}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;

    const maxConcurrency = parseMaxConcurrency(flags, 4);

    const exitCode = await launchSmithers({
      mode: "run",
      workflowPath,
      repoRoot,
      runId,
      maxConcurrency,
      smithersCliPath,
      envOverrides,
      force,
    });

    if (exitCode === 0) {
      log.info(`  ✅ ${group.id} completed successfully.`);
      // Mark this group's tickets as done
      for (const ticket of group.tickets) {
        await markTicketDone({
          issueId: ticket.issue.id,
          teamId: linearOpts.teamId,
          summary: `Completed by batch run ${runId}.`,
        });
      }
    } else {
      log.error(
        `  ❌ ${group.id} failed (exit ${exitCode}). Tickets remain in-progress.`,
      );
      // Continue to next group — failed group tickets stay in-progress
    }
  }

  log.info("\n🏁 Batch execution complete.\n");
}

async function projectReviewArtifacts(repoRoot: string): Promise<void> {
  const dbPath = join(getRalphDir(repoRoot), "smithers.db");
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
