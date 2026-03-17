import type { SmithersCtx } from "smithers-orchestrator";
import type { ScheduledOutputs } from "../components/QualityPipeline";
import {
  buildOutputSnapshot,
  type MergeQueueRow,
  type OutputSnapshot,
  type FinalReviewRow,
  type ImplementRow,
  type ReviewFixRow,
  type TestRow,
} from "./state";

export function buildSnapshot(ctx: SmithersCtx<ScheduledOutputs>): OutputSnapshot {
  const ctxAny = ctx as unknown as { outputs: (table: string) => unknown[] };
  return buildOutputSnapshot({
    mergeQueueRows: ctxAny.outputs("merge_queue") as MergeQueueRow[],
    testRows: ctxAny.outputs("test") as TestRow[],
    finalReviewRows: ctxAny.outputs("final_review") as FinalReviewRow[],
    implementRows: ctxAny.outputs("implement") as ImplementRow[],
    reviewFixRows: ctxAny.outputs("review_fix") as ReviewFixRow[],
  });
}
