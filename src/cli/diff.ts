/**
 * ralphinho diff — Compare two workflow snapshots.
 *
 * Supports two formats:
 *   ralphinho diff <run-a> <run-b>           — diff latest snapshots of two runs
 *   ralphinho diff <run-a>:<frame> <run-b>:<frame> — diff specific frames
 */

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
import { withSmithersDb } from "./shared";

const log = createLogger({ context: { phase: "cli" } });

export type DiffOptions = {
  specA: string;
  specB: string;
  dbPath: string;
  json?: boolean;
};

export type SnapshotSpec = { runId: string; frameNo: number | null };

export function parseSpec(spec: string): SnapshotSpec {
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
  await withSmithersDb(opts.dbPath, async (adapter) => {
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
      throw new Error(`Snapshot not found: ${opts.specA}`);
    }
    if (!snapB) {
      throw new Error(`Snapshot not found: ${opts.specB}`);
    }

    const diff = diffRawSnapshots(snapA, snapB);

    if (opts.json) {
      log.info(JSON.stringify(formatDiffAsJson(diff), null, 2));
    } else {
      log.info(formatDiffForTui(diff));
    }
  });
}
