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
