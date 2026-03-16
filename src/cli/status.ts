/**
 * ralphinho status — Show current workflow state.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { getRalphDir, getRalphinhoPresetPath } from "./shared";
import { ralphinhoConfigSchema } from "../config/types";

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
  } else {
    const planPath = join(ralphDir, "review-plan.json");
    if (existsSync(planPath)) {
      const plan = JSON.parse(await readFile(planPath, "utf8"));
      console.log(`  Instruction: ${config.reviewInstruction}`);
      console.log(`  Review slices: ${plan.slices?.length ?? 0}`);
    } else {
      console.log("  Review plan: not generated yet");
    }
  }

  const dbPath = join(ralphDir, "workflow.db");
  const workflowPath = getRalphinhoPresetPath(config.mode);
  if (existsSync(dbPath)) {
    console.log("  Database: exists");
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
          console.log(`  Landed: ${landed.length}/${row.total_units ?? landed.length}`);
          console.log(`  Semantically complete: ${semanticallyComplete.length}/${row.total_units ?? semanticallyComplete.length}`);
          if (row.summary) console.log(`  Summary: ${row.summary}`);
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
          console.log(`  Local slices complete: ${localSlicesComplete.length}`);
          console.log(`  Cross-cutting pass complete: ${crossCuttingComplete}`);
          console.log(`  Confirmed findings: ${row.confirmed_findings ?? 0}`);
          console.log(`  Merged findings: ${row.merged_findings ?? 0}`);
          if (row.summary) console.log(`  Summary: ${row.summary}`);
        }
      }
    } catch {
      // Status should still render even when completion_report is absent.
    }
  }

  console.log(
    `  Workflow preset: ${existsSync(workflowPath) ? "yes" : "no"}`,
  );

  console.log();
}
