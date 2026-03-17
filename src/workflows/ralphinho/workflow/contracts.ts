export type StageName =
  | "research"
  | "plan"
  | "implement"
  | "test"
  | "prd-review"
  | "code-review"
  | "review-fix"
  | "final-review"
  | "learnings";

export function stageNodeId(unitId: string, stage: StageName): string {
  return `${unitId}:${stage}`;
}

export type RetryPolicyKind = "fail-fast" | "backoff";

export type StageRetryPolicy = {
  readonly kind: RetryPolicyKind;
  readonly retries: number;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
};

export const MERGE_QUEUE_NODE_ID = "merge-queue" as const;
export const PR_CREATION_NODE_ID = "pr-creation" as const;
export const PASS_TRACKER_NODE_ID = "pass-tracker" as const;
export const COMPLETION_REPORT_NODE_ID = "completion-report" as const;

const _TIER_STAGES = {
  small: [
    "implement",
    "test",
    "code-review",
    "review-fix",
    "final-review",
    "learnings",
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
    "learnings",
  ],
} as const;

export type ScheduledTier = keyof typeof _TIER_STAGES;
export const TIER_STAGES: Record<ScheduledTier, readonly StageName[]> = _TIER_STAGES;

export const DISPLAY_STAGES = [
  { key: "research", abbr: "R", table: "research" },
  { key: "plan", abbr: "P", table: "plan" },
  { key: "implement", abbr: "I", table: "implement" },
  { key: "test", abbr: "T", table: "test" },
  { key: "prd-review", abbr: "D", table: "prd_review" },
  { key: "code-review", abbr: "V", table: "code_review" },
  { key: "review-fix", abbr: "F", table: "review_fix" },
  { key: "final-review", abbr: "G", table: "final_review" },
  { key: "learnings", abbr: "L", table: "learnings" },
] as const;

// Smithers semantics: retries=N means N+1 total attempts.
const FAIL_FAST_RETRY_POLICY: StageRetryPolicy = {
  kind: "fail-fast",
  retries: 1,
};

const BACKOFF_RETRY_POLICY: StageRetryPolicy = {
  kind: "backoff",
  retries: 2,
  initialDelayMs: 1_000,
  maxDelayMs: 8_000,
};

export type RetryPolicyStage =
  | StageName
  | "merge-queue"
  | "pr-creation";

export const STAGE_RETRY_POLICIES: Record<RetryPolicyStage, StageRetryPolicy> = {
  research: BACKOFF_RETRY_POLICY,
  plan: BACKOFF_RETRY_POLICY,
  implement: FAIL_FAST_RETRY_POLICY,
  test: FAIL_FAST_RETRY_POLICY,
  "prd-review": FAIL_FAST_RETRY_POLICY,
  "code-review": FAIL_FAST_RETRY_POLICY,
  "review-fix": FAIL_FAST_RETRY_POLICY,
  "final-review": FAIL_FAST_RETRY_POLICY,
  learnings: FAIL_FAST_RETRY_POLICY,
  "merge-queue": BACKOFF_RETRY_POLICY,
  "pr-creation": BACKOFF_RETRY_POLICY,
};
