// Components
export { ReviewDiscoveryWorkflow } from "./components/ReviewDiscoveryWorkflow";
export type { ReviewDiscoveryWorkflowProps } from "./components/ReviewDiscoveryWorkflow";

// Types and schemas
export {
  reviewKindSchema,
  reviewPrioritySchema,
  reviewConfidenceSchema,
  reviewFindingStatusSchema,
  reviewModeSchema,
  reviewLensSchema,
  reviewSliceSchema,
  reviewPlanSchema,
  discoveredFindingSchema,
  reviewFindingSchema,
} from "./types";

export type {
  ReviewKind,
  ReviewPriority,
  ReviewConfidence,
  ReviewFindingStatus,
  ReviewMode,
  ReviewLens,
  ReviewSlice,
  ReviewPlan,
  DiscoveredFinding,
  ReviewFinding,
} from "./types";

export { reviewOutputSchemas } from "./schemas";

// Domain logic
export { buildReviewPlan } from "./plan";
export { mergeReviewFindings, projectReviewSummaryFromDb, resolveLatestReviewRunId } from "./projection";
export type { MergedReviewFinding } from "./projection";
