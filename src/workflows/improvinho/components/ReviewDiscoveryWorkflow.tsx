import React from "react";

import { Parallel, Sequence, Task } from "smithers-orchestrator";
import type { SmithersCtx } from "smithers-orchestrator";

import type { ReviewPlan } from "../types";
import { mergeReviewFindings } from "../projection";
import type { ReviewOutputs, ReviewSlicePipelineAgents } from "./ReviewSlicePipeline";
import { ReviewSlicePipeline } from "./ReviewSlicePipeline";

const SLICE_PLAN_NODE_ID = "review:slice-plan";
const MERGE_REPORT_NODE_ID = "review:merge-report";
const COMPLETION_REPORT_NODE_ID = "review:completion-report";

export type ReviewDiscoveryWorkflowProps = {
  ctx: SmithersCtx<ReviewOutputs>;
  outputs: ReviewOutputs;
  plan: ReviewPlan;
  maxConcurrency: number;
  agents: ReviewSlicePipelineAgents;
};

export function ReviewDiscoveryWorkflow({
  ctx,
  outputs,
  plan,
  maxConcurrency,
  agents,
}: ReviewDiscoveryWorkflowProps) {
  const localSlices = plan.slices.filter((slice) => slice.mode === "slice");
  const crossCuttingSlice = plan.slices.find((slice) => slice.mode === "cross-cutting") ?? null;
  const materializationNodeIds = [
    ...localSlices.map((slice) => `${slice.id}:finding`),
    ...(crossCuttingSlice ? [`${crossCuttingSlice.id}:finding`] : []),
  ];

  const localResults = localSlices.map((slice) => ctx.latest("finding", `${slice.id}:finding`));
  const crossCuttingResult = crossCuttingSlice
    ? ctx.latest("finding", `${crossCuttingSlice.id}:finding`)
    : null;
  const localSlicesComplete = localSlices
    .filter((slice) => ctx.latest("finding", `${slice.id}:finding`) != null)
    .map((slice) => slice.id);

  const materialized = [
    ...localResults.flatMap((result) => result?.findings ?? []),
    ...(crossCuttingResult?.findings ?? []),
  ];
  const confirmedFindings = materialized.filter((finding) => finding.status === "confirmed");
  const rejectedFindings = materialized.filter((finding) => finding.status === "rejected");
  const mergedFindings = mergeReviewFindings(confirmedFindings);

  return (
    <Sequence>
      <Task id={SLICE_PLAN_NODE_ID} output={outputs.slice_plan}>
        {{
          totalSlices: plan.slices.length,
          localSliceIds: localSlices.map((slice) => slice.id),
          crossCuttingSliceId: crossCuttingSlice?.id ?? null,
          summary:
            crossCuttingSlice == null
              ? `Prepared ${localSlices.length} local review slice(s).`
              : `Prepared ${localSlices.length} local review slice(s) plus one cross-cutting pass.`,
        }}
      </Task>

      <Parallel maxConcurrency={maxConcurrency}>
        {localSlices.map((slice) => (
          React.createElement(ReviewSlicePipeline, {
            key: slice.id,
            slice,
            plan,
            ctx,
            outputs,
            agents,
          })
        ))}
      </Parallel>

      {crossCuttingSlice ? (
        <ReviewSlicePipeline
          slice={crossCuttingSlice}
          plan={plan}
          ctx={ctx}
          outputs={outputs}
          agents={agents}
        />
      ) : null}

      <Task
        id={MERGE_REPORT_NODE_ID}
        output={outputs.merge_report}
        meta={{ dependsOn: materializationNodeIds }}
      >
        {{
          rawFindingCount: materialized.length,
          confirmedFindingCount: confirmedFindings.length,
          mergedFindingCount: mergedFindings.length,
          summaryPath: ".tickets/summary.md",
          summary:
            mergedFindings.length === 0
              ? "No confirmed findings survived deterministic merge."
              : `${mergedFindings.length} merged finding(s) are ready for final summary projection.`,
        }}
      </Task>

      <Task
        id={COMPLETION_REPORT_NODE_ID}
        output={outputs.completion_report}
        meta={{ dependsOn: [MERGE_REPORT_NODE_ID] }}
      >
        {{
          totalSlices: plan.slices.length,
          localSlicesComplete,
          crossCuttingSliceComplete: crossCuttingSlice == null || crossCuttingResult != null,
          totalFindings: materialized.length,
          confirmedFindings: confirmedFindings.length,
          rejectedFindings: rejectedFindings.length,
          mergedFindings: mergedFindings.length,
          summary:
            mergedFindings.length === 0
              ? "Review discovery completed with no merged findings."
              : `Review discovery completed with ${mergedFindings.length} merged finding(s) ready for summary projection.`,
          nextSteps:
            mergedFindings.length === 0
              ? ["Refine the review scope or prompt if you expected actionable findings."]
              : [
                  "Review .tickets/summary.md after the run completes and the final projection step writes it once.",
                  "Promote durable findings into the real issue tracker instead of maintaining per-file tickets.",
                ],
        }}
      </Task>
    </Sequence>
  );
}
