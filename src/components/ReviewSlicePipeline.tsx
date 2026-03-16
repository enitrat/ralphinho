import React from "react";
import { createHash } from "node:crypto";

import { Sequence, Task } from "smithers-orchestrator";
import type { AgentLike, SmithersCtx } from "smithers-orchestrator";

import type { ReviewPlan, ReviewSlice, ReviewTicket } from "../review/types";
import type { reviewOutputSchemas } from "../review/schemas";

import DiscoverIssuesPrompt from "../prompts/DiscoverIssues.mdx";
import AuditEvidencePrompt from "../prompts/AuditEvidence.mdx";

export type ReviewOutputs = typeof reviewOutputSchemas;

export type ReviewSlicePipelineAgents = {
  discoverer: AgentLike | AgentLike[];
  auditor: AgentLike | AgentLike[];
};

export type ReviewSlicePipelineProps = {
  slice: ReviewSlice;
  plan: ReviewPlan;
  ctx: SmithersCtx<ReviewOutputs>;
  outputs: ReviewOutputs;
  agents: ReviewSlicePipelineAgents;
  passNumber: number;
};

function buildInputSignature(plan: ReviewPlan, slice: ReviewSlice, passNumber: number): string {
  return createHash("sha1")
    .update(JSON.stringify({
      instruction: plan.instruction,
      sliceId: slice.id,
      path: slice.path,
      passNumber,
    }))
    .digest("hex");
}

function materializeTickets(slice: ReviewSlice, audited: Array<{
  dedupeKey: string;
  kind: ReviewTicket["kind"];
  priority: ReviewTicket["priority"];
  confidence: ReviewTicket["confidence"];
  confirmed: boolean;
  summary: string;
  whyItMatters: string;
  evidence: string[];
  lineRefs: string[];
  reproOrTrace: string | null;
  alternatives: string[] | null;
  quickTriage: string;
  acceptIf: string[];
  dismissIf: string[];
  primaryFile: string;
}>): ReviewTicket[] {
  const deduped = new Map<string, ReviewTicket>();

  for (const issue of audited) {
    if (!issue.confirmed) continue;

    deduped.set(issue.dedupeKey, {
      dedupeKey: issue.dedupeKey,
      kind: issue.kind,
      priority: issue.priority,
      confidence: issue.confidence,
      summary: issue.summary,
      whyItMatters: issue.whyItMatters,
      evidence: issue.evidence,
      lineRefs: issue.lineRefs,
      reproOrTrace: issue.reproOrTrace,
      alternatives: issue.alternatives,
      quickTriage: issue.quickTriage,
      acceptIf: issue.acceptIf,
      dismissIf: issue.dismissIf,
      primaryFile: issue.primaryFile,
      area: slice.path,
      requiresHumanReview: true,
    });
  }

  return [...deduped.values()];
}

export function ReviewSlicePipeline({
  slice,
  plan,
  ctx,
  outputs,
  agents,
  passNumber,
}: ReviewSlicePipelineProps) {
  const discoverNodeId = `${slice.id}:discover`;
  const auditNodeId = `${slice.id}:audit`;
  const ticketNodeId = `${slice.id}:ticket-materialize`;

  const latestTickets = ctx.latest("review_ticket", ticketNodeId);
  const sliceComplete = latestTickets != null;
  const inputSignature = buildInputSignature(plan, slice, passNumber);
  const latestDiscovery = ctx.latest("candidate_issue", discoverNodeId);
  const latestAudit = ctx.latest("audited_issue", auditNodeId);
  const tickets = materializeTickets(slice, latestAudit?.audited ?? []);

  return (
    <Sequence>
      {sliceComplete ? null : (
        <>
          <Task
            id={discoverNodeId}
            output={outputs.candidate_issue}
            agent={agents.discoverer}
            retries={2}
            timeoutMs={20 * 60 * 1000}
            skipIf={latestDiscovery?.inputSignature === inputSignature}
          >
            <DiscoverIssuesPrompt
              instruction={plan.instruction}
              sliceId={slice.id}
              slicePath={slice.path}
              entryType={slice.entryType}
              focusAreas={slice.focusAreas}
              rationale={slice.rationale}
              risk={slice.risk}
              inferredPaths={slice.inferredPaths}
              passNumber={passNumber}
              inputSignature={inputSignature}
            />
          </Task>

          <Task
            id={auditNodeId}
            output={outputs.audited_issue}
            agent={agents.auditor}
            retries={2}
            timeoutMs={20 * 60 * 1000}
            meta={{ dependsOn: [discoverNodeId] }}
          >
            <AuditEvidencePrompt
              instruction={plan.instruction}
              sliceId={slice.id}
              slicePath={slice.path}
              focusAreas={slice.focusAreas}
              passNumber={passNumber}
              candidates={latestDiscovery?.candidates ?? []}
              discoverySummary={latestDiscovery?.discoverySummary ?? null}
            />
          </Task>

          <Task id={ticketNodeId} output={outputs.review_ticket}>
            {{
              sliceId: slice.id,
              passNumber,
              tickets,
              newConfirmedCount: tickets.length,
              summary:
                tickets.length === 0
                  ? `No promotable tickets were confirmed for ${slice.path}.`
                  : `Confirmed ${tickets.length} ticket(s) for ${slice.path}.`,
            }}
          </Task>
        </>
      )}
    </Sequence>
  );
}
