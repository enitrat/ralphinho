import React from "react";

import { Parallel, Ralph, Sequence, Task } from "smithers-orchestrator";
import type { SmithersCtx } from "smithers-orchestrator";

import type { ReviewPlan } from "../review/types";
import type { ReviewOutputs, ReviewSlicePipelineAgents } from "./ReviewSlicePipeline";
import { ReviewSlicePipeline } from "./ReviewSlicePipeline";

const SLICE_PLAN_NODE_ID = "review:slice-plan";
const PASS_TRACKER_NODE_ID = "review:pass-tracker";
const TICKET_WRITE_NODE_ID = "review:ticket-write";
const COMPLETION_REPORT_NODE_ID = "review:completion-report";

export type ReviewDiscoveryWorkflowProps = {
  ctx: SmithersCtx<ReviewOutputs>;
  outputs: ReviewOutputs;
  plan: ReviewPlan;
  maxConcurrency: number;
  maxPasses?: number;
  agents: ReviewSlicePipelineAgents;
};

export function ReviewDiscoveryWorkflow({
  ctx,
  outputs,
  plan,
  maxConcurrency,
  maxPasses = 3,
  agents,
}: ReviewDiscoveryWorkflowProps) {
  const passTracker = ctx.latest("pass_tracker", PASS_TRACKER_NODE_ID);
  const currentPass = passTracker?.totalIterations ?? 0;
  const passNumber = currentPass + 1;

  const sliceCompletion = plan.slices.map((slice) => ({
    sliceId: slice.id,
    complete: ctx.latest("review_ticket", `${slice.id}:ticket-materialize`) != null,
  }));
  const slicesComplete = sliceCompletion.filter((entry) => entry.complete).map((entry) => entry.sliceId);
  const slicesRemaining = sliceCompletion.filter((entry) => !entry.complete).map((entry) => entry.sliceId);
  const confirmedTickets = plan.slices.flatMap((slice) => {
    const latest = ctx.latest("review_ticket", `${slice.id}:ticket-materialize`);
    return latest?.tickets ?? [];
  });
  const newConfirmedTickets = plan.slices.reduce((count, slice) => {
    const latest = ctx.latest("review_ticket", `${slice.id}:ticket-materialize`);
    return count + (latest?.newConfirmedCount ?? 0);
  }, 0);
  const zeroNewPasses = newConfirmedTickets === 0
    ? (passTracker?.zeroNewPasses ?? 0) + 1
    : 0;
  const done =
    slicesRemaining.length === 0
    || currentPass >= maxPasses
    || zeroNewPasses >= 2;

  return (
    <Sequence>
      <Task id={SLICE_PLAN_NODE_ID} output={outputs.slice_plan}>
        {{
          totalSlices: plan.slices.length,
          sliceIds: plan.slices.map((slice) => slice.id),
          summary: `Prepared ${plan.slices.length} review slice(s) for improvinho.`,
        }}
      </Task>

      <Ralph until={done} maxIterations={maxPasses} onMaxReached="return-last">
        <Sequence>
          <Parallel maxConcurrency={maxConcurrency}>
            {plan.slices.map((slice) => (
              <ReviewSlicePipeline
                slice={slice}
                plan={plan}
                ctx={ctx}
                outputs={outputs}
                agents={agents}
                passNumber={passNumber}
              />
            ))}
          </Parallel>

          <Task id={TICKET_WRITE_NODE_ID} output={outputs.ticket_write}>
            {{
              passNumber,
              ticketCount: confirmedTickets.length,
              newTicketCount: newConfirmedTickets,
              summary:
                confirmedTickets.length === 0
                  ? `Pass ${passNumber}: no confirmed tickets.`
                  : `Pass ${passNumber}: ${confirmedTickets.length} confirmed ticket(s) ready for projection.`,
            }}
          </Task>

          <Task id={PASS_TRACKER_NODE_ID} output={outputs.pass_tracker}>
            {{
              totalIterations: passNumber,
              slicesRun: slicesRemaining,
              slicesComplete,
              newConfirmedTickets,
              zeroNewPasses,
              summary:
                slicesRemaining.length === 0
                  ? `Pass ${passNumber}: all review slices are complete.`
                  : `Pass ${passNumber}: ${slicesComplete.length}/${plan.slices.length} slices complete; ${newConfirmedTickets} confirmed ticket(s) this pass.`,
            }}
          </Task>
        </Sequence>
      </Ralph>

      <Task id={COMPLETION_REPORT_NODE_ID} output={outputs.completion_report}>
        {{
          totalSlices: plan.slices.length,
          slicesComplete,
          slicesRemaining,
          totalConfirmedTickets: confirmedTickets.length,
          openTicketCount: confirmedTickets.filter((ticket) => ticket.requiresHumanReview).length,
          passesUsed: passNumber,
          zeroNewPasses,
          summary:
            slicesRemaining.length === 0
              ? `Reviewed all ${plan.slices.length} slices and confirmed ${confirmedTickets.length} ticket(s).`
              : `Stopped after ${passNumber} pass(es) with ${slicesRemaining.length} slice(s) remaining and ${confirmedTickets.length} confirmed ticket(s).`,
          nextSteps:
            confirmedTickets.length === 0
              ? ["No tickets were confirmed. Refine the review scope or instruction and rerun improvinho."]
              : [
                  "Review the generated .tickets/ summary and open ticket files.",
                  "Accept or reject the projected tickets before any remediation workflow is added.",
                ],
        }}
      </Task>
    </Sequence>
  );
}
