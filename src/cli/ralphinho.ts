#!/usr/bin/env bun
/**
 * ralphinho — RFC-driven AI development workflow CLI
 *
 * Commands:
 *   ralphinho init ./rfc.md            Initialize scheduled-work from RFC
 *   ralphinho init review "<prompt>"   Initialize review-discovery mode
 *   ralphinho plan                     (Re)generate work plan from RFC
 *   ralphinho run                      Execute the initialized workflow
 *   ralphinho run --resume <run-id>    Resume a previous run
 *   ralphinho run --force              Attempt resume without prompts
 *   ralphinho monitor --run-id <id>    Attach TUI to a workflow run
 *   ralphinho status                   Show current state
 */

import { join, resolve } from "node:path";
import { parseArgs, getRalphDir } from "./shared";
import { createLogger } from "../runtime/logger";

const log = createLogger({ context: { phase: "cli" } });

function printHelp() {
  log.info(`ralphinho — RFC-driven AI development workflow CLI

Usage:
  ralphinho init ./rfc-003.md
  ralphinho init review "Review src/api/auth for bugs and security issues" --paths src/api/auth
  ralphinho init review "Review packages/app logic" --paths packages/app --agent sonnet
  ralphinho init bugfinder "Find bugs and improvements" --paths src/

  ralphinho plan                             (Re)generate work plan from RFC
  ralphinho run                              Execute the initialized workflow
  ralphinho run --resume <run-id>            Resume a previous run
  ralphinho run --force                      Attempt resume without prompts
  ralphinho monitor --run-id <run-id>        Attach TUI to a workflow run
  ralphinho status                           Show current state
  ralphinho scores <run-id>                  Show aggregated scorer results
  smithers replay <run-id> [--frame N]      Replay a run (use smithers CLI directly)
  smithers diff <a> <b> [--json]            Diff two snapshots (use smithers CLI directly)

Global Options:
  --cwd <path>                Repo root (default: current directory)
  --max-concurrency <n>       Max parallel work units (default: 6)
  --force                     Skip prompts and attempt resume
  --prometheus-port <port>    Start Prometheus /metrics server on <port>
  --skip-diagnostics          Skip pre-flight agent diagnostics
  --help                      Show this help

Linear Integration:
  --linear                    Enable Linear integration (requires LINEAR_API_KEY)
  --team <id>                 Linear team ID (required with --linear)
  --label <name>              Linear label filter (default: "ralph-approved")
  --min-priority <level>      Minimum priority to push (critical|high|medium|low)
  --batch                     Consume all approved tickets, group by file overlap, run sequentially

Init Options:
  --dry-run                   Generate work plan but don't execute
  --agent <sonnet|opus|codex> Override agent for all workflow roles

Examples:
  ralphinho init ./docs/rfc-003.md
  ralphinho init review "Review the cache layer" --paths src/cache src/lib/cache.ts
  ralphinho init review "Review packages/app logic" --paths packages/app --agent codex
  ralphinho plan
  ralphinho run
  ralphinho run --force
  ralphinho run --resume sw-m3abc12-deadbeef
  # Linear integration
  ralphinho run --linear --team <team-id>              # improvinho: push findings to Linear
  ralphinho run --linear --team <team-id> --label approved   # ralphinho: consume from Linear
  ralphinho run --linear --team <team-id> --batch            # batch: consume all tickets, group & run
`);
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.flags.help) {
    printHelp();
    process.exit(0);
  }

  const repoRoot = resolve(
    typeof parsed.flags.cwd === "string"
      ? parsed.flags.cwd
      : process.cwd(),
  );

  const command = parsed.positional[0];

  switch (command) {
    case "init": {
      const initMode = parsed.positional[1];

      if (initMode === "review") {
        const { initReviewDiscovery } = await import("./init-review");
        return initReviewDiscovery({
          positional: parsed.positional.slice(2),
          flags: parsed.flags,
          repoRoot,
        });
      }

      if (initMode === "bugfinder") {
        const { initBugfinder } = await import("./init-bugfinder");
        return initBugfinder({
          positional: parsed.positional.slice(2),
          flags: parsed.flags,
          repoRoot,
        });
      }

      if (initMode === "scheduled-work") {
        const { initScheduledWork } = await import("./init-scheduled");
        return initScheduledWork({
          positional: parsed.positional.slice(2),
          flags: parsed.flags,
          repoRoot,
        });
      }

      const { initScheduledWork } = await import("./init-scheduled");
      return initScheduledWork({
        positional: parsed.positional.slice(1),
        flags: parsed.flags,
        repoRoot,
      });
    }

    case "plan": {
      const { runPlan } = await import("./plan");
      return runPlan({ flags: parsed.flags, repoRoot });
    }

    case "run": {
      const { runWorkflow } = await import("./run");
      return runWorkflow({ flags: parsed.flags, repoRoot });
    }

    case "monitor": {
      const { runMonitor } = await import("./monitor-cmd");
      return runMonitor({ flags: parsed.flags, repoRoot });
    }

    case "status": {
      const { runStatus } = await import("./status");
      return runStatus({ repoRoot });
    }

    case "replay":
    case "diff": {
      log.error(`The "${command}" command is now provided by the smithers CLI directly.`);
      log.error(`Run: smithers ${command} --help`);
      process.exit(1);
    }

    case "scores": {
      const scoresRunId = parsed.positional[1];
      if (!scoresRunId) {
        log.error('Usage: ralphinho scores <run-id>');
        process.exit(1);
      }
      const { runScores } = await import("./scores");
      const scoresDbPath = join(getRalphDir(repoRoot), "workflow.db");
      return runScores({
        runId: scoresRunId,
        dbPath: scoresDbPath,
      });
    }

    default: {
      if (!command) {
        const { runWorkflow } = await import("./run");
        return runWorkflow({ flags: parsed.flags, repoRoot });
      }

      log.error(
        `Unknown command: "${command}". Run "ralphinho --help" for usage.`,
      );
      process.exit(1);
    }
  }
}

main().catch((error) => {
  log.error("\n❌ Error:", error.message);
  process.exit(1);
});
