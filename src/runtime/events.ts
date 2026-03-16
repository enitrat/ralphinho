import { readFile } from "node:fs/promises";

import { DISPLAY_STAGES, type StageName } from "../workflows/ralphinho/workflow/contracts";
import type { DecisionStatus } from "../workflows/ralphinho/workflow/decisions";

export type SmithersEvent =
  | NodeStartedEvent
  | NodeCompletedEvent
  | NodeFailedEvent
  | JobScheduledEvent
  | JobCompletedEvent
  | MergeQueueLandedEvent
  | MergeQueueEvictedEvent
  | MergeQueueSkippedEvent
  | PassTrackerUpdateEvent
  | WorkPlanLoadedEvent
  | FinalReviewDecisionEvent
  | SemanticCompletionUpdateEvent;

export interface NodeStartedEvent {
  type: "node-started";
  timestamp: number;
  runId: string;
  nodeId: string;
  unitId: string;
  stageName: StageName;
}

export interface NodeCompletedEvent {
  type: "node-completed";
  timestamp: number;
  runId: string;
  nodeId: string;
  unitId: string;
  stageName: StageName;
}

export interface NodeFailedEvent {
  type: "node-failed";
  timestamp: number;
  runId: string;
  nodeId: string;
  unitId: string;
  stageName: StageName;
  error?: string;
}

export interface JobScheduledEvent {
  type: "job-scheduled";
  timestamp: number;
  jobType: string;
  agentId: string;
  ticketId: string | null;
  createdAtMs: number;
}

export interface JobCompletedEvent {
  type: "job-completed";
  timestamp: number;
  jobType: string;
  agentId: string;
  ticketId: string | null;
}

export interface MergeQueueLandedEvent {
  type: "merge-queue-landed";
  timestamp: number;
  runId: string;
  ticketId: string;
  mergeCommit: string | null;
  summary: string;
}

export interface MergeQueueEvictedEvent {
  type: "merge-queue-evicted";
  timestamp: number;
  runId: string;
  ticketId: string;
  reason: string;
  details: string;
}

export interface MergeQueueSkippedEvent {
  type: "merge-queue-skipped";
  timestamp: number;
  runId: string;
  ticketId: string;
  reason: string;
}

export interface PassTrackerUpdateEvent {
  type: "pass-tracker-update";
  timestamp: number;
  runId: string;
  summary: string;
  maxConcurrency: number;
}

export interface WorkPlanLoadedEvent {
  type: "work-plan-loaded";
  timestamp: number;
  units: Array<{
    id: string;
    name: string;
    tier: "small" | "large";
    priority: string;
  }>;
}

export interface FinalReviewDecisionEvent {
  type: "final-review-decision";
  timestamp: number;
  runId: string;
  unitId: string;
  iteration: number;
  status: DecisionStatus;
  reasoning: string;
  approvalSupersededRejection: boolean;
  approvalOnlyCorrectedFormatting: boolean;
}

export interface SemanticCompletionUpdateEvent {
  type: "semantic-completion-update";
  timestamp: number;
  runId: string;
  totalUnits: number;
  unitsLanded: string[];
  unitsSemanticallyComplete: string[];
}

const STAGE_NAMES = new Set<StageName>(DISPLAY_STAGES.map((entry) => entry.key));

const DECISION_STATUSES = new Set<DecisionStatus>(["pending", "rejected", "approved", "invalidated"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isStageName(value: unknown): value is StageName {
  return isString(value) && STAGE_NAMES.has(value as StageName);
}

function isDecisionStatus(value: unknown): value is DecisionStatus {
  return isString(value) && DECISION_STATUSES.has(value as DecisionStatus);
}

function parseEvent(value: unknown): SmithersEvent | null {
  if (!isRecord(value) || !isString(value.type) || !isNumber(value.timestamp)) return null;

  switch (value.type) {
    case "node-started":
      if (
        isString(value.runId)
        && isString(value.nodeId)
        && isString(value.unitId)
        && isStageName(value.stageName)
      ) {
        return {
          type: "node-started",
          timestamp: value.timestamp,
          runId: value.runId,
          nodeId: value.nodeId,
          unitId: value.unitId,
          stageName: value.stageName,
        };
      }
      return null;
    case "node-completed":
      if (
        isString(value.runId)
        && isString(value.nodeId)
        && isString(value.unitId)
        && isStageName(value.stageName)
      ) {
        return {
          type: "node-completed",
          timestamp: value.timestamp,
          runId: value.runId,
          nodeId: value.nodeId,
          unitId: value.unitId,
          stageName: value.stageName,
        };
      }
      return null;
    case "node-failed":
      if (
        isString(value.runId)
        && isString(value.nodeId)
        && isString(value.unitId)
        && isStageName(value.stageName)
        && (value.error === undefined || isString(value.error))
      ) {
        return {
          type: "node-failed",
          timestamp: value.timestamp,
          runId: value.runId,
          nodeId: value.nodeId,
          unitId: value.unitId,
          stageName: value.stageName,
          error: isString(value.error) ? value.error : undefined,
        };
      }
      return null;
    case "job-scheduled":
      if (
        isString(value.jobType)
        && isString(value.agentId)
        && isNullableString(value.ticketId)
        && isNumber(value.createdAtMs)
      ) {
        return {
          type: "job-scheduled",
          timestamp: value.timestamp,
          jobType: value.jobType,
          agentId: value.agentId,
          ticketId: value.ticketId,
          createdAtMs: value.createdAtMs,
        };
      }
      return null;
    case "job-completed":
      if (isString(value.jobType) && isString(value.agentId) && isNullableString(value.ticketId)) {
        return {
          type: "job-completed",
          timestamp: value.timestamp,
          jobType: value.jobType,
          agentId: value.agentId,
          ticketId: value.ticketId,
        };
      }
      return null;
    case "merge-queue-landed":
      if (
        isString(value.runId)
        && isString(value.ticketId)
        && isNullableString(value.mergeCommit)
        && isString(value.summary)
      ) {
        return {
          type: "merge-queue-landed",
          timestamp: value.timestamp,
          runId: value.runId,
          ticketId: value.ticketId,
          mergeCommit: value.mergeCommit,
          summary: value.summary,
        };
      }
      return null;
    case "merge-queue-evicted":
      if (
        isString(value.runId)
        && isString(value.ticketId)
        && isString(value.reason)
        && isString(value.details)
      ) {
        return {
          type: "merge-queue-evicted",
          timestamp: value.timestamp,
          runId: value.runId,
          ticketId: value.ticketId,
          reason: value.reason,
          details: value.details,
        };
      }
      return null;
    case "merge-queue-skipped":
      if (isString(value.runId) && isString(value.ticketId) && isString(value.reason)) {
        return {
          type: "merge-queue-skipped",
          timestamp: value.timestamp,
          runId: value.runId,
          ticketId: value.ticketId,
          reason: value.reason,
        };
      }
      return null;
    case "final-review-decision":
      if (
        isString(value.runId)
        && isString(value.unitId)
        && isNumber(value.iteration)
        && isDecisionStatus(value.status)
        && isString(value.reasoning)
        && typeof value.approvalSupersededRejection === "boolean"
        && typeof value.approvalOnlyCorrectedFormatting === "boolean"
      ) {
        return {
          type: "final-review-decision",
          timestamp: value.timestamp,
          runId: value.runId,
          unitId: value.unitId,
          iteration: value.iteration,
          status: value.status,
          reasoning: value.reasoning,
          approvalSupersededRejection: value.approvalSupersededRejection,
          approvalOnlyCorrectedFormatting: value.approvalOnlyCorrectedFormatting,
        };
      }
      return null;
    case "semantic-completion-update":
      if (
        isString(value.runId)
        && isNumber(value.totalUnits)
        && Array.isArray(value.unitsLanded)
        && Array.isArray(value.unitsSemanticallyComplete)
      ) {
        return {
          type: "semantic-completion-update",
          timestamp: value.timestamp,
          runId: value.runId,
          totalUnits: value.totalUnits,
          unitsLanded: value.unitsLanded.filter(isString),
          unitsSemanticallyComplete: value.unitsSemanticallyComplete.filter(isString),
        };
      }
      return null;
    case "pass-tracker-update":
      if (isString(value.runId) && isString(value.summary) && isNumber(value.maxConcurrency)) {
        return {
          type: "pass-tracker-update",
          timestamp: value.timestamp,
          runId: value.runId,
          summary: value.summary,
          maxConcurrency: value.maxConcurrency,
        };
      }
      return null;
    case "work-plan-loaded":
      if (!Array.isArray(value.units)) return null;
      for (const unit of value.units) {
        if (
          !isRecord(unit)
          || !isString(unit.id)
          || !isString(unit.name)
          || (unit.tier !== "small" && unit.tier !== "large")
          || !isString(unit.priority)
        ) {
          return null;
        }
      }
      return {
        type: "work-plan-loaded",
        timestamp: value.timestamp,
        units: value.units as WorkPlanLoadedEvent["units"],
      };
    default:
      return null;
  }
}

export async function readEventLog(path: string): Promise<SmithersEvent[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const events: SmithersEvent[] = [];
  const lines = raw.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const event = parseEvent(parsed);
    if (event) events.push(event);
  }
  return events;
}
