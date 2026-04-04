import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import React from "react";
import { Parallel, Loop, Sequence, Task } from "smithers-orchestrator";
import type { AgentLike, SmithersCtx, ScorersMap } from "smithers-orchestrator";
import { schemaAdherenceScorer, relevancyScorer } from "smithers-orchestrator";
import { scheduledOutputSchemas, type Issue } from "../schemas";
import type { WorkUnit } from "../types";
import { reviewCoverageScorer } from "../scorers";
import CodeReviewPrompt from "../prompts/CodeReview.mdx";
import PrdReviewPrompt from "../prompts/PrdReview.mdx";
import ReviewFixPrompt from "../prompts/ReviewFix.mdx";
import TestPrompt from "../prompts/Test.mdx";
import { STAGE_RETRY_POLICIES, stageNodeId } from "../workflow/contracts";
import { buildIssueList, tierHasStep } from "../workflow/reviewUtils";
import type { ScheduledOutputs } from "./QualityPipeline";

export type ReviewLoopAgents = {
  tester: AgentLike | AgentLike[];
  prdReviewer: AgentLike | AgentLike[];
  codeReviewer: AgentLike | AgentLike[];
  reviewFixer: AgentLike | AgentLike[];
  judge?: AgentLike;
};

export type ReviewLoopFallbacks = Partial<{
  tester: AgentLike;
  prdReviewer: AgentLike;
  codeReviewer: AgentLike;
  reviewFixer: AgentLike;
}>;

export type ReviewLoopProps = {
  unit: WorkUnit;
  ctx: SmithersCtx<ScheduledOutputs>;
  outputs: ScheduledOutputs;
  agents: ReviewLoopAgents;
  fallbacks?: ReviewLoopFallbacks;
  implOutput: { whatWasDone: string; filesCreated?: string[]; filesModified?: string[] } | null;
  testSuites: Array<{ name: string; command: string; description: string }>;
  verifyCommands: string[];
  branchPrefix?: string;
  maxReviewPasses?: number;
};

function buildMinorChecklist(issues: Issue[] | null | undefined): string[] {
  if (!issues) return [];
  return issues
    .filter((issue) => issue.severity === "minor")
    .map((issue) => {
      const desc = issue.description ?? "Unspecified issue";
      if (issue.file) {
        return `- [ ] ${desc} (${issue.file})`;
      }
      return `- [ ] ${desc}`;
    });
}

function buildBacklogMarkdown(params: {
  unitId: string;
  unitName: string;
  branchPrefix: string;
  iterationCount: number;
  codeIssues: string[];
  prdIssues: string[];
}): string {
  const { unitId, unitName, branchPrefix, iterationCount, codeIssues, prdIssues } = params;
  const nowIso = new Date().toISOString();
  const codeSection = codeIssues.length > 0 ? codeIssues.join("\n") : "- [ ] None";
  const prdSection = prdIssues.length > 0 ? prdIssues.join("\n") : "- [ ] None";

  return [
    `# Minor issues - ${unitName}`,
    "",
    `**Unit**: ${unitId}`,
    `**Branch**: ${branchPrefix}${unitId}`,
    `**Review loop iterations**: ${iterationCount}`,
    `**Date**: ${nowIso}`,
    "",
    "## Code Review - minor issues",
    codeSection,
    "",
    "## PRD Review - minor issues",
    prdSection,
    "",
  ].join("\n");
}

export function ReviewLoop({
  unit,
  ctx,
  outputs,
  agents,
  fallbacks,
  implOutput,
  testSuites,
  verifyCommands,
  branchPrefix = "unit/",
  maxReviewPasses = 3,
}: ReviewLoopProps) {
  const uid = unit.id;
  const tier = unit.tier;
  const judge = agents.judge;

  const schemaScorer = schemaAdherenceScorer();
  const baseScorers: ScorersMap = {
    schemaAdherence: { scorer: schemaScorer },
    ...(judge ? { relevancy: { scorer: relevancyScorer(judge) } } : {}),
  };
  const codeReviewScorers: ScorersMap = {
    ...baseScorers,
    ...(judge ? { reviewCoverage: { scorer: reviewCoverageScorer(judge) } } : {}),
  };

  // Read current review state from ctx
  const test = ctx.latest(scheduledOutputSchemas.test, stageNodeId(uid, "test"));
  const prdReview = ctx.latest(scheduledOutputSchemas.prd_review, stageNodeId(uid, "prd-review"));
  const codeReview = ctx.latest(scheduledOutputSchemas.code_review, stageNodeId(uid, "code-review"));

  // Loop exit driven by code_review.approved
  const codeApproved = codeReview?.approved === true;
  const prdApproved = prdReview?.approved ?? true;
  const passed = codeApproved && prdApproved;

  const iterationCount = ctx.iterationCount(scheduledOutputSchemas.code_review, stageNodeId(uid, "code-review"));

  const codeSeverity = codeReview?.severity ?? "none";
  const prdSeverity = prdReview?.severity ?? "none";

  const codeMinorIssues = buildMinorChecklist(codeReview?.issues);
  const prdMinorIssues = buildMinorChecklist(prdReview?.issues);
  const hasMinorIssues = codeMinorIssues.length > 0 || prdMinorIssues.length > 0;

  return (
    <Sequence>
      {/* Test — runs once before reviews */}
      <Task
        id={stageNodeId(uid, "test")}
        output={outputs.test}
        agent={agents.tester}
        fallbackAgent={fallbacks?.tester}
        retries={STAGE_RETRY_POLICIES["test"].retries}
        scorers={baseScorers}
        meta={{
          dependsOn: [stageNodeId(uid, "implement")],
          retryPolicy: STAGE_RETRY_POLICIES["test"],
        }}
      >
        <TestPrompt
          unitId={uid}
          unitName={unit.name}
          unitCategory={tier}
          whatWasDone={implOutput?.whatWasDone ?? "Unknown"}
          filesCreated={implOutput?.filesCreated ?? []}
          filesModified={implOutput?.filesModified ?? []}
          testSuites={testSuites}
          fixCommitPrefix="fix"
          branchPrefix={branchPrefix}
        />
      </Task>

      {/* PRD review — structural spec check, runs once */}
      {tierHasStep(tier, "prd-review") && (
        <Task
          id={stageNodeId(uid, "prd-review")}
          output={outputs.prd_review}
          agent={agents.prdReviewer}
          fallbackAgent={fallbacks?.prdReviewer}
          retries={STAGE_RETRY_POLICIES["prd-review"].retries}
          scorers={baseScorers}
          meta={{
            dependsOn: [stageNodeId(uid, "implement")],
            retryPolicy: STAGE_RETRY_POLICIES["prd-review"],
          }}
          continueOnFail
        >
          <PrdReviewPrompt
            unitId={uid}
            unitName={unit.name}
            unitCategory={tier}
            acceptanceCriteria={unit.acceptance}
            filesCreated={implOutput?.filesCreated ?? []}
            filesModified={implOutput?.filesModified ?? []}
            testResults={[
              { name: "Build", status: test?.buildPassed ? "passed" : "failed" },
              { name: "Tests", status: test?.testsPassed ? "passed" : "failed" },
            ]}
            failingSummary={test?.failingSummary ?? null}
            specChecks={[
              {
                name: "Acceptance criteria",
                items: unit.acceptance,
              },
            ]}
          />
        </Task>
      )}

      {/* Code review + fix cycle — exits when code_review.approved === true.
          Loop ID is :review-cycle (iteration tracking); the post-loop result
          Task writes to :review-loop (merge eligibility signal). */}
      <Loop id={`${uid}:review-cycle`} until={codeApproved} maxIterations={maxReviewPasses} onMaxReached="return-last">
        <Sequence>
          {tierHasStep(tier, "code-review") && (
            <Task
              id={stageNodeId(uid, "code-review")}
              output={outputs.code_review}
              agent={agents.codeReviewer}
              fallbackAgent={fallbacks?.codeReviewer}
              retries={STAGE_RETRY_POLICIES["code-review"].retries}
              scorers={codeReviewScorers}
              meta={{
                dependsOn: [stageNodeId(uid, "implement")],
                retryPolicy: STAGE_RETRY_POLICIES["code-review"],
              }}
              continueOnFail
            >
              <CodeReviewPrompt
                unitId={uid}
                unitName={unit.name}
                unitCategory={tier}
                whatWasDone={implOutput?.whatWasDone ?? "Unknown"}
                filesCreated={implOutput?.filesCreated ?? []}
                filesModified={implOutput?.filesModified ?? []}
                qualityChecks={[
                  {
                    name: "Correctness and safety",
                    items: [
                      "No regressions in changed paths",
                      "Error handling covers new edge cases",
                      "No security issues introduced",
                    ],
                  },
                ]}
              />
            </Task>
          )}

          {tierHasStep(tier, "review-fix") && (
            <Task
              id={stageNodeId(uid, "review-fix")}
              output={outputs.review_fix}
              agent={agents.reviewFixer}
              fallbackAgent={fallbacks?.reviewFixer}
              retries={STAGE_RETRY_POLICIES["review-fix"].retries}
              meta={{
                dependsOn: [
                  stageNodeId(uid, "prd-review"),
                  stageNodeId(uid, "code-review"),
                ],
                retryPolicy: STAGE_RETRY_POLICIES["review-fix"],
              }}
              skipIf={codeApproved}
            >
              <ReviewFixPrompt
                unitId={uid}
                unitName={unit.name}
                unitCategory={tier}
                specSeverity={prdReview?.severity ?? "none"}
                specFeedback={prdReview?.feedback ?? ""}
                specIssues={buildIssueList(prdReview?.issues)}
                codeSeverity={codeReview?.severity ?? "none"}
                codeFeedback={codeReview?.feedback ?? ""}
                codeIssues={buildIssueList(codeReview?.issues)}
                validationCommands={verifyCommands}
                commitPrefix="fix"
                emojiPrefixes="fix, refactor, test"
                branchPrefix={branchPrefix}
              />
            </Task>
          )}
        </Sequence>
      </Loop>

      {/* Post-loop: review summary for merge eligibility */}
      <Task id={`${uid}:review-loop`} output={outputs.review_loop_result}>
        {{
          iterationCount: Math.max(iterationCount, 1),
          codeSeverity,
          prdSeverity,
          passed,
          exhausted: !codeApproved,
        }}
      </Task>

      {/* Post-loop: write backlog for minor issues */}
      <Task
        id={`${uid}:review-backlog`}
        output={outputs.review_backlog}
        skipIf={!passed || !hasMinorIssues}
        continueOnFail
      >
        {async () => {
          const backlogPath = resolve(process.cwd(), "docs", "review-backlog", `${uid}.md`);
          const markdown = buildBacklogMarkdown({
            unitId: uid,
            unitName: unit.name,
            branchPrefix,
            iterationCount: Math.max(iterationCount, 1),
            codeIssues: codeMinorIssues,
            prdIssues: prdMinorIssues,
          });

          await mkdir(dirname(backlogPath), { recursive: true });
          await writeFile(backlogPath, markdown, "utf8");

          return {
            backlogPath,
            wroteBacklog: true,
            iterationCount: Math.max(iterationCount, 1),
            codeMinorIssueCount: codeMinorIssues.length,
            prdMinorIssueCount: prdMinorIssues.length,
          };
        }}
      </Task>
    </Sequence>
  );
}
