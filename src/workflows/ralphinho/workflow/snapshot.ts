import type { SmithersCtx } from "smithers-orchestrator";
import type { ScheduledOutputs } from "../components/QualityPipeline";
import {
  buildOutputSnapshot,
  type MergeQueueRow,
  type OutputSnapshot,
  type ImplementRow,
  type ReviewLoopResultRow,
  type ReviewFixRow,
  type TestRow,
} from "./state";

export function buildSnapshot(ctx: SmithersCtx<ScheduledOutputs>): OutputSnapshot {
  const ctxAny = ctx as unknown as { outputs: (table: string) => unknown[] };
  return buildOutputSnapshot({
    mergeQueueRows: ctxAny.outputs("merge_queue") as MergeQueueRow[],
    testRows: ctxAny.outputs("test") as TestRow[],
    reviewLoopResultRows: ctxAny.outputs("review_loop_result") as ReviewLoopResultRow[],
    implementRows: ctxAny.outputs("implement") as ImplementRow[],
    reviewFixRows: ctxAny.outputs("review_fix") as ReviewFixRow[],
  });
}
