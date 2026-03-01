/**
 * Renders a Smithers workflow.tsx for Scheduled Work mode.
 *
 * The generated file is a thin wrapper that imports ScheduledWorkflow
 * from the library, configures agents, and renders.
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

  // Determine import prefix — where to import library components from
  const isLibRepo =
    existsSync(join(repoRoot, "src/components/ScheduledWorkflow.tsx")) &&
    existsSync(join(repoRoot, "src/scheduled/schemas.ts"));

  let importPrefix: string;
  if (isLibRepo) {
    importPrefix = "../../src";
  } else if (runningFromSource) {
    importPrefix = ralphSourceRoot + "/src";
  } else {
    importPrefix = "super-ralph";
  }

  return `import React from "react";
import { readFileSync } from "node:fs";
import { createSmithers, ClaudeCodeAgent, CodexAgent } from "smithers-orchestrator";
import { scheduledOutputSchemas } from "${importPrefix}/scheduled/schemas";
import { ScheduledWorkflow } from "${importPrefix}/components";

// ── Constants ─────────────────────────────────────────────────────────

const REPO_ROOT = ${JSON.stringify(repoRoot)};
const DB_PATH = ${JSON.stringify(dbPath)};
const PLAN_PATH = ${JSON.stringify(planPath)};
const HAS_CLAUDE = ${detectedAgents.claude};
const HAS_CODEX = ${detectedAgents.codex};
const MAX_CONCURRENCY = ${maxConcurrency};
const MAX_PASSES = 3;
const MAIN_BRANCH = "main";

// ── Load work plan ────────────────────────────────────────────────────

const workPlan = JSON.parse(readFileSync(PLAN_PATH, "utf8"));

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

const agents = {
  researcher:    chooseAgent("claude", "Researcher — Gather context from codebase for implementation"),
  planner:       chooseAgent("opus",   "Planner — Create implementation plan from RFC section and context"),
  implementer:   chooseAgent("codex",  "Implementer — Write code following the plan"),
  tester:        chooseAgent("claude", "Tester — Run tests and validate implementation"),
  prdReviewer:   chooseAgent("claude", "PRD Reviewer — Verify implementation matches RFC specification"),
  codeReviewer:  chooseAgent("opus",   "Code Reviewer — Check code quality, conventions, security"),
  reviewFixer:   chooseAgent("codex",  "ReviewFixer — Fix issues found in code review"),
  finalReviewer: chooseAgent("opus",   "Final Reviewer — Decide if unit is complete"),
  mergeQueue:    chooseAgent("opus",   "MergeQueue Coordinator — Rebase and land unit branches onto main"),
};

// ── Smithers setup ────────────────────────────────────────────────────

const { smithers, outputs, Workflow } = createSmithers(
  scheduledOutputSchemas,
  { dbPath: DB_PATH }
);

// ── Workflow ──────────────────────────────────────────────────────────

export default smithers((ctx) => (
  <Workflow name="scheduled-work" cache>
    <ScheduledWorkflow
      ctx={ctx}
      outputs={outputs}
      workPlan={workPlan}
      repoRoot={REPO_ROOT}
      maxConcurrency={MAX_CONCURRENCY}
      maxPasses={MAX_PASSES}
      mainBranch={MAIN_BRANCH}
      agents={agents}
    />
  </Workflow>
));
`;
}
