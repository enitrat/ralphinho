/**
 * ralphinho replay — Fork and replay a workflow run from a checkpoint.
 *
 * Opens the smithers DB, calls replayFromCheckpoint, and prints the new run ID.
 */

import { replayFromCheckpoint } from "smithers-orchestrator/src/time-travel/replay";
import { createLogger } from "../runtime/logger";
import { withSmithersDb } from "./shared";

const log = createLogger({ context: { phase: "cli" } });

export type ReplayOptions = {
  runId: string;
  dbPath: string;
  frame?: number;
  node?: string;
  label?: string;
  restoreVcs?: boolean;
};

export async function runReplay(opts: ReplayOptions): Promise<void> {
  await withSmithersDb(opts.dbPath, async (adapter) => {
    const result = await replayFromCheckpoint(adapter, {
      parentRunId: opts.runId,
      frameNo: opts.frame ?? 0,
      resetNodes: opts.node ? [opts.node] : undefined,
      branchLabel: opts.label,
      restoreVcs: opts.restoreVcs,
    });

    log.info(`Replay started: ${result.runId}`);
    log.info(`  Parent: ${opts.runId}:${opts.frame ?? 0}`);
    if (result.vcsRestored) {
      log.info(`  VCS restored: ${result.vcsPointer}`);
    }
  });
}
