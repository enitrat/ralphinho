/**
 * Workflow toolkit — RFC-driven AI development engine + review discovery.
 *
 * Provides:
 * - QualityPipeline: per-unit quality pipeline (research → implement → test → review)
 * - ScheduledWorkflow: orchestrator composing pipelines + merge queue
 * - AgenticMergeQueue: lands completed units onto main
 * - ReviewDiscoveryWorkflow: multi-lens code review discovery
 * - Monitor: TUI for observing workflow progress
 * - Scheduled work types and schemas
 * - Review discovery types and schemas
 */

// ── Ralphinho (scheduled work) ──────────────────────────────────────

export {
  QualityPipeline,
  ScheduledWorkflow,
  AgenticMergeQueue,
  mergeQueueResultSchema,
  scheduledOutputSchemas,
  computeLayers,
  validateDAG,
  SCHEDULED_TIERS,
  workPlanSchema,
  workUnitSchema,
  ralphinhoConfigSchema,
} from "./workflows/ralphinho";

export type {
  QualityPipelineProps,
  QualityPipelineAgents,
  DepSummary,
  ScheduledWorkflowProps,
  ScheduledWorkflowAgents,
  AgenticMergeQueueProps,
  AgenticMergeQueueTicket,
  MergeQueueResult,
  WorkPlan,
  WorkUnit,
  RalphinhoConfig,
  ScheduledTier,
} from "./workflows/ralphinho";

// ── Improvinho (review discovery) ───────────────────────────────────

export {
  ReviewDiscoveryWorkflow,
  reviewPlanSchema,
  reviewSliceSchema,
  reviewKindSchema,
  reviewPrioritySchema,
  reviewConfidenceSchema,
  reviewFindingStatusSchema,
  reviewModeSchema,
  reviewLensSchema,
  discoveredFindingSchema,
  reviewFindingSchema,
  reviewOutputSchemas,
} from "./workflows/improvinho";

export type {
  ReviewDiscoveryWorkflowProps,
  ReviewPlan,
  ReviewSlice,
  ReviewKind,
  ReviewPriority,
  ReviewConfidence,
  ReviewFindingStatus,
  ReviewMode,
  ReviewLens,
  DiscoveredFinding,
  ReviewFinding,
} from "./workflows/improvinho";

// ── Shared ──────────────────────────────────────────────────────────

export { Monitor, monitorOutputSchema } from "./components";

export type { MonitorOutput, MonitorProps } from "./components";
