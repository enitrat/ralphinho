/**
 * Renders a Smithers workflow.tsx for Scheduled Work mode.
 *
 * The generated workflow:
 * 1. Loads work-plan.json at startup
 * 2. Uses a Ralph loop to process work units layer by layer (DAG-driven)
 * 3. Each layer has 2 phases:
 *    a. Parallel quality pipelines — each unit runs in an isolated Worktree
 *       on its own branch ("unit/{id}")
 *    b. AgenticMergeQueue task — lands tier-complete units onto main,
 *       evicts units with conflicts (conflict details fed back to implementer)
 *    Land status is read directly from sw_merge_queue outputs — no separate
 *    land-record phase needed.
 * 4. Each unit's quality pipeline:
 *    Research → Plan → Implement → Test → PRD-Review + Code-Review (parallel)
 *    → ReviewFix → FinalReview
 * 5. unitComplete() gates on landed=true — a unit is only "done" once its
 *    changes are confirmed on main. Evicted units re-run on the next Ralph
 *    pass with conflict context injected into the implement prompt.
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
const MAX_PASSES = 3; // Max Ralph iterations before giving up
const MAIN_BRANCH = "main";

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

// Map each unit to its layer index (for reading merge queue outputs)
const unitLayerMap = new Map<string, number>();
layers.forEach((layer: any[], idx: number) => {
  layer.forEach((u: any) => unitLayerMap.set(u.id, idx));
});

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

function createClaude(role: string, model: string = "claude-sonnet-4-6") {
  return new ClaudeCodeAgent({
    model,
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

function chooseAgent(primary: "claude" | "codex" | "opus", role: string) {
  if (primary === "opus" && HAS_CLAUDE) return createClaude(role, "claude-opus-4-6");
  if (primary === "claude" && HAS_CLAUDE) return createClaude(role);
  if (primary === "codex" && HAS_CODEX) return createCodex(role);
  if (HAS_CLAUDE) return createClaude(role);
  return createCodex(role);
}

// ── Merge queue prompt builder ────────────────────────────────────────

function buildMergeQueuePrompt(
  tickets: Array<{ id: string; name: string; filesModified: string[]; filesCreated: string[] }>,
  repoRoot: string,
  mainBranch: string,
  testCmd: string
): string {
  var prompt = "# Merge Queue: Land completed units onto " + mainBranch + "\\n\\n";
  prompt += "Repository: " + repoRoot + "\\n\\n";
  prompt += "## Tickets to land (" + tickets.length + "):\\n\\n";
  for (var i = 0; i < tickets.length; i++) {
    var t = tickets[i];
    prompt += "### " + t.id + ": " + t.name + "\\n";
    prompt += "Branch/workspace: unit/" + t.id + "\\n";
    prompt += "Worktree path: /tmp/workflow-wt-" + t.id + "\\n";
    if (t.filesModified && t.filesModified.length > 0) {
      prompt += "Files modified: " + t.filesModified.join(", ") + "\\n";
    }
    if (t.filesCreated && t.filesCreated.length > 0) {
      prompt += "Files created: " + t.filesCreated.join(", ") + "\\n";
    }
    prompt += "\\n";
  }
  prompt += "## Instructions\\n\\n";
  prompt += "This repository uses jj (Jujutsu VCS), colocated with git.\\n";
  prompt += "Land each ticket onto " + mainBranch + " in order. For each ticket:\\n\\n";
  prompt += "1. Verify the workspace exists: jj workspace list\\n";
  prompt += "2. Switch to the ticket workspace (cd into /tmp/workflow-wt-{id})\\n";
  prompt += "3. Rebase onto " + mainBranch + ": jj rebase -d " + mainBranch + "\\n";
  prompt += "4. IF CONFLICT:\\n";
  prompt += "   - Capture the full conflict details (which files, which lines, competing changes)\\n";
  prompt += "   - Mark this ticket as EVICTED with complete conflict context\\n";
  prompt += "   - Do NOT attempt to resolve the conflict — evict and move on\\n";
  prompt += "5. IF CLEAN REBASE:\\n";
  prompt += "   - Run tests to verify the rebased code still passes: " + testCmd + "\\n";
  prompt += "   - IF TESTS FAIL: mark this ticket as EVICTED with the test failure output as details\\n";
  prompt += "   - IF TESTS PASS: proceed to land\\n";
  prompt += "   - Fast-forward main: jj bookmark set " + mainBranch + " --to @\\n";
  prompt += "   - Push to remote: jj git push --bookmark " + mainBranch + "\\n";
  prompt += "   - Capture the merge commit: jj log -r " + mainBranch + " --no-graph -T 'commit_id.short()'\\n";
  prompt += "   - Mark ticket as LANDED with the commit hash\\n\\n";
  prompt += "Process ALL tickets before returning results.\\n\\n";
  prompt += "## Output format\\n";
  prompt += "Return JSON with:\\n";
  prompt += "- ticketsLanded: [{ticketId, mergeCommit, summary}] — successfully landed\\n";
  prompt += "- ticketsEvicted: [{ticketId, reason, details}] — had conflicts\\n";
  prompt += "  (details MUST include full conflict context: files, line ranges, competing changes)\\n";
  prompt += "  (this context is fed directly back to the implementer on the next pass)\\n";
  prompt += "- ticketsSkipped: [{ticketId, reason}] — skipped for other reasons\\n";
  prompt += "- summary: overall summary string\\n";
  prompt += "- nextActions: any follow-up needed, or null\\n";
  return prompt;
}

// ── Agents ────────────────────────────────────────────────────────────

const researcher    = chooseAgent("claude", "Researcher — Gather context from codebase for implementation");
const planner       = chooseAgent("opus",   "Planner — Create implementation plan from RFC section and context");
const implementer   = chooseAgent("codex",  "Implementer — Write code following the plan");
const tester        = chooseAgent("claude", "Tester — Run tests and validate implementation");
const prdReviewer   = chooseAgent("claude", "PRD Reviewer — Verify implementation matches RFC specification");
const codeReviewer  = chooseAgent("opus",   "Code Reviewer — Check code quality, conventions, security");
const reviewFixer   = chooseAgent("codex",  "ReviewFixer — Fix issues found in code review");
const finalReviewer = chooseAgent("opus",   "Final Reviewer — Decide if unit is complete");
const mergeQueueAgent = chooseAgent("opus", "MergeQueue Coordinator — Rebase and land unit branches onto main; evict on conflict");

// ── Smithers setup ────────────────────────────────────────────────────

const { smithers, outputs, Workflow } = createSmithers(
  scheduledOutputSchemas,
  { dbPath: DB_PATH }
);

// ── Workflow ──────────────────────────────────────────────────────────

export default smithers((ctx) => {
  // ── Quality-pipeline gate ──────────────────────────────────────────
  // tierComplete: true when a unit has passed all quality checks for its tier.
  // This does NOT mean the unit is done — it still needs to land on main.
  const tierComplete = (unitId: string): boolean => {
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
        const prd = ctx.latest("sw_prd_review", unitId + ":prd-review");
        const cr = ctx.latest("sw_code_review", unitId + ":code-review");
        if ((prd?.approved ?? false) && (cr?.approved ?? false)) return true;
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

  // ── Landing gate ──────────────────────────────────────────────────
  // Land status is read directly from sw_merge_queue outputs (no separate
  // sw_land records). This eliminates the one-pass-behind propagation bug
  // where Phase 3 compute tasks used stale render-time mqOutput values.
  // Note: at render time these reflect the PREVIOUS pass's merge results,
  // which is inherent to the React-like render model. Ralph re-evaluates
  // on each iteration, so status converges within one extra render.

  const unitLanded = (unitId: string): boolean => {
    const layerIdx = unitLayerMap.get(unitId);
    if (layerIdx === undefined) return false;
    const mq = ctx.latest("sw_merge_queue", "merge-queue:layer-" + layerIdx);
    return mq?.ticketsLanded?.some((t: any) => t.ticketId === unitId) ?? false;
  };

  const unitEvicted = (unitId: string): boolean => {
    if (unitLanded(unitId)) return false; // landed supersedes eviction
    const layerIdx = unitLayerMap.get(unitId);
    if (layerIdx === undefined) return false;
    const mq = ctx.latest("sw_merge_queue", "merge-queue:layer-" + layerIdx);
    return mq?.ticketsEvicted?.some((t: any) => t.ticketId === unitId) ?? false;
  };

  const getEvictionContext = (unitId: string): string | null => {
    if (unitLanded(unitId)) return null;
    const layerIdx = unitLayerMap.get(unitId);
    if (layerIdx === undefined) return null;
    const mq = ctx.latest("sw_merge_queue", "merge-queue:layer-" + layerIdx);
    const entry = mq?.ticketsEvicted?.find((t: any) => t.ticketId === unitId);
    return entry?.details ?? null;
  };

  // unitComplete: a unit is done only once it has landed on main
  const unitComplete = (unitId: string): boolean => unitLanded(unitId);

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

  // ── Completion report data (computed at render time) ──────────
  const landedIds = units.filter((u: any) => unitLanded(u.id)).map((u: any) => u.id);
  const failedUnits = units
    .filter((u: any) => !unitLanded(u.id))
    .map((u: any) => {
      const stages = ["final-review", "review-fix", "code-review", "prd-review", "test", "implement", "plan", "research"];
      let lastStage = "not-started";
      for (const stage of stages) {
        const nodeId = u.id + ":" + stage;
        const key = ("sw_" + stage.replace(/-/g, "_")) as keyof typeof outputs;
        try {
          if (ctx.outputMaybe(key, { nodeId })) {
            lastStage = stage;
            break;
          }
        } catch { /* schema key may not exist for this tier */ }
      }
      let reason = "Did not complete within " + MAX_PASSES + " passes";
      const evCtx = getEvictionContext(u.id);
      if (evCtx) reason = "Evicted from merge queue: " + evCtx.slice(0, 200);
      const testOut = ctx.outputMaybe("sw_test", { nodeId: u.id + ":test" });
      if (testOut && !testOut.testsPassed) reason = "Tests failing: " + (testOut.failingSummary ?? "unknown");
      return { unitId: u.id, lastStage, reason };
    });

  return (
    <Workflow name="scheduled-work" cache>
      <Sequence>
      <Ralph until={done} maxIterations={MAX_PASSES * units.length * 20} onMaxReached="return-last">
        <Sequence>
          {/* Process each layer sequentially.
              Each layer runs as a Sequence of 2 phases:
                1. Parallel quality pipelines (isolated Worktrees, one per unit)
                2. AgenticMergeQueue — lands tier-complete units onto main
              Land status is read directly from sw_merge_queue by unitLanded().
              Evicted units re-run from Phase 1 on the next Ralph iteration,
              with conflict context injected into their implement prompt. */}
          {layers.map((layer: any[], layerIdx: number) => {
            const mqNodeId = "merge-queue:layer-" + layerIdx;

            // Units ready to land: tier-complete, not yet landed, and (if
            // previously evicted) must have passing tests.
            // Note: toMerge is computed at render time (one pass behind).
            // The merge queue agent provides defense-in-depth by running
            // tests after rebase before landing.
            const toMerge = layer.filter((u: any) => {
              if (unitLanded(u.id)) return false;
              if (!tierComplete(u.id)) return false;
              if (unitEvicted(u.id)) {
                // Re-queue only if the implementer produced fresh passing tests
                const freshTest = ctx.outputMaybe("sw_test", { nodeId: u.id + ":test" });
                return freshTest?.testsPassed === true && freshTest?.buildPassed === true;
              }
              return true;
            }).map((u: any) => {
              const impl = ctx.outputMaybe("sw_implement", { nodeId: u.id + ":implement" });
              return {
                id: u.id,
                name: u.name,
                filesModified: (impl?.filesModified as string[] | null) ?? [],
                filesCreated: (impl?.filesCreated as string[] | null) ?? [],
              };
            });

            return (
              <Sequence key={"layer-" + layerIdx}>
                {/* ── Phase 1: Quality pipelines ─────────────────── */}
                <Parallel maxConcurrency={MAX_CONCURRENCY}>
                  {layer.map((unit: any) => {
                    const uid = unit.id;
                    if (unitLanded(uid)) return null;

                    // Read prior outputs for this unit
                    const research   = ctx.outputMaybe("sw_research",     { nodeId: uid + ":research" });
                    const plan       = ctx.outputMaybe("sw_plan",          { nodeId: uid + ":plan" });
                    const impl       = ctx.outputMaybe("sw_implement",     { nodeId: uid + ":implement" });
                    const test       = ctx.outputMaybe("sw_test",          { nodeId: uid + ":test" });
                    const prdReview  = ctx.outputMaybe("sw_prd_review",    { nodeId: uid + ":prd-review" });
                    const codeReview = ctx.outputMaybe("sw_code_review",   { nodeId: uid + ":code-review" });
                    const reviewFix  = ctx.outputMaybe("sw_review_fix",    { nodeId: uid + ":review-fix" });
                    const finalReview = ctx.outputMaybe("sw_final_review", { nodeId: uid + ":final-review" });
                    const evictionCtx = getEvictionContext(uid);

                    // Gather dependency summaries for this unit's implement prompt
                    const depSummaries = (unit.deps ?? []).map((depId: string) => {
                      const depImpl = ctx.outputMaybe("sw_implement", { nodeId: depId + ":implement" });
                      if (!depImpl) return null;
                      return {
                        id: depId,
                        whatWasDone: depImpl.whatWasDone ?? "",
                        filesCreated: (depImpl.filesCreated as string[] | null) ?? [],
                        filesModified: (depImpl.filesModified as string[] | null) ?? [],
                      };
                    }).filter(Boolean) as Array<{ id: string; whatWasDone: string; filesCreated: string[]; filesModified: string[] }>;

                    return (
                      <Worktree key={uid} path={"/tmp/workflow-wt-" + uid} branch={"unit/" + uid}>
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

\${depSummaries.length > 0 ? "## Dependency Context\\nThese units completed before yours and their changes are on main:\\n" + depSummaries.map((d: any) => "### " + d.id + "\\n" + d.whatWasDone + "\\nFiles created: " + (d.filesCreated.length > 0 ? d.filesCreated.join(", ") : "none") + "\\nFiles modified: " + (d.filesModified.length > 0 ? d.filesModified.join(", ") : "none")).join("\\n\\n") : ""}

\${impl?.summary ? "## Previous Implementation\\n" + impl.summary : ""}
\${impl?.nextSteps ? "## Previous Next Steps\\n" + impl.nextSteps : ""}
\${finalReview?.reasoning ? "## FINAL REVIEW FEEDBACK (address these issues)\\n" + finalReview.reasoning : ""}
\${prdReview?.feedback ? "## PRD REVIEW FEEDBACK\\n" + prdReview.feedback : ""}
\${codeReview?.feedback ? "## CODE REVIEW FEEDBACK\\n" + codeReview.feedback : ""}
\${test && !test.testsPassed && test.failingSummary ? "## FAILING TESTS (FIX THESE FIRST)\\n" + test.failingSummary : ""}
\${reviewFix?.summary ? "## REVIEW FIX SUMMARY\\n" + reviewFix.summary : ""}
\${evictionCtx ? "## MERGE CONFLICT — RESOLVE BEFORE NEXT LANDING\\n" + evictionCtx + "\\n\\nYour previous implementation conflicted with another unit that landed first. Restructure your changes to avoid the conflicting files and lines described above. Commit all changes when done." : ""}

## Build/Test Commands
Build: \${Object.values(workPlan.repo.buildCmds).join(" && ") || "none configured"}
Test: \${Object.values(workPlan.repo.testCmds).join(" && ") || "none configured"}

\${unit.tier === "trivial" ? \`## Task
1. Make the change
2. Run the build to verify it compiles
3. Commit your work

Do NOT write new tests for config, metadata, or mechanical changes.\` : unit.tier === "small" ? \`## Task
1. Implement the changes
2. Write tests if you added new behavior (skip tests for mechanical refactors, re-exports, or type-only changes)
3. Run build and tests to verify
4. Commit your work\` : \`## Task
1. Read the plan and context documents
2. For new behavior: write a failing test first (TDD), then implement to make it pass
3. For non-behavioral changes (types, docs, re-exports, config): implement directly without TDD
4. Run the build after each significant change
5. Run tests to verify
6. Commit your work\`}

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
4. After all fixes, run a final build + test pass and report the results

## Output
Return JSON with: summary, fixesMade (array of {issue, fix, file}), falsePositives (array of {issue, reasoning}), allIssuesResolved (boolean), buildPassed (boolean), testsPassed (boolean)\`}
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

                {/* ── Phase 2: Merge queue ────────────────────────── */}
                {/* Runs after all quality pipelines finish for this layer.
                    Lands tier-complete units onto main; evicts on conflict. */}
                <Task
                  id={mqNodeId}
                  output={outputs.sw_merge_queue}
                  agent={mergeQueueAgent}
                  skipIf={toMerge.length === 0}
                  retries={2}
                >
                  {buildMergeQueuePrompt(toMerge, REPO_ROOT, MAIN_BRANCH, Object.values(workPlan.repo.testCmds).join(" && ") || "none configured")}
                </Task>

                {/* Land status is now read directly from sw_merge_queue
                    by unitLanded()/unitEvicted(). No separate Phase 3 needed. */}
              </Sequence>
            );
          })}

          {/* Pass tracker */}
          <Task id="pass-tracker" output={outputs.sw_pass_tracker}>
            {{
              totalIterations: currentPass + 1,
              unitsRun: units.filter((u: any) => !unitLanded(u.id)).map((u: any) => u.id),
              unitsComplete: units.filter((u: any) => unitLanded(u.id)).map((u: any) => u.id),
              summary: \`Pass \${currentPass + 1} of \${MAX_PASSES}. \${units.filter((u: any) => unitLanded(u.id)).length}/\${units.length} units landed on main.\`,
            }}
          </Task>
        </Sequence>
      </Ralph>

      {/* ── Completion Report ──────────────────────────────────────── */}
      {/* Runs once after the Ralph loop finishes. Compute task (no agent). */}
      <Task id="completion-report" output={outputs.sw_completion_report}>
        {{
          totalUnits: units.length,
          unitsLanded: landedIds,
          unitsFailed: failedUnits,
          passesUsed: currentPass + 1,
          summary: landedIds.length === units.length
            ? "All " + units.length + " units landed successfully in " + (currentPass + 1) + " pass(es)."
            : landedIds.length + "/" + units.length + " units landed. " + failedUnits.length + " unit(s) failed after " + (currentPass + 1) + " pass(es).",
          nextSteps: failedUnits.length === 0
            ? []
            : [
                "Review failed units and their eviction/test context in .ralphinho/workflow.db",
                "Consider running 'ralphinho run --resume' to retry failed units",
                ...failedUnits.map((f: any) => f.unitId + ": last reached " + f.lastStage + " — " + f.reason),
              ],
        }}
      </Task>
      </Sequence>
    </Workflow>
  );
});
`;
}
