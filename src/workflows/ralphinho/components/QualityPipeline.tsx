import React from "react";
import { Task, Sequence, Worktree } from "smithers-orchestrator";
import type { SmithersCtx, AgentLike } from "smithers-orchestrator";
import type { WorkUnit, WorkPlan } from "../types";
import { scheduledOutputSchemas } from "../schemas";
import type { Issue } from "../schemas";

import ResearchPrompt from "../prompts/Research.mdx";
import PlanPrompt from "../prompts/Plan.mdx";
import ImplementPrompt from "../prompts/Implement.mdx";
import LearningsExtractionPrompt from "../prompts/LearningsExtraction.mdx";
import { buildUnitWorktreePath } from "./runtimeNames";
import { ReviewLoop } from "./ReviewLoop";
import {
  STAGE_RETRY_POLICIES,
  stageNodeId,
  TIER_STAGES,
} from "../workflow/contracts";
import type { ScheduledTier, StageName } from "../workflow/contracts";

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

function tierHasStep(tier: ScheduledTier, step: string): boolean {
  return (TIER_STAGES[tier] as readonly string[]).includes(step);
}

function buildReviewFeedback(parts: Array<string | null | undefined>): string | undefined {
  const lines = parts
    .filter(Boolean)
    .map((p) => String(p).trim())
    .filter((p) => p.length > 0);
  return lines.length > 0 ? lines.join("\n\n") : undefined;
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
  const learnings = ctx.latest("learnings", stageNodeId(uid, "learnings"));

  const combinedReviewFeedback = buildReviewFeedback([
    prdReview?.feedback ? `PRD review feedback:\n${prdReview.feedback}` : null,
    codeReview?.feedback ? `Code review feedback:\n${codeReview.feedback}` : null,
  ]);

  const verifyCommands = [
    ...Object.values(workPlan.repo.buildCmds),
    ...Object.values(workPlan.repo.testCmds),
  ];
  const researchInputSignature = JSON.stringify({
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
  const planInputSignature = JSON.stringify({
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
            retries={STAGE_RETRY_POLICIES["research"].retries}
            meta={{ retryPolicy: STAGE_RETRY_POLICIES["research"] }}
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
            retries={STAGE_RETRY_POLICIES["plan"].retries}
            meta={{
              dependsOn: [stageNodeId(uid, "research")],
              retryPolicy: STAGE_RETRY_POLICIES["plan"],
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
          retries={STAGE_RETRY_POLICIES["implement"].retries}
          meta={{ dependsOn: implementDependsOn, retryPolicy: STAGE_RETRY_POLICIES["implement"] }}
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

        <ReviewLoop
          unit={unit}
          ctx={ctx}
          outputs={outputs}
          agents={{
            tester: agents.tester,
            prdReviewer: agents.prdReviewer,
            codeReviewer: agents.codeReviewer,
            reviewFixer: agents.reviewFixer,
          }}
          fallbacks={fallbacks ? {
            tester: fallbacks.tester,
            prdReviewer: fallbacks.prdReviewer,
            codeReviewer: fallbacks.codeReviewer,
            reviewFixer: fallbacks.reviewFixer,
          } : undefined}
          implOutput={impl}
          testSuites={testSuites}
          verifyCommands={verifyCommands}
          branchPrefix={branchPrefix}
        />

        {tierHasStep(tier, "learnings") && agents.learningsExtractor && (
          <Task
            id={stageNodeId(uid, "learnings")}
            output={outputs.learnings}
            agent={agents.learningsExtractor}
            fallbackAgent={fallbacks?.learningsExtractor}
            retries={STAGE_RETRY_POLICIES["learnings"].retries}
            meta={{
              dependsOn: [`${uid}:review-loop`],
              retryPolicy: STAGE_RETRY_POLICIES["learnings"],
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
              finalReviewApproved={false}
              finalReviewReasoning={null}
              learningsFilePath={learnings?.learningsFilePath ?? `docs/learnings/${uid}.md`}
              branchPrefix={branchPrefix}
            />
          </Task>
        )}
      </Sequence>
    </Worktree>
  );
}
