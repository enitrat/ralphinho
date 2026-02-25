#!/usr/bin/env bun
/**
 * ralphinho — Multi-mode AI development workflow CLI
 *
 * Modes:
 *   super-ralph     — Intent-driven autonomous workflow (discover tickets, schedule, implement)
 *   scheduled-work  — RFC/PRD-driven pre-planned workflow (decompose → DAG → quality pipeline)
 *
 * Commands:
 *   ralphinho init super-ralph "prompt"       Initialize intent-driven workflow
 *   ralphinho init super-ralph ./PROMPT.md
 *   ralphinho init scheduled-work ./rfc.md    Initialize RFC-driven workflow
 *   ralphinho plan                            (Re)generate work plan from RFC
 *   ralphinho run                             Execute the initialized workflow
 *   ralphinho run --resume <run-id>           Resume a previous run
 *   ralphinho monitor                         Attach TUI to running workflow
 *   ralphinho status                          Show current state
 */

import { resolve } from "node:path";
import { parseArgs } from "./shared";

function printHelp() {
  console.log(`ralphinho — Multi-mode AI development workflow CLI

Usage:
  ralphinho init super-ralph "prompt text"
  ralphinho init super-ralph ./PROMPT.md
  ralphinho init scheduled-work ./rfc-003.md

  ralphinho plan                             (Re)generate work plan from RFC
  ralphinho run                              Execute the initialized workflow
  ralphinho run --resume <run-id>            Resume a previous run
  ralphinho monitor                          Attach TUI to running workflow
  ralphinho status                           Show current state

Global Options:
  --cwd <path>                Repo root (default: current directory)
  --max-concurrency <n>       Max parallel work units (default: 6)
  --help                      Show this help

Init Options (super-ralph):
  --skip-questions            Skip clarifying questions phase
  --force-new                 Skip existing workflow detection
  --dry-run                   Generate files but don't execute
  --run-id <id>               Explicit Smithers run id

Init Options (scheduled-work):
  --dry-run                   Generate work plan but don't execute

Examples:
  ralphinho init super-ralph "Build a React todo app"
  ralphinho init scheduled-work ./docs/rfc-003.md
  ralphinho plan
  ralphinho run
  ralphinho run --resume sr-m3abc12-deadbeef
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
      const mode = parsed.positional[1];

      if (mode === "super-ralph") {
        const { initSuperRalph } = await import("./init-super-ralph");
        return initSuperRalph({
          positional: parsed.positional.slice(2),
          flags: parsed.flags,
          repoRoot,
        });
      }

      if (mode === "scheduled-work") {
        const { initScheduledWork } = await import("./init-scheduled");
        return initScheduledWork({
          positional: parsed.positional.slice(2),
          flags: parsed.flags,
          repoRoot,
        });
      }

      console.error(
        `Unknown init mode: "${mode}". Use "super-ralph" or "scheduled-work".`,
      );
      process.exit(1);
      break;
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

    default: {
      if (!command) {
        // No command — check for existing workflow
        const { runWorkflow } = await import("./run");
        return runWorkflow({ flags: parsed.flags, repoRoot });
      }

      console.error(
        `Unknown command: "${command}". Run "ralphinho --help" for usage.`,
      );
      process.exit(1);
    }
  }
}

main().catch((error) => {
  console.error("\n❌ Error:", error.message);
  process.exit(1);
});
