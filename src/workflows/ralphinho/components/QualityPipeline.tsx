import React from "react";
import { Task, Sequence, Parallel, Worktree } from "smithers-orchestrator";
import type { SmithersCtx, AgentLike } from "smithers-orchestrator";
import type { WorkUnit, WorkPlan } from "../types";
import { scheduledOutputSchemas } from "../schemas";

import ResearchPrompt from "../prompts/Research.mdx";
import PlanPrompt from "../prompts/Plan.mdx";
import ImplementPrompt from "../prompts/Implement.mdx";
import TestPrompt from "../prompts/Test.mdx";
import PrdReviewPrompt from "../prompts/PrdReview.mdx";
import CodeReviewPrompt from "../prompts/CodeReview.mdx";
import ReviewFixPrompt from "../prompts/ReviewFix.mdx";
import FinalReviewPrompt from "../prompts/FinalReview.mdx";
import LearningsExtractionPrompt from "../prompts/LearningsExtraction.mdx";
import { buildUnitWorktreePath } from "./runtimeNames";
import {
  buildPlanInputSignature,
  buildResearchInputSignature,
  FINAL_REVIEW_RETRIES,
  FINAL_REVIEW_RETRY_POLICY,
  IMPLEMENT_RETRIES,
  IMPLEMENT_RETRY_POLICY,
  LEARNINGS_RETRIES,
  LEARNINGS_RETRY_POLICY,
  PLAN_RETRIES,
  PLAN_RETRY_POLICY,
  RESEARCH_RETRIES,
  RESEARCH_RETRY_POLICY,
  REVIEW_FIX_RETRIES,
  REVIEW_FIX_RETRY_POLICY,
  REVIEW_RETRIES,
  REVIEW_RETRY_POLICY,
  stageNodeId,
  TEST_RETRIES,
  TEST_RETRY_POLICY,
  TIER_STAGES,
} from "../workflow/contracts";

export type ScheduledOutputs = typeof scheduledOutputSchemas;

export type DepSummary = {
  id: string;
  whatWasDone: string;
  filesCreated: string[];
  filesModified: string[];
};

export type QualityPipelineAgents = {
  researcher: AgentLike | AgentLike[];
  planner: AgentLike | AgentLike[];
  implementer: AgentLike | AgentLike[];
  tester: AgentLike | AgentLike[];
  prdReviewer: AgentLike | AgentLike[];
  codeReviewer: AgentLike | AgentLike[];
  reviewFixer: AgentLike | AgentLike[];
  finalReviewer: AgentLike | AgentLike[];
  learningsExtractor?: AgentLike | AgentLike[];
};

/** Single fallback agents per role (used with Task's fallbackAgent prop). */
export type QualityPipelineFallbacks = Partial<{
  [K in keyof QualityPipelineAgents]: AgentLike;
}>;

export type QualityPipelineProps = {
  unit: WorkUnit;
  ctx: SmithersCtx<ScheduledOutputs>;
  outputs: ScheduledOutputs;
  agents: QualityPipelineAgents;
  fallbacks?: QualityPipelineFallbacks;
  workPlan: WorkPlan;
  depSummaries: DepSummary[];
  evictionContext: string | null;
  pass?: number;
  maxPasses?: number;
  branchPrefix?: string;
  worktreePath?: string;
};

function tierHasStep(tier: string, step: string): boolean {
  const stages = TIER_STAGES[tier as keyof typeof TIER_STAGES];
  return stages
    ? (stages as readonly string[]).includes(step)
    : (TIER_STAGES.large as readonly string[]).includes(step);
}

function buildReviewFeedback(parts: Array<string | null | undefined>): string | undefined {
  const lines = parts
    .filter(Boolean)
    .map((p) => String(p).trim())
    .filter((p) => p.length > 0);
  return lines.length > 0 ? lines.join("\n\n") : undefined;
}

function buildIssueList(issues: unknown): string[] {
  if (!Array.isArray(issues)) return [];
  return issues.map((issue) => {
    const entry = issue as {
      severity?: string;
      description?: string;
      file?: string | null;
    };
    const sev = entry.severity ? `[${entry.severity}] ` : "";
    const desc = entry.description ?? "Unspecified issue";
    const file = entry.file ? ` (${entry.file})` : "";
    return `${sev}${desc}${file}`;
  });
}

function buildTestSuites(workPlan: WorkPlan): Array<{ name: string; command: string; description: string }> {
  const suites: Array<{ name: string; command: string; description: string }> = [];

  for (const [name, command] of Object.entries(workPlan.repo.buildCmds)) {
    suites.push({ name: `Build: ${name}`, command, description: "Build or typecheck validation" });
  }
  for (const [name, command] of Object.entries(workPlan.repo.testCmds)) {
    suites.push({ name: `Test: ${name}`, command, description: "Automated test suite" });
  }

  return suites;
}

export function QualityPipeline({
  unit,
  ctx,
  outputs,
  agents,
  fallbacks,
  workPlan,
  depSummaries,
  evictionContext,
  pass = 0,
  maxPasses = 3,
  branchPrefix = "unit/",
  worktreePath,
}: QualityPipelineProps) {
  const uid = unit.id;
  const tier = unit.tier;

  // In Ralph loops, cross-stage reads must use latest() to see prior iterations.
  const research = ctx.latest("research", stageNodeId(uid, "research"));
  const plan = ctx.latest("plan", stageNodeId(uid, "plan"));
  const impl = ctx.latest("implement", stageNodeId(uid, "implement"));
  const test = ctx.latest("test", stageNodeId(uid, "test"));
  const prdReview = ctx.latest("prd_review", stageNodeId(uid, "prd-review"));
  const codeReview = ctx.latest("code_review", stageNodeId(uid, "code-review"));
  const reviewFix = ctx.latest("review_fix", stageNodeId(uid, "review-fix"));
  const finalReview = ctx.latest("final_review", stageNodeId(uid, "final-review"));
  const learnings = ctx.latest("learnings", stageNodeId(uid, "learnings"));

  const combinedReviewFeedback = buildReviewFeedback([
    finalReview?.reasoning ? `Final review feedback:\n${finalReview.reasoning}` : null,
    prdReview?.feedback ? `PRD review feedback:\n${prdReview.feedback}` : null,
    codeReview?.feedback ? `Code review feedback:\n${codeReview.feedback}` : null,
  ]);

  const verifyCommands = [
    ...Object.values(workPlan.repo.buildCmds),
    ...Object.values(workPlan.repo.testCmds),
  ];
  const researchInputSignature = buildResearchInputSignature({
    unitId: uid,
    unitName: unit.name,
    unitDescription: unit.description,
    unitCategory: tier,
    rfcSource: workPlan.source,
    rfcSections: unit.rfcSections,
    referencePaths: [workPlan.source],
    evictionContext,
  });
  const researchSummary = research?.findings && research.findings.length > 0
    ? research.findings.join("\n")
    : undefined;
  const expectedContextFilePath = `docs/research/${uid}.md`;
  const planInputSignature = buildPlanInputSignature({
    unitId: uid,
    unitName: unit.name,
    unitDescription: unit.description,
    unitCategory: tier,
    acceptanceCriteria: unit.acceptance,
    contextFilePath: research?.contextFilePath ?? expectedContextFilePath,
    researchSummary,
    evictionContext,
  });
  const implementDependsOn = tierHasStep(tier, "plan") ? [stageNodeId(uid, "plan")] : [];

  const testSuites = buildTestSuites(workPlan);

  const bothApproved =
    (prdReview?.approved ?? !tierHasStep(tier, "prd-review")) &&
    (codeReview?.approved ?? false);

  const effectiveWorktreePath = worktreePath ?? buildUnitWorktreePath(ctx.runId, uid);

  return (
    <Worktree path={effectiveWorktreePath} branch={`${branchPrefix}${uid}`}>
      <Sequence>
        {tierHasStep(tier, "research") && (
          <Task
            id={stageNodeId(uid, "research")}
            output={outputs.research}
            agent={agents.researcher}
            fallbackAgent={fallbacks?.researcher}
            retries={RESEARCH_RETRIES}
            meta={{ retryPolicy: RESEARCH_RETRY_POLICY }}
            // Cache semantics: reuse only when the prior output matches current inputs.
            skipIf={research?.inputSignature === researchInputSignature}
          >
            <ResearchPrompt
              unitId={uid}
              unitName={unit.name}
              unitDescription={unit.description}
              unitCategory={tier}
              evictionContext={evictionContext}
              rfcSource={workPlan.source}
              rfcSections={unit.rfcSections}
              referencePaths={[workPlan.source]}
              referenceFiles={[]}
              relevantFiles={[]}
              contextFilePath={research?.contextFilePath ?? expectedContextFilePath}
              inputSignature={researchInputSignature}
              branchPrefix={branchPrefix}
            />
          </Task>
        )}

        {tierHasStep(tier, "plan") && (
          <Task
            id={stageNodeId(uid, "plan")}
            output={outputs.plan}
            agent={agents.planner}
            fallbackAgent={fallbacks?.planner}
            retries={PLAN_RETRIES}
            meta={{
              dependsOn: [stageNodeId(uid, "research")],
              retryPolicy: PLAN_RETRY_POLICY,
            }}
            // Cache semantics: reuse only when the prior output matches current inputs.
            skipIf={plan?.inputSignature === planInputSignature}
          >
            <PlanPrompt
              unitId={uid}
              unitName={unit.name}
              unitDescription={unit.description}
              unitCategory={tier}
              acceptanceCriteria={unit.acceptance}
              contextFilePath={research?.contextFilePath ?? expectedContextFilePath}
              researchSummary={researchSummary ?? null}
              evictionContext={evictionContext}
              tddPatterns={[]}
              planFilePath={plan?.planFilePath ?? `docs/plans/${uid}.md`}
              inputSignature={planInputSignature}
              commitPrefix="📝"
              branchPrefix={branchPrefix}
            />
          </Task>
        )}

        <Task
          id={stageNodeId(uid, "implement")}
          output={outputs.implement}
          agent={agents.implementer}
          fallbackAgent={fallbacks?.implementer}
          retries={IMPLEMENT_RETRIES}
          meta={{ dependsOn: implementDependsOn, retryPolicy: IMPLEMENT_RETRY_POLICY }}
          // No cache: implementation must re-run against latest review context.
        >
          <ImplementPrompt
            unitId={uid}
            unitName={unit.name}
            unitCategory={tier}
            planFilePath={plan?.planFilePath ?? `docs/plans/${uid}.md`}
            contextFilePath={research?.contextFilePath ?? expectedContextFilePath}
            implementationSteps={plan?.implementationSteps ?? []}
            previousImplementation={impl ?? null}
            evictionContext={evictionContext}
            reviewFeedback={combinedReviewFeedback}
            failingTests={test?.testsPassed ? null : (test?.failingSummary ?? null)}
            acceptanceCriteria={unit.acceptance}
            depSummaries={depSummaries}
            testWritingGuidance={[]}
            implementationGuidance={[]}
            formatterCommands={[]}
            verifyCommands={verifyCommands}
            architectureRules={[]}
            commitPrefix="feat"
            emojiPrefixes="feat, fix, refactor, chore, test, docs"
            branchPrefix={branchPrefix}
          />
        </Task>

        <Task
          id={stageNodeId(uid, "test")}
          output={outputs.test}
          agent={agents.tester}
          fallbackAgent={fallbacks?.tester}
          retries={TEST_RETRIES}
          meta={{
            dependsOn: [stageNodeId(uid, "implement")],
            retryPolicy: TEST_RETRY_POLICY,
          }}
          // No cache: tests must run against the current implementation state.
        >
          <TestPrompt
            unitId={uid}
            unitName={unit.name}
            unitCategory={tier}
            whatWasDone={impl?.whatWasDone ?? "Unknown"}
            filesCreated={impl?.filesCreated ?? []}
            filesModified={impl?.filesModified ?? []}
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
              retries={REVIEW_RETRIES}
              meta={{
                dependsOn: [stageNodeId(uid, "implement")],
                retryPolicy: REVIEW_RETRY_POLICY,
              }}
              // No cache: review should evaluate latest implementation/test context.
              continueOnFail
            >
              <PrdReviewPrompt
                unitId={uid}
                unitName={unit.name}
                unitCategory={tier}
                acceptanceCriteria={unit.acceptance}
                filesCreated={impl?.filesCreated ?? []}
                filesModified={impl?.filesModified ?? []}
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
              retries={REVIEW_RETRIES}
              meta={{
                dependsOn: [stageNodeId(uid, "implement")],
                retryPolicy: REVIEW_RETRY_POLICY,
              }}
              // No cache: review should evaluate latest implementation/test context.
              continueOnFail
            >
              <CodeReviewPrompt
                unitId={uid}
                unitName={unit.name}
                unitCategory={tier}
                whatWasDone={impl?.whatWasDone ?? "Unknown"}
                filesCreated={impl?.filesCreated ?? []}
                filesModified={impl?.filesModified ?? []}
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
            retries={REVIEW_FIX_RETRIES}
            meta={{
              dependsOn: [
                stageNodeId(uid, "prd-review"),
                stageNodeId(uid, "code-review"),
              ],
              retryPolicy: REVIEW_FIX_RETRY_POLICY,
            }}
            // No cache: fix output is stateful and tied to current review findings.
            skipIf={bothApproved}
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

        {tierHasStep(tier, "final-review") && (
          <Task
            id={stageNodeId(uid, "final-review")}
            output={outputs.final_review}
            agent={agents.finalReviewer}
            fallbackAgent={fallbacks?.finalReviewer}
            retries={FINAL_REVIEW_RETRIES}
            meta={{
              dependsOn: [stageNodeId(uid, "review-fix")],
              retryPolicy: FINAL_REVIEW_RETRY_POLICY,
            }}
            // No cache: final gate should always evaluate latest stage artifacts.
          >
            <FinalReviewPrompt
              unitId={uid}
              unitName={unit.name}
              description={unit.description}
              acceptanceCriteria={unit.acceptance}
              pass={pass + 1}
              maxPasses={maxPasses}
              implSummary={impl?.whatWasDone ?? null}
              believesComplete={impl?.believesComplete ?? false}
              buildPassed={test?.buildPassed ?? null}
              testsPassCount={test?.testsPassCount ?? 0}
              testsFailCount={test?.testsFailCount ?? 0}
              failingSummary={test?.failingSummary ?? null}
              prdSeverity={prdReview?.severity ?? null}
              prdApproved={prdReview?.approved ?? null}
              codeSeverity={codeReview?.severity ?? null}
              codeApproved={codeReview?.approved ?? null}
              issuesResolved={reviewFix?.allIssuesResolved ?? null}
            />
          </Task>
        )}

        {tierHasStep(tier, "learnings") && agents.learningsExtractor && (
          <Task
            id={stageNodeId(uid, "learnings")}
            output={outputs.learnings}
            agent={agents.learningsExtractor}
            fallbackAgent={fallbacks?.learningsExtractor}
            retries={LEARNINGS_RETRIES}
            meta={{
              dependsOn: [stageNodeId(uid, "final-review")],
              retryPolicy: LEARNINGS_RETRY_POLICY,
            }}
            // Cache semantics: learnings are write-once per unit — do not re-extract on subsequent passes.
            skipIf={learnings != null}
            continueOnFail
          >
            <LearningsExtractionPrompt
              unitId={uid}
              unitName={unit.name}
              unitCategory={tier}
              codeReviewSeverity={codeReview?.severity ?? "none"}
              codeReviewFeedback={codeReview?.feedback ?? null}
              codeReviewIssues={buildIssueList(codeReview?.issues)}
              prdReviewSeverity={prdReview?.severity ?? "none"}
              prdReviewFeedback={prdReview?.feedback ?? null}
              reviewFixSummary={reviewFix?.summary ?? null}
              reviewFixFalsePositives={
                reviewFix?.falsePositives?.map(
                  (fp) => `${fp.issue}: ${fp.reasoning}`,
                ) ?? []
              }
              finalReviewApproved={finalReview?.approved ?? false}
              finalReviewReasoning={finalReview?.reasoning ?? null}
              learningsFilePath={learnings?.learningsFilePath ?? `docs/learnings/${uid}.md`}
              branchPrefix={branchPrefix}
            />
          </Task>
        )}
      </Sequence>
    </Worktree>
  );
}
