/**
 * ralphinho scores <run-id> — Display aggregated scorer results for a run.
 */

import { createLogger } from "../runtime/logger";
import { withSmithersDb } from "./shared";

const log = createLogger({ context: { phase: "scores" } });

export type ScoresRow = {
  scorerId: string;
  scorerName: string;
  count: number;
  mean: number;
  min: number;
  max: number;
  p50: number;
};

export function formatScoresTable(rows: ScoresRow[]): string {
  if (rows.length === 0) return "No scores found for this run.";

  const headers = ["scorer", "count", "mean", "min", "max", "p50"];
  const data = rows.map((r) => [
    r.scorerName,
    String(r.count),
    r.mean.toFixed(2),
    r.min.toFixed(2),
    r.max.toFixed(2),
    r.p50.toFixed(2),
  ]);

  const widths = headers.map((h, i) =>
    Math.max(h.length, ...data.map((row) => row[i]!.length)),
  );

  const sep = widths.map((w) => "-".repeat(w)).join(" | ");
  const header = headers.map((h, i) => h.padEnd(widths[i]!)).join(" | ");
  const body = data
    .map((row) => row.map((cell, i) => cell.padEnd(widths[i]!)).join(" | "))
    .join("\n");

  return `${header}\n${sep}\n${body}`;
}

export async function runScores(opts: {
  runId: string;
  dbPath: string;
}): Promise<void> {
  const { runId, dbPath } = opts;

  const { aggregateScores } = await import("smithers-orchestrator");

  try {
    await withSmithersDb(dbPath, async (adapter) => {
      const scores = await aggregateScores(adapter, { runId });

      if (scores.length === 0) {
        log.error(`No scores found for run "${runId}".`);
        process.exit(1);
      }

      log.info(`\nScores for run: ${runId}\n`);
      log.info(formatScoresTable(scores));
      log.info("");
    });
  } catch (err) {
    log.error(
      `Could not open smithers.db at ${dbPath}. Has a workflow run been started?`,
    );
    process.exit(1);
  }
}
