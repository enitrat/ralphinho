import React from "react";

import {
  createSmithers,
} from "smithers-orchestrator";

import { loadReviewPreset } from "../../preset-runtime";
import { reviewOutputSchemas } from "./schemas";
import {
  ReviewDiscoveryWorkflow,
  type ReviewDiscoveryWorkflowProps,
} from "./components/ReviewDiscoveryWorkflow";
import type { ReviewAgentOverride } from "../../config/types";
import { createAgentFactory } from "../shared/agentFactory";

const { paths, config, reviewPlan } = loadReviewPreset();

const REPO_ROOT = config.repoRoot;
const MAX_CONCURRENCY = config.maxConcurrency;

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

const { createClaude, createCodex } = createAgentFactory({
  repoRoot: REPO_ROOT,
  workspacePolicy: WORKSPACE_POLICY,
  executionPolicy: EXECUTION_POLICY,
  idleTimeoutMs: 15 * 60 * 1000,
});

function createOverrideAgent(
  override: ReviewAgentOverride,
  role: string,
) {
  switch (override) {
    case "sonnet":
      return createClaude(role, "claude-sonnet-4-6");
    case "opus":
      return createClaude(role, "claude-opus-4-6");
    case "codex":
      return createCodex(role, "gpt-5.4", "medium");
  }
}

function buildReviewAgents(): ReviewDiscoveryWorkflowProps["agents"] {
  const override = config.reviewAgentOverride;

  if (override) {
    return {
      refactorHunter: createOverrideAgent(
        override,
        "Refactor Hunter — Find deletion, simplification, de-duplication, and over-engineering issues inside one bounded review scope",
      ),
      typeSystemPurist: createOverrideAgent(
        override,
        "Type System Purist — Find code that distrusts the type system or duplicates guarantees already enforced by typed and validated boundaries",
      ),
      appLogicArchitecture: createOverrideAgent(
        override,
        "App / Logic Architecture Reviewer — Find logic layering problems, coupling, ownership confusion, and messy module boundaries inside one bounded review scope",
      ),
    };
  }

  return {
    refactorHunter: createCodex(
      "Refactor Hunter — Find deletion, simplification, de-duplication, and over-engineering issues inside one bounded review scope",
      "gpt-5.4",
      "medium",
    ),
    typeSystemPurist: createClaude(
      "Type System Purist — Find code that distrusts the type system or duplicates guarantees already enforced by typed and validated boundaries",
      "claude-sonnet-4-6",
    ),
    appLogicArchitecture: createCodex(
      "App / Logic Architecture Reviewer — Find logic layering problems, coupling, ownership confusion, and messy module boundaries inside one bounded review scope",
      "gpt-5.4",
      "medium",
    ),
  };
}

const agents = buildReviewAgents();

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
      agents={agents}
    />
  </Workflow>
));
