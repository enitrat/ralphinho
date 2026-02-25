/**
 * Renders a Smithers workflow.tsx for Scheduled Work mode.
 *
 * The generated workflow:
 * 1. Loads work-plan.json at startup
 * 2. Uses a Ralph loop to process work units layer by layer (DAG-driven)
 * 3. Each layer runs units in Parallel (with Worktrees for isolation)
 * 4. Each unit runs through the quality pipeline:
 *    Research → Plan → Implement → Test → PRD-Review + Code-Review (parallel) → ReviewFix → FinalReview
 * 5. Completed units feed into an AgenticMergeQueue
 *
 * Unlike super-ralph's AI-driven scheduler, this is deterministic:
 * the DAG determines parallelism and ordering.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { ralphSourceRoot, runningFromSource } from "./shared";

export function renderScheduledWorkflow(params: {
  repoRoot: string;
  dbPath: string;
  planPath: string;
  detectedAgents: { claude: boolean; codex: boolean; gh: boolean };
  maxConcurrency: number;
}): string {
  const { repoRoot, dbPath, planPath, detectedAgents, maxConcurrency } =
    params;

  // Determine import prefix
  const isSuperRalphRepo =
    existsSync(join(repoRoot, "src/components/SuperRalph.tsx")) &&
    existsSync(join(repoRoot, "src/schemas.ts"));

  let importPrefix: string;
  if (isSuperRalphRepo) {
    importPrefix = "../../src";
  } else if (runningFromSource) {
    importPrefix = ralphSourceRoot + "/src";
  } else {
    importPrefix = "super-ralph";
  }

  return `import React from "react";
import { readFileSync } from "node:fs";
import { createSmithers, ClaudeCodeAgent, CodexAgent, Ralph, Sequence, Parallel, Task, Worktree } from "smithers-orchestrator";
import { scheduledOutputSchemas } from "${importPrefix}/scheduled/schemas";

// ── Constants ─────────────────────────────────────────────────────────

const REPO_ROOT = ${JSON.stringify(repoRoot)};
const DB_PATH = ${JSON.stringify(dbPath)};
const PLAN_PATH = ${JSON.stringify(planPath)};
const HAS_CLAUDE = ${detectedAgents.claude};
const HAS_CODEX = ${detectedAgents.codex};
const MAX_CONCURRENCY = ${maxConcurrency};
const MAX_PASSES = 3; // Max review-fix iterations per unit

// ── Load work plan ────────────────────────────────────────────────────

const workPlan = JSON.parse(readFileSync(PLAN_PATH, "utf8"));
const units = workPlan.units;

// Compute layers (topological groups)
function computeLayers(units: any[]): any[][] {
  const unitMap = new Map(units.map((u: any) => [u.id, u]));
  const layerOf = new Map();

  function getLayer(id: string): number {
    if (layerOf.has(id)) return layerOf.get(id);
    const unit = unitMap.get(id);
    if (!unit || unit.deps.length === 0) {
      layerOf.set(id, 0);
      return 0;
    }
    const maxDepLayer = Math.max(...unit.deps.map((d: string) => getLayer(d)));
    const layer = maxDepLayer + 1;
    layerOf.set(id, layer);
    return layer;
  }

  for (const unit of units) getLayer(unit.id);

  const maxLayer = Math.max(...Array.from(layerOf.values()), 0);
  const layers: any[][] = [];
  for (let i = 0; i <= maxLayer; i++) {
    layers.push(units.filter((u: any) => layerOf.get(u.id) === i));
  }
  return layers;
}

const layers = computeLayers(units);

// ── Agent setup ───────────────────────────────────────────────────────

const WORKSPACE_POLICY = \`
## WORKSPACE POLICY
Uncommitted changes in the worktree are expected and normal.
Do NOT refuse to work because of dirty git state. Proceed with implementation regardless.
\`;

const JSON_OUTPUT = \`
## CRITICAL: Output Rules
1. ALWAYS wait for ALL tasks and sub-agents to fully complete before producing final output.
2. Your FINAL message MUST end with a JSON object wrapped in a code fence.
3. Background tasks: if you used run_in_background: true, you MUST call TaskOutput to retrieve
   every background task's result before writing your final JSON.
\`;

function buildSystemPrompt(role: string): string {
  return ["# Role: " + role, WORKSPACE_POLICY, JSON_OUTPUT].join("\\n\\n");
}

function createClaude(role: string) {
  return new ClaudeCodeAgent({
    model: "claude-sonnet-4-6",
    systemPrompt: buildSystemPrompt(role),
    cwd: REPO_ROOT,
    dangerouslySkipPermissions: true,
    timeoutMs: 60 * 60 * 1000,
  });
}

function createCodex(role: string) {
  return new CodexAgent({
    model: "gpt-5.3-codex",
    systemPrompt: buildSystemPrompt(role),
    cwd: REPO_ROOT,
    yolo: true,
    timeoutMs: 60 * 60 * 1000,
  });
}

function chooseAgent(primary: "claude" | "codex", role: string) {
  if (primary === "claude" && HAS_CLAUDE) return createClaude(role);
  if (primary === "codex" && HAS_CODEX) return createCodex(role);
  if (HAS_CLAUDE) return createClaude(role);
  return createCodex(role);
}

const researcher = chooseAgent("claude", "Researcher — Gather context from codebase for implementation");
const planner = chooseAgent("claude", "Planner — Create implementation plan from RFC section and context");
const implementer = chooseAgent("codex", "Implementer — Write code following the plan");
const tester = chooseAgent("claude", "Tester — Run tests and validate implementation");
const prdReviewer = chooseAgent("claude", "PRD Reviewer — Verify implementation matches RFC specification");
const codeReviewer = chooseAgent("claude", "Code Reviewer — Check code quality, conventions, security");
const reviewFixer = chooseAgent("codex", "ReviewFixer — Fix issues found in code review");
const finalReviewer = chooseAgent("claude", "Final Reviewer — Decide if unit is complete");

// ── Smithers setup ────────────────────────────────────────────────────

const { smithers, outputs, Workflow } = createSmithers(
  scheduledOutputSchemas,
  { dbPath: DB_PATH }
);

// ── Workflow ──────────────────────────────────────────────────────────

export default smithers((ctx) => {
  // Check unit completion — tier-aware: each tier completes at its last stage
  const unitComplete = (unitId: string): boolean => {
    const unit = units.find((u: any) => u.id === unitId);
    const tier = unit?.tier ?? "large";

    // All tiers require tests to pass
    const test = ctx.latest("sw_test", unitId + ":test");
    if (!test?.testsPassed || !test?.buildPassed) return false;

    switch (tier) {
      case "trivial":
        return true; // build + tests passing is sufficient
      case "small": {
        const cr = ctx.latest("sw_code_review", unitId + ":code-review");
        return cr?.approved ?? false;
      }
      case "medium": {
        // If both reviews approved, review-fix is skipped → unit is complete
        const prd = ctx.latest("sw_prd_review", unitId + ":prd-review");
        const cr = ctx.latest("sw_code_review", unitId + ":code-review");
        if ((prd?.approved ?? false) && (cr?.approved ?? false)) return true;
        // Otherwise check review-fix result
        const rf = ctx.latest("sw_review_fix", unitId + ":review-fix");
        return rf?.allIssuesResolved ?? false;
      }
      case "large":
      default: {
        const fr = ctx.latest("sw_final_review", unitId + ":final-review");
        return fr?.readyToMoveOn ?? false;
      }
    }
  };

  // Check if tier requires a step
  const tierHasStep = (tier: string, step: string): boolean => {
    const TIERS: Record<string, string[]> = {
      trivial: ["implement", "test"],
      small: ["implement", "test", "code-review"],
      medium: ["research", "plan", "implement", "test", "prd-review", "code-review", "review-fix"],
      large: ["research", "plan", "implement", "test", "prd-review", "code-review", "review-fix", "final-review"],
    };
    return (TIERS[tier] ?? TIERS.large).includes(step);
  };

  // Pass tracking
  const passTracker = ctx.latest("sw_pass_tracker", "pass-tracker");
  const currentPass = passTracker?.totalIterations ?? 0;

  const allUnitsComplete = units.every((u: any) => unitComplete(u.id));
  const done = currentPass >= MAX_PASSES || allUnitsComplete;

  // Completed unit IDs for merge queue
  const completedUnitIds = units
    .filter((u: any) => unitComplete(u.id))
    .map((u: any) => u.id);

  return (
    <Workflow name="scheduled-work" cache>
      <Ralph until={done} maxIterations={MAX_PASSES * units.length * 20} onMaxReached="return-last">
        <Sequence>
          {/* Process each layer sequentially; units within a layer run in parallel */}
          {layers.map((layer: any[], layerIdx: number) => (
            <Parallel key={"layer-" + layerIdx} maxConcurrency={MAX_CONCURRENCY}>
              {layer.map((unit: any) => {
                const uid = unit.id;
                if (unitComplete(uid)) return null;

                // Read prior outputs for this unit
                const research = ctx.outputMaybe("sw_research", { nodeId: uid + ":research" });
                const plan = ctx.outputMaybe("sw_plan", { nodeId: uid + ":plan" });
                const impl = ctx.outputMaybe("sw_implement", { nodeId: uid + ":implement" });
                const test = ctx.outputMaybe("sw_test", { nodeId: uid + ":test" });
                const prdReview = ctx.outputMaybe("sw_prd_review", { nodeId: uid + ":prd-review" });
                const codeReview = ctx.outputMaybe("sw_code_review", { nodeId: uid + ":code-review" });
                const reviewFix = ctx.outputMaybe("sw_review_fix", { nodeId: uid + ":review-fix" });
                const finalReview = ctx.outputMaybe("sw_final_review", { nodeId: uid + ":final-review" });

                return (
                  <Worktree key={uid} path={"/tmp/workflow-wt-" + uid}>
                    <Sequence>
                      {/* Research (large/medium only) */}
                      {tierHasStep(unit.tier, "research") && (
                        <Task
                          id={uid + ":research"}
                          output={outputs.sw_research}
                          agent={researcher}
                        >
                          {\`# Research: \${unit.name}

## RFC File
\${workPlan.source}
Read this file first — it contains the full specification.

## RFC Section(s): \${unit.rfcSections.join(", ")}

## Description
\${unit.description}

## Task
Gather all context needed to implement this work unit:
1. Read the RFC file at the path above, focusing on the referenced sections
2. Read relevant source files in the codebase
3. Identify existing patterns, types, and interfaces
4. Note any dependencies on other modules
5. Write a context document summarizing your findings
6. Commit the context document

## Output
Return JSON with: contextFilePath, findings (array), referencesRead (array), openQuestions (array)\`}
                        </Task>
                      )}

                      {/* Plan (large/medium only) */}
                      {tierHasStep(unit.tier, "plan") && (
                        <Task
                          id={uid + ":plan"}
                          output={outputs.sw_plan}
                          agent={planner}
                        >
                          {\`# Plan: \${unit.name}

## RFC Section(s): \${unit.rfcSections.join(", ")}

## Description
\${unit.description}

## Research Context
\${research?.contextFilePath ? "Read the context document at: " + research.contextFilePath : "No research context available."}
\${research?.findings ? "Key findings:\\n- " + (Array.isArray(research.findings) ? research.findings.join("\\n- ") : research.findings) : ""}

## Acceptance Criteria
\${unit.acceptance.map((a: string, i: number) => (i + 1) + ". " + a).join("\\n")}

## Task
Create a detailed implementation plan:
1. Read the context document
2. Design the implementation with atomic steps
3. Identify files to create and modify
4. Plan the test approach
5. Write the plan document and commit

## Output
Return JSON with: planFilePath, implementationSteps (array), filesToCreate (array), filesToModify (array), complexity\`}
                        </Task>
                      )}

                      {/* Implement */}
                      <Task
                        id={uid + ":implement"}
                        output={outputs.sw_implement}
                        agent={implementer}
                      >
                        {\`# Implement: \${unit.name}

## RFC Section(s): \${unit.rfcSections.join(", ")}

## Description
\${unit.description}

## Acceptance Criteria
\${unit.acceptance.map((a: string, i: number) => (i + 1) + ". " + a).join("\\n")}

\${plan?.planFilePath ? "## Plan\\nRead the plan at: " + plan.planFilePath : ""}
\${plan?.implementationSteps ? "## Steps\\n" + (Array.isArray(plan.implementationSteps) ? plan.implementationSteps.map((s: string, i: number) => (i + 1) + ". " + s).join("\\n") : plan.implementationSteps) : ""}
\${research?.contextFilePath ? "## Context\\nRead the context at: " + research.contextFilePath : ""}

\${impl?.summary ? "## Previous Implementation\\n" + impl.summary : ""}
\${impl?.nextSteps ? "## Previous Next Steps\\n" + impl.nextSteps : ""}
\${finalReview?.reasoning ? "## FINAL REVIEW FEEDBACK (address these issues)\\n" + finalReview.reasoning : ""}
\${prdReview?.feedback ? "## PRD REVIEW FEEDBACK\\n" + prdReview.feedback : ""}
\${codeReview?.feedback ? "## CODE REVIEW FEEDBACK\\n" + codeReview.feedback : ""}
\${test && !test.testsPassed && test.failingSummary ? "## FAILING TESTS (FIX THESE FIRST)\\n" + test.failingSummary : ""}
\${reviewFix?.summary ? "## REVIEW FIX SUMMARY\\n" + reviewFix.summary : ""}

## Build/Test Commands
Build: \${Object.values(workPlan.repo.buildCmds).join(" && ") || "none configured"}
Test: \${Object.values(workPlan.repo.testCmds).join(" && ") || "none configured"}

## Task
1. Read the plan and context documents
2. Implement the changes
3. Run the build after each significant change
4. Write tests alongside the implementation
5. Commit your work

## Output
Return JSON with: summary, filesCreated (array), filesModified (array), whatWasDone, nextSteps (nullable), believesComplete (boolean)\`}
                      </Task>

                      {/* Test */}
                      <Task
                        id={uid + ":test"}
                        output={outputs.sw_test}
                        agent={tester}
                      >
                        {\`# Test: \${unit.name}

## What was implemented
\${impl?.whatWasDone ?? "Unknown"}

## Files created
\${impl?.filesCreated ? (Array.isArray(impl.filesCreated) ? impl.filesCreated.join("\\n- ") : impl.filesCreated) : "None"}

## Files modified
\${impl?.filesModified ? (Array.isArray(impl.filesModified) ? impl.filesModified.join("\\n- ") : impl.filesModified) : "None"}

## Build/Test Commands
Build: \${Object.values(workPlan.repo.buildCmds).join(" && ") || "none configured"}
Test: \${Object.values(workPlan.repo.testCmds).join(" && ") || "none configured"}

## Task
1. Run the build command
2. Run the test suite
3. Analyze any failures
4. Fix compilation errors if possible
5. Report results

## Output
Return JSON with: buildPassed (boolean), testsPassed (boolean), testsPassCount (number), testsFailCount (number), failingSummary (nullable string), testOutput (string)\`}
                      </Task>

                      {/* PRD + Code Review (independent — run in parallel) */}
                      <Parallel continueOnFail>
                        {tierHasStep(unit.tier, "prd-review") && (
                          <Task
                            id={uid + ":prd-review"}
                            output={outputs.sw_prd_review}
                            agent={prdReviewer}
                            continueOnFail
                          >
                            {\`# PRD Review: \${unit.name}

## RFC Section(s): \${unit.rfcSections.join(", ")}

## Acceptance Criteria
\${unit.acceptance.map((a: string, i: number) => (i + 1) + ". " + a).join("\\n")}

## What was implemented
\${impl?.whatWasDone ?? "Unknown"}

## Files created: \${impl?.filesCreated ? (Array.isArray(impl.filesCreated) ? impl.filesCreated.join(", ") : impl.filesCreated) : "None"}
## Files modified: \${impl?.filesModified ? (Array.isArray(impl.filesModified) ? impl.filesModified.join(", ") : impl.filesModified) : "None"}

## Test results
Build passed: \${test?.buildPassed ?? "unknown"}
Tests passed: \${test?.testsPassCount ?? 0} / \${(test?.testsPassCount ?? 0) + (test?.testsFailCount ?? 0)}
\${test?.failingSummary ? "Failures: " + test.failingSummary : ""}

## Task
Review the implementation against the RFC specification and acceptance criteria.
Severity guide: critical (missing core feature), major (spec deviation), minor (style/docs), none (all good)

## Output
Return JSON with: severity ("critical"|"major"|"minor"|"none"), approved (boolean), feedback (string), issues (array of {severity, description, file, suggestion})\`}
                          </Task>
                        )}

                        {tierHasStep(unit.tier, "code-review") && (
                          <Task
                            id={uid + ":code-review"}
                            output={outputs.sw_code_review}
                            agent={codeReviewer}
                            continueOnFail
                          >
                            {\`# Code Review: \${unit.name}

## What was implemented
\${impl?.whatWasDone ?? "Unknown"}

## Files created: \${impl?.filesCreated ? (Array.isArray(impl.filesCreated) ? impl.filesCreated.join(", ") : impl.filesCreated) : "None"}
## Files modified: \${impl?.filesModified ? (Array.isArray(impl.filesModified) ? impl.filesModified.join(", ") : impl.filesModified) : "None"}

## Build passed: \${test?.buildPassed ?? "unknown"}
\${test?.failingSummary ? "Test failures: " + test.failingSummary : ""}

## Task
Review code quality independently of spec compliance. Focus on:
- Error handling and edge cases
- Security (no injection, no secrets in code)
- Test coverage
- Code conventions and consistency
Severity guide: critical (security/crash), major (bugs/missing error handling), minor (style), none (all good)

## Output
Return JSON with: severity ("critical"|"major"|"minor"|"none"), approved (boolean), feedback (string), issues (array of {severity, description, file, suggestion})\`}
                          </Task>
                        )}
                      </Parallel>

                      {/* ReviewFix (medium/large, skip if both reviews approve) */}
                      {tierHasStep(unit.tier, "review-fix") && (
                        <Task
                          id={uid + ":review-fix"}
                          output={outputs.sw_review_fix}
                          agent={reviewFixer}
                          skipIf={
                            (prdReview?.severity === "none" || !tierHasStep(unit.tier, "prd-review")) &&
                            (codeReview?.severity === "none")
                          }
                        >
                          {\`# Review Fix: \${unit.name}

## PRD Review Issues (\${prdReview?.severity ?? "none"})
\${prdReview?.issues ? JSON.stringify(prdReview.issues, null, 2) : "None"}
\${prdReview?.feedback ? "Feedback: " + prdReview.feedback : ""}

## Code Review Issues (\${codeReview?.severity ?? "none"})
\${codeReview?.issues ? JSON.stringify(codeReview.issues, null, 2) : "None"}
\${codeReview?.feedback ? "Feedback: " + codeReview.feedback : ""}

## Build/Test Commands
Build: \${Object.values(workPlan.repo.buildCmds).join(" && ") || "none configured"}
Test: \${Object.values(workPlan.repo.testCmds).join(" && ") || "none configured"}

## Task
1. Address each issue in severity order (critical first)
2. For each issue: fix and commit, or explain why it's a false positive
3. Run build + tests after each fix

## Output
Return JSON with: summary, fixesMade (array of {issue, fix, file}), falsePositives (array of {issue, reasoning}), allIssuesResolved (boolean)\`}
                        </Task>
                      )}

                      {/* Final Review (large only — the gate) */}
                      {tierHasStep(unit.tier, "final-review") && (
                        <Task
                          id={uid + ":final-review"}
                          output={outputs.sw_final_review}
                          agent={finalReviewer}
                        >
                          {\`# Final Review: \${unit.name}

## Pass: \${currentPass + 1} of \${MAX_PASSES}

## Description
\${unit.description}

## Acceptance Criteria
\${unit.acceptance.map((a: string, i: number) => (i + 1) + ". " + a).join("\\n")}

## Implementation Summary
\${impl?.whatWasDone ?? "Unknown"}
Believes complete: \${impl?.believesComplete ?? false}

## Test Results
Build: \${test?.buildPassed ?? "unknown"}
Tests: \${test?.testsPassCount ?? 0} passed, \${test?.testsFailCount ?? 0} failed

## Review Results
PRD: severity=\${prdReview?.severity ?? "n/a"}, approved=\${prdReview?.approved ?? "n/a"}
Code: severity=\${codeReview?.severity ?? "n/a"}, approved=\${codeReview?.approved ?? "n/a"}
Issues resolved: \${reviewFix?.allIssuesResolved ?? "n/a"}

## Decision Criteria for readyToMoveOn: true
- All acceptance criteria met
- Tests pass
- Review severity is none or minor
- Implementation is functionally complete

## Output
Return JSON with: readyToMoveOn (boolean), reasoning (string — CRITICAL: this feeds back to implement on next pass), approved (boolean), qualityScore (1-10), remainingIssues (array of {severity, description, file})\`}
                        </Task>
                      )}
                    </Sequence>
                  </Worktree>
                );
              })}
            </Parallel>
          ))}

          {/* Pass tracker */}
          <Task id="pass-tracker" output={outputs.sw_pass_tracker}>
            {{
              totalIterations: currentPass + 1,
              unitsRun: units.filter((u: any) => !unitComplete(u.id)).map((u: any) => u.id),
              unitsComplete: units.filter((u: any) => unitComplete(u.id)).map((u: any) => u.id),
              summary: \`Pass \${currentPass + 1} of \${MAX_PASSES}. \${completedUnitIds.length}/\${units.length} units complete.\`,
            }}
          </Task>
        </Sequence>
      </Ralph>
    </Workflow>
  );
});
`;
}
