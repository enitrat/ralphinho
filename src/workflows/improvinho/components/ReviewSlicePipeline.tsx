import React from "react";
import { createHash } from "node:crypto";

import { Parallel, Sequence, Task } from "smithers-orchestrator";
import type { AgentLike, SmithersCtx } from "smithers-orchestrator";

import type {
  DiscoveredFinding,
  ReviewFinding,
  ReviewLens,
  ReviewPlan,
  ReviewSlice,
} from "../types";
import type { reviewOutputSchemas } from "../schemas";
import { REVIEW_LENSES, getReviewLensDefinition } from "../lenses";
import { normalizePart, confidenceRank, priorityRank } from "../projection";

import DiscoverIssuesPrompt from "../prompts/DiscoverIssues.mdx";

export type ReviewOutputs = typeof reviewOutputSchemas;

export type ReviewSlicePipelineAgents = {
  refactorHunter: AgentLike | AgentLike[];
  typeSystemPurist: AgentLike | AgentLike[];
  appLogicArchitecture: AgentLike | AgentLike[];
};

export type ReviewSlicePipelineProps = {
  slice: ReviewSlice;
  plan: ReviewPlan;
  ctx: SmithersCtx<ReviewOutputs>;
  outputs: ReviewOutputs;
  agents: ReviewSlicePipelineAgents;
};

type ReviewLensDiscoveryTaskProps = {
  slice: ReviewSlice;
  plan: ReviewPlan;
  ctx: SmithersCtx<ReviewOutputs>;
  outputs: ReviewOutputs;
  lens: ReviewLens;
  agent: AgentLike | AgentLike[];
};

function discoveryNodeId(sliceId: string, lens: ReviewLens): string {
  return `${sliceId}:${lens}:discover`;
}

function buildInputSignature(plan: ReviewPlan, slice: ReviewSlice, lens: ReviewLens): string {
  return createHash("sha1")
    .update(JSON.stringify({
      instruction: plan.instruction,
      sliceId: slice.id,
      mode: slice.mode,
      lens,
      path: slice.path,
      inferredPaths: slice.inferredPaths,
    }))
    .digest("hex");
}


function computeDedupeKey(lens: ReviewLens, finding: DiscoveredFinding): string {
  return [
    lens,
    finding.kind,
    normalizePart(finding.primaryFile),
    normalizePart(finding.symbol),
    normalizePart(finding.pattern),
  ].join(":");
}

function buildFindingId(sliceId: string, dedupeKey: string): string {
  return createHash("sha1")
    .update(`${sliceId}:${dedupeKey}`)
    .digest("hex")
    .slice(0, 12);
}

function toReviewFindings(
  slice: ReviewSlice,
  lens: ReviewLens,
  discovered: DiscoveredFinding[],
): ReviewFinding[] {
  const deduped = new Map<string, ReviewFinding>();

  for (const item of discovered) {
    const dedupeKey = computeDedupeKey(lens, item);
    const rejected =
      item.confidence === "low"
      || item.summary.trim().length === 0
      || item.evidence.trim().length === 0
      || item.primaryFile.trim().length === 0
      || item.lineRefs.length === 0;

    const finding: ReviewFinding = {
      id: buildFindingId(slice.id, dedupeKey),
      lens,
      status: rejected ? "rejected" : "confirmed",
      dedupeKey,
      kind: item.kind,
      priority: item.priority,
      confidence: item.confidence,
      summary: item.summary.trim(),
      evidence: item.evidence.trim(),
      primaryFile: item.primaryFile.trim(),
      lineRefs: item.lineRefs,
      symbol: item.symbol,
      pattern: normalizePart(item.pattern),
      suggestedDiff: item.suggestedDiff,
      acceptIf: item.acceptIf,
      dismissIf: item.dismissIf,
      rejectionReason: rejected
        ? "Rejected by validation filter: low confidence or missing required evidence."
        : null,
      scopeId: slice.id,
      scopeMode: slice.mode,
      scopeLabel: slice.path,
      discoveredAt: new Date().toISOString(),
    };

    const existing = deduped.get(dedupeKey);
    if (!existing) {
      deduped.set(dedupeKey, finding);
      continue;
    }

    const replacementWins =
      confidenceRank(finding.confidence) > confidenceRank(existing.confidence)
      || (
        confidenceRank(finding.confidence) === confidenceRank(existing.confidence)
        && priorityRank(finding.priority) > priorityRank(existing.priority)
      );

    if (replacementWins) {
      deduped.set(dedupeKey, finding);
    }
  }

  return [...deduped.values()];
}

function agentForLens(
  agents: ReviewSlicePipelineAgents,
  lens: ReviewLens,
): AgentLike | AgentLike[] {
  switch (lens) {
    case "refactor-hunter":
      return agents.refactorHunter;
    case "type-system-purist":
      return agents.typeSystemPurist;
    case "app-logic-architecture":
      return agents.appLogicArchitecture;
  }
}

function ReviewLensDiscoveryTask({
  slice,
  plan,
  ctx,
  outputs,
  lens,
  agent,
}: ReviewLensDiscoveryTaskProps) {
  const lensDefinition = getReviewLensDefinition(lens);
  const nodeId = discoveryNodeId(slice.id, lens);
  const inputSignature = buildInputSignature(plan, slice, lens);
  const latestDiscovery = ctx.latest("discovery_result", nodeId);

  return (
    <Task
      id={nodeId}
      output={outputs.discovery_result}
      agent={agent}
      retries={2}
      timeoutMs={20 * 60 * 1000}
      skipIf={latestDiscovery?.inputSignature === inputSignature}
    >
      <DiscoverIssuesPrompt
        instruction={plan.instruction}
        sliceId={slice.id}
        lens={lens}
        lensTitle={lensDefinition.title}
        lensMission={lensDefinition.mission}
        lensChecklist={lensDefinition.checklist}
        mode={slice.mode}
        slicePath={slice.path}
        entryType={slice.entryType}
        focusAreas={slice.focusAreas}
        rationale={slice.rationale}
        risk={slice.risk}
        inferredPaths={slice.inferredPaths}
        inputSignature={inputSignature}
      />
    </Task>
  );
}

export function ReviewSlicePipeline({
  slice,
  plan,
  ctx,
  outputs,
  agents,
}: ReviewSlicePipelineProps) {
  const findingNodeId = `${slice.id}:finding`;
  const discoveryResults = REVIEW_LENSES.map((lensDefinition) => ({
    lens: lensDefinition.id,
    latestDiscovery: ctx.latest("discovery_result", discoveryNodeId(slice.id, lensDefinition.id)),
  }));
  const findings = discoveryResults.flatMap(({ lens, latestDiscovery }) =>
    toReviewFindings(slice, lens, latestDiscovery?.findings ?? []));
  const confirmedCount = findings.filter((entry) => entry.status === "confirmed").length;
  const rejectedCount = findings.filter((entry) => entry.status === "rejected").length;

  return (
    <Sequence>
      <Parallel maxConcurrency={REVIEW_LENSES.length}>
        {REVIEW_LENSES.map((lensDefinition) => (
          React.createElement(ReviewLensDiscoveryTask, {
            key: lensDefinition.id,
            slice,
            plan,
            ctx,
            outputs,
            lens: lensDefinition.id,
            agent: agentForLens(agents, lensDefinition.id),
          })
        ))}
      </Parallel>

      <Task
        id={findingNodeId}
        output={outputs.finding}
        meta={{ dependsOn: REVIEW_LENSES.map((lensDefinition) => discoveryNodeId(slice.id, lensDefinition.id)) }}
      >
        {{
          sliceId: slice.id,
          mode: slice.mode,
          findings,
          confirmedCount,
          rejectedCount,
          summary:
            confirmedCount === 0
              ? `No confirmed findings across the three discovery lenses for ${slice.path}.`
              : `Confirmed ${confirmedCount} finding(s) across the three discovery lenses for ${slice.path}.`,
        }}
      </Task>
    </Sequence>
  );
}
