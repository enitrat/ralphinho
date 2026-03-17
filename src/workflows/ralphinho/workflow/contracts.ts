import type { ScheduledTier } from "../types";

export type StageName =
  | "research"
  | "plan"
  | "implement"
  | "test"
  | "prd-review"
  | "code-review"
  | "review-fix"
  | "final-review";

export type StageTableName =
  | "research"
  | "plan"
  | "implement"
  | "test"
  | "prd_review"
  | "code_review"
  | "review_fix"
  | "final_review";

export function stageNodeId(unitId: string, stage: StageName): string {
  return `${unitId}:${stage}`;
}

export type RetryPolicyKind = "fail-fast" | "backoff";

export type StageRetryPolicy = {
  kind: RetryPolicyKind;
  retries: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
};

export const MERGE_QUEUE_NODE_ID = "merge-queue" as const;
export const PR_CREATION_NODE_ID = "pr-creation" as const;
export const PASS_TRACKER_NODE_ID = "pass-tracker" as const;
export const COMPLETION_REPORT_NODE_ID = "completion-report" as const;

export const TIER_STAGES: Record<ScheduledTier, readonly StageName[]> = {
  small: [
    "implement",
    "test",
    "code-review",
    "review-fix",
    "final-review",
  ],
  large: [
    "research",
    "plan",
    "implement",
    "test",
    "prd-review",
    "code-review",
    "review-fix",
    "final-review",
  ],
};

export const DISPLAY_STAGES = [
  { key: "research", abbr: "R", table: "research" as StageTableName },
  { key: "plan", abbr: "P", table: "plan" as StageTableName },
  { key: "implement", abbr: "I", table: "implement" as StageTableName },
  { key: "test", abbr: "T", table: "test" as StageTableName },
  { key: "prd-review", abbr: "D", table: "prd_review" as StageTableName },
  { key: "code-review", abbr: "V", table: "code_review" as StageTableName },
  { key: "review-fix", abbr: "F", table: "review_fix" as StageTableName },
  { key: "final-review", abbr: "G", table: "final_review" as StageTableName },
] as const;

// Smithers semantics: retries=N means N+1 total attempts.
export const RESEARCH_RETRY_POLICY: StageRetryPolicy = {
  kind: "backoff",
  retries: 2,
  initialDelayMs: 1_000,
  maxDelayMs: 8_000,
};
export const PLAN_RETRY_POLICY: StageRetryPolicy = {
  kind: "backoff",
  retries: 2,
  initialDelayMs: 1_000,
  maxDelayMs: 8_000,
};
export const IMPLEMENT_RETRY_POLICY: StageRetryPolicy = {
  kind: "fail-fast",
  retries: 1,
};
export const TEST_RETRY_POLICY: StageRetryPolicy = {
  kind: "fail-fast",
  retries: 1,
};
export const REVIEW_RETRY_POLICY: StageRetryPolicy = {
  kind: "fail-fast",
  retries: 1,
};
export const REVIEW_FIX_RETRY_POLICY: StageRetryPolicy = {
  kind: "fail-fast",
  retries: 1,
};
export const FINAL_REVIEW_RETRY_POLICY: StageRetryPolicy = {
  kind: "fail-fast",
  retries: 1,
};
export const MERGE_QUEUE_RETRY_POLICY: StageRetryPolicy = {
  kind: "backoff",
  retries: 2,
  initialDelayMs: 1_000,
  maxDelayMs: 8_000,
};
export const PR_CREATION_RETRY_POLICY: StageRetryPolicy = {
  kind: "backoff",
  retries: 2,
  initialDelayMs: 1_000,
  maxDelayMs: 8_000,
};

export const RESEARCH_RETRIES = RESEARCH_RETRY_POLICY.retries;
export const PLAN_RETRIES = PLAN_RETRY_POLICY.retries;
export const IMPLEMENT_RETRIES = IMPLEMENT_RETRY_POLICY.retries;
export const TEST_RETRIES = TEST_RETRY_POLICY.retries;
export const REVIEW_RETRIES = REVIEW_RETRY_POLICY.retries;
export const REVIEW_FIX_RETRIES = REVIEW_FIX_RETRY_POLICY.retries;
export const FINAL_REVIEW_RETRIES = FINAL_REVIEW_RETRY_POLICY.retries;
export const MERGE_QUEUE_RETRIES = MERGE_QUEUE_RETRY_POLICY.retries;
export const PR_CREATION_RETRIES = PR_CREATION_RETRY_POLICY.retries;

type ResearchSignatureInput = {
  unitId: string;
  unitName: string;
  unitDescription: string;
  unitCategory: string;
  rfcSource: string;
  rfcSections: string[];
  referencePaths: string[];
  evictionContext: string | null;
};

type PlanSignatureInput = {
  unitId: string;
  unitName: string;
  unitDescription: string;
  unitCategory: string;
  acceptanceCriteria: string[];
  contextFilePath: string;
  researchSummary: string | undefined;
  evictionContext: string | null;
};

export function buildResearchInputSignature(input: ResearchSignatureInput): string {
  return JSON.stringify(input);
}

export function buildPlanInputSignature(input: PlanSignatureInput): string {
  return JSON.stringify(input);
}
