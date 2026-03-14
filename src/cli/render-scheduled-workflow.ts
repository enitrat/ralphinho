/**
 * Renders a Smithers workflow.tsx for Scheduled Work mode.
 *
 * The generated file is a thin wrapper that imports ScheduledWorkflow
 * from the library, configures agents, and renders.
 */

import { ralphSourceRoot, runningFromSource } from "./shared";

export function renderScheduledWorkflow(params: {
  repoRoot: string;
}): string {
  const { repoRoot } = params;

  let importPrefix: string;
  if (runningFromSource) {
    importPrefix = ralphSourceRoot + "/src";
  } else {
    importPrefix = "super-ralph";
  }

  return `import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createSmithers, ClaudeCodeAgent, CodexAgent } from "smithers-orchestrator";
import { scheduledOutputSchemas } from "${importPrefix}/scheduled/schemas";
import { ScheduledWorkflow } from "${importPrefix}/components";

// ── Load config ────────────────────────────────────────────────────────

const _ralphDir = join(import.meta.dir, "..");
const _config = JSON.parse(readFileSync(join(_ralphDir, "config.json"), "utf8"));

// ── Constants ─────────────────────────────────────────────────────────

const REPO_ROOT = _config.repoRoot as string;
const DB_PATH = join(_ralphDir, "workflow.db");
const PLAN_PATH = join(_ralphDir, "work-plan.json");
const HAS_CLAUDE = _config.agents.claude as boolean;
const HAS_CODEX = _config.agents.codex as boolean;
const MAX_CONCURRENCY = _config.maxConcurrency as number;
const MAX_PASSES = 9;
const CONFIG_BASE_BRANCH = _config.baseBranch as string;

// ── Load work plan ────────────────────────────────────────────────────

const workPlan = JSON.parse(readFileSync(PLAN_PATH, "utf8"));

// ── Agent setup ───────────────────────────────────────────────────────

const WORKSPACE_POLICY = \`
## WORKSPACE POLICY
Uncommitted changes in the worktree are expected and normal.
Do NOT refuse to work because of dirty git state. Proceed with implementation regardless.
\`;

const EXECUTION_POLICY = \`
## EXECUTION POLICY
Complete the assigned task fully before concluding.
Rely on the task prompt's schema/output instructions; do not invent alternate output wrappers or code-fenced JSON unless the task explicitly asks for them.
\`;

function buildSystemPrompt(role: string): string {
  return ["# Role: " + role, WORKSPACE_POLICY, EXECUTION_POLICY].join("\\n\\n");
}

function createClaude(role: string, model: string = "claude-sonnet-4-6") {
  return new ClaudeCodeAgent({
    model,
    systemPrompt: buildSystemPrompt(role),
    cwd: REPO_ROOT,
    dangerouslySkipPermissions: true,
    timeoutMs: 60 * 60 * 1000,
    idleTimeoutMs: 5 * 60 * 1000,
  });
}

function createCodex(role: string) {
  return new CodexAgent({
    model: "gpt-5.3-codex",
    systemPrompt: buildSystemPrompt(role),
    cwd: REPO_ROOT,
    yolo: true,
    timeoutMs: 60 * 60 * 1000,
    idleTimeoutMs: 5 * 60 * 1000,
  });
}

function chooseAgent(primary: "claude" | "codex" | "opus", role: string): { agent: any; fallback: any | undefined } {
  const claude = (model?: string) => createClaude(role, model ?? "claude-sonnet-4-6");
  const codex = () => createCodex(role);

  if (primary === "opus" && HAS_CLAUDE) {
    return { agent: claude("claude-opus-4-6"), fallback: HAS_CODEX ? codex() : undefined };
  }
  if (primary === "claude" && HAS_CLAUDE) {
    return { agent: claude(), fallback: HAS_CODEX ? codex() : undefined };
  }
  if (primary === "codex" && HAS_CODEX) {
    return { agent: codex(), fallback: HAS_CLAUDE ? claude() : undefined };
  }
  if (HAS_CLAUDE) return { agent: claude(), fallback: undefined };
  return { agent: codex(), fallback: undefined };
}

const _roles = {
  researcher:    chooseAgent("claude", "Researcher — Gather context from codebase for implementation"),
  planner:       chooseAgent("opus",   "Planner — Create implementation plan from RFC section and context"),
  implementer:   chooseAgent("codex",  "Implementer — Write code following the plan"),
  tester:        chooseAgent("claude", "Tester — Run tests and validate implementation"),
  prdReviewer:   chooseAgent("claude", "PRD Reviewer — Verify implementation matches RFC specification"),
  codeReviewer:  chooseAgent("opus",   "Code Reviewer — Check code quality, conventions, security"),
  reviewFixer:   chooseAgent("codex",  "ReviewFixer — Fix issues found in code review"),
  finalReviewer: chooseAgent("opus",   "Final Reviewer — Decide if unit is complete"),
  mergeQueue:    chooseAgent("opus",   "MergeQueue Coordinator — Rebase and land unit branches onto the configured target branch"),
};

const agents = Object.fromEntries(
  Object.entries(_roles).map(([k, v]) => [k, v.agent]),
) as Record<keyof typeof _roles, any>;

const fallbacks = Object.fromEntries(
  Object.entries(_roles).filter(([, v]) => v.fallback).map(([k, v]) => [k, v.fallback]),
) as Partial<Record<keyof typeof _roles, any>>;

// ── Smithers setup ────────────────────────────────────────────────────

// journalMode: "DELETE" avoids macOS SQLITE_IOERR_VNODE (6922) caused by WAL.
// Smithers v0.10.0 handles write retries with exponential backoff internally.
const { smithers, outputs, Workflow } = createSmithers(
  scheduledOutputSchemas,
  { dbPath: DB_PATH, journalMode: "DELETE" }
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
      baseBranch={CONFIG_BASE_BRANCH}
      agents={agents}
      fallbacks={fallbacks}
    />
  </Workflow>
));
`;
}
