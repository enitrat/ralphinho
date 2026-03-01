import React from "react";
import { Task, Sequence, Parallel, Worktree } from "smithers-orchestrator";
import type { SmithersCtx, AgentLike } from "smithers-orchestrator";
import { SCHEDULED_TIERS, type WorkUnit, type WorkPlan } from "../scheduled/types";
import { scheduledOutputSchemas } from "../scheduled/schemas";

import ResearchPrompt from "../prompts/Research.mdx";
import PlanPrompt from "../prompts/Plan.mdx";
import ImplementPrompt from "../prompts/Implement.mdx";
import TestPrompt from "../prompts/Test.mdx";
import PrdReviewPrompt from "../prompts/PrdReview.mdx";
import CodeReviewPrompt from "../prompts/CodeReview.mdx";
import ReviewFixPrompt from "../prompts/ReviewFix.mdx";
import FinalReviewPrompt from "../prompts/FinalReview.mdx";

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
};

export type QualityPipelineProps = {
  unit: WorkUnit;
  ctx: SmithersCtx<ScheduledOutputs>;
  outputs: ScheduledOutputs;
  agents: QualityPipelineAgents;
  workPlan: WorkPlan;
  depSummaries: DepSummary[];
  evictionContext: string | null;
  pass?: number;
  maxPasses?: number;
  retries?: number;
  branchPrefix?: string;
};

function tierHasStep(tier: string, step: string): boolean {
  const stages = SCHEDULED_TIERS[tier as keyof typeof SCHEDULED_TIERS];
  return stages
    ? (stages as readonly string[]).includes(step)
    : (SCHEDULED_TIERS.large as readonly string[]).includes(step);
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
  workPlan,
  depSummaries,
  evictionContext,
  pass = 0,
  maxPasses = 3,
  retries = 1,
  branchPrefix = "unit/",
}: QualityPipelineProps) {
  const uid = unit.id;
  const tier = unit.tier;

  // In Ralph loops, cross-stage reads must use latest() to see prior iterations.
  const research = ctx.latest("research", `${uid}:research`);
  const plan = ctx.latest("plan", `${uid}:plan`);
  const impl = ctx.latest("implement", `${uid}:implement`);
  const test = ctx.latest("test", `${uid}:test`);
  const prdReview = ctx.latest("prd_review", `${uid}:prd-review`);
  const codeReview = ctx.latest("code_review", `${uid}:code-review`);
  const reviewFix = ctx.latest("review_fix", `${uid}:review-fix`);
  const finalReview = ctx.latest("final_review", `${uid}:final-review`);

  const combinedReviewFeedback = buildReviewFeedback([
    finalReview?.reasoning ? `Final review feedback:\n${finalReview.reasoning}` : null,
    prdReview?.feedback ? `PRD review feedback:\n${prdReview.feedback}` : null,
    codeReview?.feedback ? `Code review feedback:\n${codeReview.feedback}` : null,
  ]);

  const verifyCommands = [
    ...Object.values(workPlan.repo.buildCmds),
    ...Object.values(workPlan.repo.testCmds),
  ];

  const testSuites = buildTestSuites(workPlan);

  const bothApproved =
    (prdReview?.approved ?? !tierHasStep(tier, "prd-review")) &&
    (codeReview?.approved ?? false);

  return (
    <Worktree path={`/tmp/workflow-wt-${uid}`} branch={`${branchPrefix}${uid}`}>
      <Sequence>
        {tierHasStep(tier, "research") && (
          <Task
            id={`${uid}:research`}
            output={outputs.research}
            agent={agents.researcher}
            retries={retries}
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
              contextFilePath={research?.contextFilePath ?? `docs/research/${uid}.md`}
              branchPrefix={branchPrefix}
            />
          </Task>
        )}

        {tierHasStep(tier, "plan") && (
          <Task
            id={`${uid}:plan`}
            output={outputs.plan}
            agent={agents.planner}
            retries={retries}
          >
            <PlanPrompt
              unitId={uid}
              unitName={unit.name}
              unitDescription={unit.description}
              unitCategory={tier}
              acceptanceCriteria={unit.acceptance}
              contextFilePath={research?.contextFilePath ?? `docs/research/${uid}.md`}
              researchSummary={research?.findings?.join?.("\n") ?? null}
              evictionContext={evictionContext}
              tddPatterns={[]}
              planFilePath={plan?.planFilePath ?? `docs/plans/${uid}.md`}
              commitPrefix="📝"
              branchPrefix={branchPrefix}
            />
          </Task>
        )}

        <Task
          id={`${uid}:implement`}
          output={outputs.implement}
          agent={agents.implementer}
          retries={retries}
        >
          <ImplementPrompt
            unitId={uid}
            unitName={unit.name}
            unitCategory={tier}
            planFilePath={plan?.planFilePath ?? `docs/plans/${uid}.md`}
            contextFilePath={research?.contextFilePath ?? `docs/research/${uid}.md`}
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
          id={`${uid}:test`}
          output={outputs.test}
          agent={agents.tester}
          retries={retries}
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
              id={`${uid}:prd-review`}
              output={outputs.prd_review}
              agent={agents.prdReviewer}
              retries={retries}
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
              id={`${uid}:code-review`}
              output={outputs.code_review}
              agent={agents.codeReviewer}
              retries={retries}
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
            id={`${uid}:review-fix`}
            output={outputs.review_fix}
            agent={agents.reviewFixer}
            retries={retries}
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
            id={`${uid}:final-review`}
            output={outputs.final_review}
            agent={agents.finalReviewer}
            retries={retries}
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
      </Sequence>
    </Worktree>
  );
}
