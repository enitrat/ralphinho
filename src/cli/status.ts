/**
 * ralphinho status — Show current workflow state.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { getRalphDir, getRalphinhoPresetPath } from "./shared";
import { ralphinhoConfigSchema } from "../config/types";
import { createLogger } from "../runtime/logger";

const log = createLogger({ context: { phase: "status" } });

export async function runStatus(opts: { repoRoot: string }): Promise<void> {
  const { repoRoot } = opts;
  const ralphDir = getRalphDir(repoRoot);
  const configPath = join(ralphDir, "config.json");

  if (!existsSync(configPath)) {
    log.info("No ralphinho workflow initialized in this directory.\n");
    log.info("Run `ralphinho init` to get started.");
    return;
  }

  const config = ralphinhoConfigSchema.parse(
    JSON.parse(await readFile(configPath, "utf8")),
  );

  log.info(`ralphinho — Status\n`);
  log.info(`  Mode: ${config.mode}`);
  log.info(`  Repo: ${config.repoRoot}`);
  log.info(`  Created: ${config.createdAt}`);
  log.info(
    `  Agents: claude=${config.agents.claude} codex=${config.agents.codex}`,
  );

  if (config.mode === "scheduled-work") {
    const planPath = join(ralphDir, "work-plan.json");
    if (existsSync(planPath)) {
      const plan = JSON.parse(await readFile(planPath, "utf8"));
      log.info(`  RFC: ${config.rfcPath}`);
      log.info(`  Work units: ${plan.units?.length ?? 0}`);
    } else {
      log.info("  Work plan: not generated yet");
    }
  } else {
    const planPath = join(ralphDir, "review-plan.json");
    if (existsSync(planPath)) {
      const plan = JSON.parse(await readFile(planPath, "utf8"));
      log.info(`  Instruction: ${config.reviewInstruction}`);
      log.info(`  Review slices: ${plan.slices?.length ?? 0}`);
    } else {
      log.info("  Review plan: not generated yet");
    }
  }

  const dbPath = join(ralphDir, "workflow.db");
  const workflowPath = getRalphinhoPresetPath(config.mode);
  if (existsSync(dbPath)) {
    log.info("  Database: exists");
    try {
      const { Database } = await import("bun:sqlite");
      const db = new Database(dbPath, { readonly: true });
      if (config.mode === "scheduled-work") {
        const row = db.query(
          "SELECT total_units, units_landed, units_semantically_complete, summary FROM completion_report ORDER BY iteration DESC LIMIT 1",
        ).get() as {
          total_units?: number;
          units_landed?: string | null;
          units_semantically_complete?: string | null;
          summary?: string | null;
        } | undefined;
        db.close();

        if (row) {
          const landed = typeof row.units_landed === "string" ? JSON.parse(row.units_landed) as string[] : [];
          const semanticallyComplete = typeof row.units_semantically_complete === "string"
            ? JSON.parse(row.units_semantically_complete) as string[]
            : [];
          log.info(`  Landed: ${landed.length}/${row.total_units ?? landed.length}`);
          log.info(`  Semantically complete: ${semanticallyComplete.length}/${row.total_units ?? semanticallyComplete.length}`);
          if (row.summary) log.info(`  Summary: ${row.summary}`);
        }
      } else {
        const row = db.query(
          "SELECT total_slices, local_slices_complete, cross_cutting_slice_complete, confirmed_findings, merged_findings, summary FROM completion_report ORDER BY iteration DESC LIMIT 1",
        ).get() as {
          total_slices?: number;
          local_slices_complete?: string | null;
          cross_cutting_slice_complete?: number | boolean | null;
          confirmed_findings?: number;
          merged_findings?: number;
          summary?: string | null;
        } | undefined;
        db.close();

        if (row) {
          const localSlicesComplete = typeof row.local_slices_complete === "string"
            ? JSON.parse(row.local_slices_complete) as string[]
            : [];
          const crossCuttingComplete = Boolean(row.cross_cutting_slice_complete);
          log.info(`  Local slices complete: ${localSlicesComplete.length}`);
          log.info(`  Cross-cutting pass complete: ${crossCuttingComplete}`);
          log.info(`  Confirmed findings: ${row.confirmed_findings ?? 0}`);
          log.info(`  Merged findings: ${row.merged_findings ?? 0}`);
          if (row.summary) log.info(`  Summary: ${row.summary}`);
        }
      }
    } catch {
      // Status should still render even when completion_report is absent.
    }
  }

  log.info(
    `  Workflow preset: ${existsSync(workflowPath) ? "yes" : "no"}`,
  );

  log.info("");
}
