/**
 * Scheduled-work workflow toolkit — RFC-driven AI development engine.
 *
 * Provides:
 * - QualityPipeline: per-unit quality pipeline (research → implement → test → review)
 * - ScheduledWorkflow: orchestrator composing pipelines + merge queue
 * - AgenticMergeQueue: lands completed units onto main
 * - Monitor: TUI for observing workflow progress
 * - Scheduled work types and schemas
 */

// Components
export {
  QualityPipeline,
  ScheduledWorkflow,
  ReviewDiscoveryWorkflow,
  AgenticMergeQueue,
  mergeQueueResultSchema,
  Monitor,
  monitorOutputSchema,
} from "./components";

export type {
  QualityPipelineProps,
  QualityPipelineAgents,
  DepSummary,
  ScheduledWorkflowProps,
  ScheduledWorkflowAgents,
  ReviewDiscoveryWorkflowProps,
  AgenticMergeQueueProps,
  AgenticMergeQueueTicket,
  MergeQueueResult,
  MonitorOutput,
  MonitorProps,
} from "./components";

// Scheduled work types
export {
  computeLayers,
  validateDAG,
  SCHEDULED_TIERS,
  workPlanSchema,
  workUnitSchema,
  ralphinhoConfigSchema,
} from "./scheduled/types";

export type {
  WorkPlan,
  WorkUnit,
  RalphinhoConfig,
  ScheduledTier,
} from "./scheduled/types";

// Schemas
export { scheduledOutputSchemas } from "./scheduled/schemas";

// Review discovery types and schemas
export {
  reviewPlanSchema,
  reviewSliceSchema,
  reviewKindSchema,
  reviewPrioritySchema,
  reviewConfidenceSchema,
  candidateIssueSchema,
  auditedIssueSchema,
  reviewTicketSchema,
} from "./review/types";

export type {
  ReviewPlan,
  ReviewSlice,
  ReviewKind,
  ReviewPriority,
  ReviewConfidence,
  CandidateIssue,
  AuditedIssue,
  ReviewTicket,
} from "./review/types";

export { reviewOutputSchemas } from "./review/schemas";
