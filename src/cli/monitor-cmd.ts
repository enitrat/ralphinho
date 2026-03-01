/**
 * ralphinho monitor — Attach TUI to a running or completed workflow.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { getRalphDir, type ParsedArgs } from "./shared";
import { ralphinhoConfigSchema } from "../scheduled/types";

export async function runMonitor(opts: {
  flags: ParsedArgs["flags"];
  repoRoot: string;
}): Promise<void> {
  const { repoRoot } = opts;
  const ralphDir = getRalphDir(repoRoot);
  const configPath = join(ralphDir, "config.json");

  if (!existsSync(configPath)) {
    console.error("Error: No ralphinho workflow found. Run `ralphinho init` first.");
    process.exit(1);
  }

  const config = ralphinhoConfigSchema.parse(
    JSON.parse(await readFile(configPath, "utf8")),
  );

  const dbPath = join(ralphDir, "workflow.db");
  if (!existsSync(dbPath)) {
    console.error("Error: No workflow database found. Run `ralphinho run` first.");
    process.exit(1);
  }

  // Find latest run ID
  let runId: string;
  try {
    const { Database } = require("bun:sqlite");
    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare(`SELECT run_id FROM _smithers_runs ORDER BY rowid DESC LIMIT 1`)
      .get() as { run_id: string } | null;
    db.close();
    if (!row?.run_id) throw new Error("No runs found");
    runId = row.run_id;
  } catch (e: any) {
    console.error(`Error: Could not find a run in the database: ${e.message}`);
    process.exit(1);
    return; // unreachable, but TypeScript needs it
  }

  const projectName = basename(repoRoot);
  const prompt = config.rfcPath ?? "";

  console.log(`Launching monitor for run ${runId}...\n`);

  const cliDir = import.meta.dir;
  const monitorScript = join(cliDir, "monitor-standalone.ts");

  const proc = Bun.spawn(
    ["bun", monitorScript, dbPath, runId, projectName, prompt],
    {
      cwd: repoRoot,
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    },
  );

  await proc.exited;
}
