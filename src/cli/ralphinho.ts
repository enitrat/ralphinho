#!/usr/bin/env bun
/**
 * ralphinho — RFC-driven AI development workflow CLI
 *
 * Commands:
 *   ralphinho init ./rfc.md            Initialize workflow from RFC
 *   ralphinho plan                     (Re)generate work plan from RFC
 *   ralphinho run                      Execute the initialized workflow
 *   ralphinho run --resume <run-id>    Resume a previous run
 *   ralphinho monitor                  Attach TUI to running workflow
 *   ralphinho status                   Show current state
 */

import { resolve } from "node:path";
import { parseArgs } from "./shared";

function printHelp() {
  console.log(`ralphinho — RFC-driven AI development workflow CLI

Usage:
  ralphinho init ./rfc-003.md

  ralphinho plan                             (Re)generate work plan from RFC
  ralphinho run                              Execute the initialized workflow
  ralphinho run --resume <run-id>            Resume a previous run
  ralphinho monitor                          Attach TUI to running workflow
  ralphinho status                           Show current state

Global Options:
  --cwd <path>                Repo root (default: current directory)
  --max-concurrency <n>       Max parallel work units (default: 6)
  --help                      Show this help

Init Options:
  --dry-run                   Generate work plan but don't execute

Examples:
  ralphinho init ./docs/rfc-003.md
  ralphinho plan
  ralphinho run
  ralphinho run --resume sw-m3abc12-deadbeef
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

    default: {
      if (!command) {
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
