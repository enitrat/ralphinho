// Components
export { ScheduledWorkflow } from "./components/ScheduledWorkflow";
export type { ScheduledWorkflowProps, ScheduledWorkflowAgents } from "./components/ScheduledWorkflow";
export { QualityPipeline } from "./components/QualityPipeline";
export type { QualityPipelineProps, QualityPipelineAgents, QualityPipelineFallbacks, DepSummary } from "./components/QualityPipeline";
export { AgenticMergeQueue, mergeQueueResultSchema } from "./components/AgenticMergeQueue";
export type { AgenticMergeQueueProps, AgenticMergeQueueTicket, MergeQueueResult } from "./components/AgenticMergeQueue";

// Types and schemas
export {
  workPlanSchema,
  workUnitSchema,
  ralphinhoConfigSchema,
  validateDAG,
  computeLayers,
} from "./types";

export type {
  WorkPlan,
  WorkUnit,
  RalphinhoConfig,
} from "./types";

export type { ScheduledTier } from "./workflow/contracts";
export { TIER_STAGES } from "./workflow/contracts";

export { scheduledOutputSchemas } from "./schemas";

// Domain logic
export { decomposeRFC } from "./decompose";
export type { DecomposeOptions } from "./decompose";
// printPlanSummary moved to src/cli/plan-summary.ts (CLI layer)
