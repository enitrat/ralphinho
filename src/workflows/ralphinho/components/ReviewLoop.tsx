import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import React from "react";
import { Parallel, Ralph, Sequence, Task } from "smithers-orchestrator";
import type { AgentLike, SmithersCtx } from "smithers-orchestrator";
import type { Issue } from "../schemas";
import type { WorkUnit } from "../types";
import CodeReviewPrompt from "../prompts/CodeReview.mdx";
import PrdReviewPrompt from "../prompts/PrdReview.mdx";
import ReviewFixPrompt from "../prompts/ReviewFix.mdx";
import TestPrompt from "../prompts/Test.mdx";
import { STAGE_RETRY_POLICIES, stageNodeId, TIER_STAGES } from "../workflow/contracts";
import type { ScheduledTier } from "../workflow/contracts";
import type { ScheduledOutputs } from "./QualityPipeline";

export type ReviewLoopAgents = {
  tester: AgentLike | AgentLike[];
  prdReviewer: AgentLike | AgentLike[];
  codeReviewer: AgentLike | AgentLike[];
  reviewFixer: AgentLike | AgentLike[];
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
  implOutput: { whatWasDone: string; filesCreated: string[]; filesModified: string[] } | null;
  testSuites: Array<{ name: string; command: string; description: string }>;
  verifyCommands: string[];
  branchPrefix?: string;
  maxReviewPasses?: number;
};

function tierHasStep(tier: ScheduledTier, step: string): boolean {
  return (TIER_STAGES[tier] as readonly string[]).includes(step);
}

function buildIssueList(issues: Issue[] | null | undefined): string[] {
  if (!issues) return [];
  return issues.map((issue) => {
    const sev = issue.severity ? `[${issue.severity}] ` : "";
    const desc = issue.description ?? "Unspecified issue";
    const file = issue.file ? ` (${issue.file})` : "";
    return `${sev}${desc}${file}`;
  });
}

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

  const reviewLoopResult = ctx.latest("review_loop_result", `${uid}:review-loop`);
  const iterationCount = reviewLoopResult?.iterationCount ?? 0;

  const test = ctx.latest("test", stageNodeId(uid, "test"));
  const prdReview = ctx.latest("prd_review", stageNodeId(uid, "prd-review"));
  const codeReview = ctx.latest("code_review", stageNodeId(uid, "code-review"));

  const codeSeverity = codeReview?.severity ?? "none";
  const prdSeverity = prdReview?.severity ?? "none";
  const reviewsRanAtLeastOnce = codeReview != null;
  const exitConditionMet =
    reviewsRanAtLeastOnce
    && codeSeverity !== "critical"
    && codeSeverity !== "major"
    && prdSeverity !== "critical"
    && prdSeverity !== "major";
  const exhausted = iterationCount >= maxReviewPasses && !exitConditionMet;
  const done = exitConditionMet || exhausted;

  const nextIterationCount = iterationCount + 1;
  const nextExhausted = nextIterationCount >= maxReviewPasses && !exitConditionMet;

  const codeMinorIssues = buildMinorChecklist(codeReview?.issues);
  const prdMinorIssues = buildMinorChecklist(prdReview?.issues);
  const hasMinorIssues = codeMinorIssues.length > 0 || prdMinorIssues.length > 0;

  return (
    <Sequence>
      <Ralph until={done} maxIterations={maxReviewPasses * 10} onMaxReached="return-last">
        <Sequence>
          <Task
            id={stageNodeId(uid, "test")}
            output={outputs.test}
            agent={agents.tester}
            fallbackAgent={fallbacks?.tester}
            retries={STAGE_RETRY_POLICIES["test"].retries}
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

          <Parallel>
            {tierHasStep(tier, "prd-review") && (
              <Task
                id={stageNodeId(uid, "prd-review")}
                output={outputs.prd_review}
                agent={agents.prdReviewer}
                fallbackAgent={fallbacks?.prdReviewer}
                retries={STAGE_RETRY_POLICIES["prd-review"].retries}
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
            {tierHasStep(tier, "code-review") && (
              <Task
                id={stageNodeId(uid, "code-review")}
                output={outputs.code_review}
                agent={agents.codeReviewer}
                fallbackAgent={fallbacks?.codeReviewer}
                retries={STAGE_RETRY_POLICIES["code-review"].retries}
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
          </Parallel>

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
              skipIf={exitConditionMet}
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

          <Task id={`${uid}:review-loop`} output={outputs.review_loop_result}>
            {{
              iterationCount: nextIterationCount,
              codeSeverity,
              prdSeverity,
              passed: exitConditionMet,
              exhausted: nextExhausted,
            }}
          </Task>
        </Sequence>
      </Ralph>

      <Task
        id={`${uid}:review-backlog`}
        output={outputs.review_loop_result}
        skipIf={!exitConditionMet || !hasMinorIssues}
        continueOnFail
      >
        {async () => {
          const backlogPath = `docs/review-backlog/${uid}.md`;
          const markdown = buildBacklogMarkdown({
            unitId: uid,
            unitName: unit.name,
            branchPrefix,
            iterationCount,
            codeIssues: codeMinorIssues,
            prdIssues: prdMinorIssues,
          });

          await mkdir(dirname(backlogPath), { recursive: true });
          await writeFile(backlogPath, markdown, "utf8");

          return {
            iterationCount,
            codeSeverity,
            prdSeverity,
            passed: true,
            exhausted: false,
          };
        }}
      </Task>
    </Sequence>
  );
}
