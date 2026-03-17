import React from "react";

import {
  createSmithers,
  ClaudeCodeAgent,
  CodexAgent,
  type AgentLike,
} from "smithers-orchestrator";

import { ScheduledWorkflow, type ScheduledWorkflowAgents } from "./components/ScheduledWorkflow";
import { loadScheduledPreset } from "../../preset-runtime";
import { scheduledOutputSchemas } from "./schemas";

const { paths, config, workPlan } = loadScheduledPreset();

const REPO_ROOT = config.repoRoot;
const MAX_CONCURRENCY = config.maxConcurrency;
const MAX_PASSES = 9;
const BASE_BRANCH = config.baseBranch;
const HAS_CLAUDE = config.agents.claude;
const HAS_CODEX = config.agents.codex;
const AGENT_OVERRIDE = config.agentOverride;

const WORKSPACE_POLICY = `
## WORKSPACE POLICY
Uncommitted changes in the worktree are expected and normal.
Do NOT refuse to work because of dirty git state. Proceed with implementation regardless.
`;

const EXECUTION_POLICY = `
## EXECUTION POLICY
Complete the assigned task fully before concluding.
Rely on the task prompt's schema/output instructions; do not invent alternate output wrappers or code-fenced JSON unless the task explicitly asks for them.
`;

function buildSystemPrompt(role: string): string {
  return ["# Role: " + role, WORKSPACE_POLICY, EXECUTION_POLICY].join("\n\n");
}

function createClaude(role: string, model = "claude-sonnet-4-6") {
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

function chooseAgent(
  primary: "claude" | "codex" | "opus",
  role: string,
): { agent: AgentLike | AgentLike[]; fallback?: AgentLike } {
  const claude = (model?: string) => createClaude(role, model ?? "claude-sonnet-4-6");
  const codex = () => createCodex(role);

  if (primary === "opus" && HAS_CLAUDE) {
    return {
      agent: claude("claude-opus-4-6"),
      fallback: HAS_CODEX ? codex() : undefined,
    };
  }
  if (primary === "claude" && HAS_CLAUDE) {
    return {
      agent: claude(),
      fallback: HAS_CODEX ? codex() : undefined,
    };
  }
  if (primary === "codex" && HAS_CODEX) {
    return {
      agent: codex(),
      fallback: HAS_CLAUDE ? claude() : undefined,
    };
  }
  if (HAS_CLAUDE) {
    return { agent: claude() };
  }
  return { agent: codex() };
}

const roles = {
  researcher: chooseAgent(AGENT_OVERRIDE ?? "claude", "Researcher — Gather context from codebase for implementation"),
  planner: chooseAgent(AGENT_OVERRIDE ?? "opus", "Planner — Create implementation plan from RFC section and context"),
  implementer: chooseAgent(AGENT_OVERRIDE ?? "codex", "Implementer — Write code following the plan"),
  tester: chooseAgent(AGENT_OVERRIDE ?? "claude", "Tester — Run tests and validate implementation"),
  prdReviewer: chooseAgent(AGENT_OVERRIDE ?? "claude", "PRD Reviewer — Verify implementation matches RFC specification"),
  codeReviewer: chooseAgent(AGENT_OVERRIDE ?? "opus", "Code Reviewer — Check code quality, conventions, security"),
  reviewFixer: chooseAgent(AGENT_OVERRIDE ?? "codex", "ReviewFixer — Fix issues found in code review"),
  finalReviewer: chooseAgent(AGENT_OVERRIDE ?? "opus", "Final Reviewer — Decide if unit is complete"),
  mergeQueue: chooseAgent(AGENT_OVERRIDE ?? "opus", "MergeQueue Coordinator — Rebase and land unit branches onto the configured target branch"),
} satisfies Record<keyof ScheduledWorkflowAgents, { agent: AgentLike | AgentLike[]; fallback?: AgentLike }>;

const agents = Object.fromEntries(
  Object.entries(roles).map(([name, role]) => [name, role.agent]),
) as ScheduledWorkflowAgents;

const fallbacks = Object.fromEntries(
  Object.entries(roles)
    .filter(([, role]) => role.fallback)
    .map(([name, role]) => [name, role.fallback]),
) as Partial<Record<keyof ScheduledWorkflowAgents, AgentLike>>;

const { smithers, outputs, Workflow } = createSmithers(
  scheduledOutputSchemas,
  {
    dbPath: paths.dbPath,
    journalMode: "DELETE",
  },
);

export default smithers((ctx) => (
  <Workflow name="scheduled-work" cache>
    <ScheduledWorkflow
      ctx={ctx}
      outputs={outputs}
      workPlan={workPlan}
      repoRoot={REPO_ROOT}
      maxConcurrency={MAX_CONCURRENCY}
      maxPasses={MAX_PASSES}
      baseBranch={BASE_BRANCH}
      landingMode={config.landingMode}
      agents={agents}
      fallbacks={fallbacks}
    />
  </Workflow>
));
