import { DISPLAY_STAGES, TIER_STAGES, stageNodeId } from "../workflows/ralphinho/workflow/contracts";
import type { SmithersEvent } from "./events";

type DecisionStatus = "pending" | "rejected" | "approved" | "invalidated";

export type WorkflowPhase =
  | "starting"
  | "interpreting"
  | "discovering"
  | "pipeline"
  | "merging"
  | "done";

export type StageStatus = "completed" | "running" | "pending" | "failed";

export interface StageView {
  abbr: string;
  key: string;
  status: StageStatus;
}

export interface TicketView {
  id: string;
  title: string;
  tier: string;
  priority: string;
  stages: StageView[];
  landStatus: "landed" | "evicted" | null;
  decisionStatus: DecisionStatus;
  decisionReasoning: string | null;
  approvalSupersededRejection: boolean;
  approvalOnlyCorrectedFormatting: boolean;
  semanticallyComplete: boolean;
}

export interface ActiveJob {
  jobType: string;
  agentId: string;
  ticketId: string | null;
  elapsedMs: number;
}

export interface MergeQueueActivity {
  ticketsLanded: Array<{ ticketId: string; summary: string }>;
  ticketsEvicted: Array<{ ticketId: string; reason: string }>;
  ticketsSkipped: Array<{ ticketId: string; reason: string }>;
  summary: string | null;
}

export interface PollData {
  tickets: TicketView[];
  activeJobs: ActiveJob[];
  discovered: number;
  landed: number;
  semanticallyComplete: number;
  evicted: number;
  inPipeline: number;
  maxConcurrency: number;
  phase: WorkflowPhase;
  mergeQueueActivity: MergeQueueActivity | null;
  schedulerReasoning: string | null;
  discoveryCount: number;
}

interface TicketMeta {
  id: string;
  title: string;
  tier: string;
  priority: string;
}

interface DecisionMeta {
  status: DecisionStatus;
  reasoning: string | null;
  approvalSupersededRejection: boolean;
  approvalOnlyCorrectedFormatting: boolean;
}

function detectPhase(
  hasWorkflowOutput: boolean,
  tickets: TicketView[],
  activeJobs: ActiveJob[],
  semanticallyComplete: number,
  mergeQueueActive: boolean,
): WorkflowPhase {
  if (!hasWorkflowOutput && tickets.length === 0 && activeJobs.length === 0 && !mergeQueueActive) return "starting";
  if (activeJobs.some((job) => job.jobType === "discovery")) return "discovering";
  if (tickets.length > 0 && semanticallyComplete === tickets.length && activeJobs.length === 0) return "done";
  if (mergeQueueActive) return "merging";
  if (!hasWorkflowOutput) return "interpreting";
  if (tickets.length > 0 && tickets.some((ticket) => !ticket.semanticallyComplete)) return "pipeline";
  if (tickets.length === 0) return "interpreting";
  return "pipeline";
}

export function projectEvents(events: SmithersEvent[], now = Date.now()): PollData {
  const ticketMap = new Map<string, TicketMeta>();
  const nodeState = new Map<string, "in-progress" | "completed" | "failed">();
  const activeJobMap = new Map<string, ActiveJob>();
  const landMap = new Map<string, "landed" | "evicted">();
  const decisionMap = new Map<string, DecisionMeta>();
  let semanticCompletionState: { unitsSemanticallyComplete: Set<string> } | null = null;
  let mergeQueueActivity: MergeQueueActivity | null = null;
  let hasWorkflowOutput = false;
  let discoveryCount = 0;
  let maxConcurrency = 0;
  let schedulerReasoning: string | null = null;
  const ensureMergeQueueActivity = (): MergeQueueActivity => {
    mergeQueueActivity ??= {
      ticketsLanded: [],
      ticketsEvicted: [],
      ticketsSkipped: [],
      summary: null,
    };
    return mergeQueueActivity;
  };

  for (const event of events) {
    switch (event.type) {
      case "work-plan-loaded":
        hasWorkflowOutput = true;
        discoveryCount += 1;
        for (const unit of event.units) {
          ticketMap.set(unit.id, {
            id: unit.id,
            title: unit.name || unit.id,
            tier: unit.tier || "large",
            priority: unit.priority || "medium",
          });
        }
        break;
      case "node-started":
        hasWorkflowOutput = true;
        nodeState.set(event.nodeId, "in-progress");
        break;
      case "node-completed":
        hasWorkflowOutput = true;
        nodeState.set(event.nodeId, "completed");
        break;
      case "node-failed":
        hasWorkflowOutput = true;
        nodeState.set(event.nodeId, "failed");
        break;
      case "job-scheduled": {
        const key = `${event.jobType}:${event.agentId}:${event.ticketId ?? ""}`;
        activeJobMap.set(key, {
          jobType: event.jobType,
          agentId: event.agentId,
          ticketId: event.ticketId,
          elapsedMs: Math.max(0, now - event.createdAtMs),
        });
        break;
      }
      case "job-completed": {
        const key = `${event.jobType}:${event.agentId}:${event.ticketId ?? ""}`;
        activeJobMap.delete(key);
        break;
      }
      case "merge-queue-landed":
        ensureMergeQueueActivity().ticketsLanded.push({
          ticketId: event.ticketId,
          summary: event.summary,
        });
        landMap.set(event.ticketId, "landed");
        break;
      case "merge-queue-evicted":
        ensureMergeQueueActivity().ticketsEvicted.push({
          ticketId: event.ticketId,
          reason: event.reason,
        });
        landMap.set(event.ticketId, "evicted");
        break;
      case "merge-queue-skipped":
        ensureMergeQueueActivity().ticketsSkipped.push({
          ticketId: event.ticketId,
          reason: event.reason,
        });
        break;
      case "pass-tracker-update":
        hasWorkflowOutput = true;
        maxConcurrency = event.maxConcurrency || 0;
        schedulerReasoning = event.summary || null;
        break;
      case "final-review-decision":
        decisionMap.set(event.unitId, {
          status: event.status,
          reasoning: event.reasoning,
          approvalSupersededRejection: event.approvalSupersededRejection,
          approvalOnlyCorrectedFormatting: event.approvalOnlyCorrectedFormatting,
        });
        break;
      case "semantic-completion-update":
        semanticCompletionState = {
          unitsSemanticallyComplete: new Set(event.unitsSemanticallyComplete),
        };
        break;
    }
  }

  const tickets: TicketView[] = [];
  for (const ticket of ticketMap.values()) {
    const tierStages = TIER_STAGES[ticket.tier as "small" | "large"] || TIER_STAGES.large;
    const stages: StageView[] = [];

    for (const stage of DISPLAY_STAGES) {
      if (!tierStages.includes(stage.key)) continue;

      const nodeId = stageNodeId(ticket.id, stage.key);
      const state = nodeState.get(nodeId);
      let status: StageStatus = "pending";
      if (state === "completed") status = "completed";
      else if (state === "failed") status = "failed";
      else if (state === "in-progress") status = "running";

      stages.push({
        abbr: stage.abbr,
        key: stage.key,
        status,
      });
    }

    const decision = decisionMap.get(ticket.id);
    const semanticallyComplete = semanticCompletionState?.unitsSemanticallyComplete.has(ticket.id)
      ?? (decision?.status === "approved" && landMap.get(ticket.id) === "landed");
    tickets.push({
      id: ticket.id,
      title: ticket.title,
      tier: ticket.tier,
      priority: ticket.priority,
      stages,
      landStatus: landMap.get(ticket.id) ?? null,
      decisionStatus: decision?.status ?? "pending",
      decisionReasoning: decision?.reasoning ?? null,
      approvalSupersededRejection: decision?.approvalSupersededRejection ?? false,
      approvalOnlyCorrectedFormatting: decision?.approvalOnlyCorrectedFormatting ?? false,
      semanticallyComplete,
    });
  }

  const priorityOrder: Record<string, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };
  tickets.sort((a, b) => {
    const aRunning = a.stages.some((stage) => stage.status === "running") ? 0 : 1;
    const bRunning = b.stages.some((stage) => stage.status === "running") ? 0 : 1;
    if (aRunning !== bRunning) return aRunning - bRunning;

    const aLanded = a.landStatus === "landed" ? 1 : 0;
    const bLanded = b.landStatus === "landed" ? 1 : 0;
    if (aLanded !== bLanded) return aLanded - bLanded;

    return (priorityOrder[a.priority] ?? 3) - (priorityOrder[b.priority] ?? 3);
  });

  const landed = tickets.filter((ticket) => ticket.landStatus === "landed").length;
  const semanticallyComplete = tickets.filter((ticket) => ticket.semanticallyComplete).length;
  const evicted = tickets.filter((ticket) => ticket.landStatus === "evicted").length;
  const activeJobs = [...activeJobMap.values()];
  const mergeQueueNodeActive = [...nodeState].some(
    ([nodeId, state]) => nodeId.startsWith("merge-queue:") && state === "in-progress",
  );

  return {
    tickets,
    activeJobs,
    discovered: tickets.length,
    landed,
    semanticallyComplete,
    evicted,
    inPipeline: Math.max(0, tickets.length - landed - evicted),
    maxConcurrency,
    phase: detectPhase(hasWorkflowOutput, tickets, activeJobs, semanticallyComplete, mergeQueueNodeActive),
    mergeQueueActivity,
    schedulerReasoning,
    discoveryCount,
  };
}
