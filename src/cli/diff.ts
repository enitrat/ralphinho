/**
 * ralphinho diff — Compare two workflow snapshots.
 *
 * Supports two formats:
 *   ralphinho diff <run-a> <run-b>           — diff latest snapshots of two runs
 *   ralphinho diff <run-a>:<frame> <run-b>:<frame> — diff specific frames
 */

import { openSmithersDb } from "smithers-orchestrator/src/cli/find-db";
import {
  loadSnapshot,
  loadLatestSnapshot,
} from "smithers-orchestrator/src/time-travel/snapshot";
import {
  diffRawSnapshots,
  formatDiffForTui,
  formatDiffAsJson,
} from "smithers-orchestrator/src/time-travel/diff";
import { createLogger } from "../runtime/logger";

const log = createLogger({ context: { phase: "cli" } });

export type DiffOptions = {
  specA: string;
  specB: string;
  dbPath: string;
  json?: boolean;
};

type SnapshotSpec = { runId: string; frameNo: number | null };

function parseSpec(spec: string): SnapshotSpec {
  const colonIdx = spec.lastIndexOf(":");
  if (colonIdx === -1) return { runId: spec, frameNo: null };

  const maybeFn = spec.slice(colonIdx + 1);
  const parsed = Number(maybeFn);
  if (Number.isInteger(parsed) && parsed >= 0) {
    return { runId: spec.slice(0, colonIdx), frameNo: parsed };
  }
  return { runId: spec, frameNo: null };
}

export async function runDiff(opts: DiffOptions): Promise<void> {
  let cleanup: (() => void) | undefined;

  try {
    const { adapter, cleanup: dbCleanup } = await openSmithersDb(opts.dbPath);
    cleanup = dbCleanup;

    const specA = parseSpec(opts.specA);
    const specB = parseSpec(opts.specB);

    const [snapA, snapB] = await Promise.all([
      specA.frameNo !== null
        ? loadSnapshot(adapter, specA.runId, specA.frameNo)
        : loadLatestSnapshot(adapter, specA.runId),
      specB.frameNo !== null
        ? loadSnapshot(adapter, specB.runId, specB.frameNo)
        : loadLatestSnapshot(adapter, specB.runId),
    ]);

    if (!snapA) {
      log.error(`Snapshot not found: ${opts.specA}`);
      process.exit(1);
    }
    if (!snapB) {
      log.error(`Snapshot not found: ${opts.specB}`);
      process.exit(1);
    }

    const diff = diffRawSnapshots(snapA, snapB);

    if (opts.json) {
      log.info(JSON.stringify(formatDiffAsJson(diff), null, 2));
    } else {
      log.info(formatDiffForTui(diff));
    }
  } catch (err) {
    log.error(`Diff failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  } finally {
    cleanup?.();
  }
}
