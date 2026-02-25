/**
 * ralphinho status — Show current workflow state.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { getRalphDir } from "./shared";
import { ralphinhoConfigSchema } from "../scheduled/types";

export async function runStatus(opts: { repoRoot: string }): Promise<void> {
  const { repoRoot } = opts;
  const ralphDir = getRalphDir(repoRoot);
  const configPath = join(ralphDir, "config.json");

  if (!existsSync(configPath)) {
    console.log("No ralphinho workflow initialized in this directory.\n");
    console.log("Run `ralphinho init` to get started.");
    return;
  }

  const config = ralphinhoConfigSchema.parse(
    JSON.parse(await readFile(configPath, "utf8")),
  );

  console.log(`ralphinho — Status\n`);
  console.log(`  Mode: ${config.mode}`);
  console.log(`  Repo: ${config.repoRoot}`);
  console.log(`  Created: ${config.createdAt}`);
  console.log(
    `  Agents: claude=${config.agents.claude} codex=${config.agents.codex}`,
  );

  if (config.mode === "scheduled-work") {
    const planPath = join(ralphDir, "work-plan.json");
    if (existsSync(planPath)) {
      const plan = JSON.parse(await readFile(planPath, "utf8"));
      console.log(`  RFC: ${config.rfcPath}`);
      console.log(`  Work units: ${plan.units?.length ?? 0}`);
    } else {
      console.log("  Work plan: not generated yet");
    }
  }

  if (config.mode === "super-ralph") {
    console.log(`  Prompt: ${config.promptText?.slice(0, 100) ?? "(none)"}...`);
  }

  const dbPath = join(ralphDir, "workflow.db");
  if (existsSync(dbPath)) {
    const latestRunId = getLatestRunId(dbPath);
    if (latestRunId) {
      console.log(`  Latest run: ${latestRunId}`);
    }
  }

  const workflowPath = join(ralphDir, "generated", "workflow.tsx");
  console.log(
    `  Workflow generated: ${existsSync(workflowPath) ? "yes" : "no"}`,
  );

  console.log();
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
