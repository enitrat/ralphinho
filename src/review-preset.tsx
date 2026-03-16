import React from "react";

import {
  ClaudeCodeAgent,
  CodexAgent,
  createSmithers,
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

function createCodex(role: string, model = "gpt-5.4-codex", reasoningEffort?: string) {
  return new CodexAgent({
    model,
    systemPrompt: buildSystemPrompt(role),
    cwd: REPO_ROOT,
    yolo: true,
    timeoutMs: 60 * 60 * 1000,
    idleTimeoutMs: 5 * 60 * 1000,
    ...(reasoningEffort && {
      config: {
        model_reasoning_effort: reasoningEffort,
      },
    }),
  });
}

const agents: ReviewDiscoveryWorkflowProps["agents"] = {
  discoverer: createCodex(
    "Review Discoverer — Find concrete candidate issues inside one bounded code slice",
    "gpt-5.4",
    "medium",
  ),
  auditor: createClaude(
    "Evidence Auditor — Confirm or reject review findings with strict evidence requirements",
    "claude-opus-4-6",
  ),
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
