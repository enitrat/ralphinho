import React from "react";

import {
  ClaudeCodeAgent,
  CodexAgent,
  createSmithers,
  type AgentLike,
} from "smithers-orchestrator";

import { loadReviewPreset } from "./preset-runtime";
import { reviewOutputSchemas } from "./review/schemas";
import {
  ReviewDiscoveryWorkflow,
  type ReviewDiscoveryWorkflowProps,
} from "./components/ReviewDiscoveryWorkflow";

const { paths, config, reviewPlan } = loadReviewPreset();

const REPO_ROOT = config.repoRoot;
const MAX_CONCURRENCY = config.maxConcurrency;
const MAX_PASSES = 3;
const HAS_CLAUDE = config.agents.claude;
const HAS_CODEX = config.agents.codex;

const WORKSPACE_POLICY = `
## WORKSPACE POLICY
This workflow is review-only by default.
Do not implement fixes unless the task explicitly asks for them.
`;

const EXECUTION_POLICY = `
## EXECUTION POLICY
Return only the structured output that matches the task schema.
Keep evidence concrete, scoped, and fast for humans to triage.
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
): AgentLike | AgentLike[] {
  const claude = (model?: string) => createClaude(role, model ?? "claude-sonnet-4-6");
  const codex = () => createCodex(role);

  if (primary === "opus" && HAS_CLAUDE) {
    return HAS_CODEX ? [claude("claude-opus-4-6"), codex()] : claude("claude-opus-4-6");
  }
  if (primary === "claude" && HAS_CLAUDE) {
    return HAS_CODEX ? [claude(), codex()] : claude();
  }
  if (primary === "codex" && HAS_CODEX) {
    return HAS_CLAUDE ? [codex(), claude()] : codex();
  }
  return HAS_CLAUDE ? claude() : codex();
}

const agents: ReviewDiscoveryWorkflowProps["agents"] = {
  discoverer: chooseAgent("claude", "Review Discoverer — Find concrete candidate issues inside one bounded code slice"),
  auditor: chooseAgent("opus", "Evidence Auditor — Confirm or reject review findings with strict evidence requirements"),
};

const { smithers, outputs, Workflow } = createSmithers(
  reviewOutputSchemas,
  {
    dbPath: paths.dbPath,
    journalMode: "DELETE",
  },
);

export default smithers((ctx) => (
  <Workflow name="review-discovery" cache>
    <ReviewDiscoveryWorkflow
      ctx={ctx}
      outputs={outputs}
      plan={reviewPlan}
      maxConcurrency={MAX_CONCURRENCY}
      maxPasses={MAX_PASSES}
      agents={agents}
    />
  </Workflow>
));
