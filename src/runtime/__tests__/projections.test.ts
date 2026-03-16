import { describe, expect, test } from "bun:test";

import type { StageName } from "../../workflows/ralphinho/workflow/contracts";
import { renderMonitorSnapshot } from "../../advanced-monitor-ui";
import type { SmithersEvent } from "../events";
import { projectEvents } from "../projections";

const BASE_TS = 1_710_000_000_000;

function workPlanLoaded(
  units: Array<{ id: string; name: string; tier: "small" | "large"; priority: string }>,
  timestamp = BASE_TS,
): SmithersEvent {
  return {
    type: "work-plan-loaded",
    timestamp,
    units,
  };
}

function nodeStarted(unitId: string, stageName: StageName, timestamp = BASE_TS + 10): SmithersEvent {
  return {
    type: "node-started",
    timestamp,
    runId: "run-1",
    nodeId: `${unitId}:${stageName}`,
    unitId,
    stageName,
  };
}

function nodeFailed(unitId: string, stageName: StageName, timestamp = BASE_TS + 20): SmithersEvent {
  return {
    type: "node-failed",
    timestamp,
    runId: "run-1",
    nodeId: `${unitId}:${stageName}`,
    unitId,
    stageName,
  };
}

function mergeQueueLanded(ticketId: string, timestamp = BASE_TS + 30): SmithersEvent {
  return {
    type: "merge-queue-landed",
    timestamp,
    runId: "run-1",
    ticketId,
    mergeCommit: null,
    summary: "Merged successfully",
  };
}

function mergeQueueEvicted(ticketId: string, timestamp = BASE_TS + 30): SmithersEvent {
  return {
    type: "merge-queue-evicted",
    timestamp,
    runId: "run-1",
    ticketId,
    reason: "conflict",
    details: "overlap",
  };
}

function finalReviewDecision(
  unitId: string,
  status: "pending" | "rejected" | "approved" | "invalidated",
  timestamp = BASE_TS + 25,
): SmithersEvent {
  return {
    type: "final-review-decision",
    timestamp,
    runId: "run-1",
    unitId,
    iteration: 1,
    status,
    reasoning: status,
    approvalSupersededRejection: status === "approved",
    approvalOnlyCorrectedFormatting: status === "invalidated",
  };
}

function semanticCompletionUpdate(
  totalUnits: number,
  unitsLanded: string[],
  unitsSemanticallyComplete: string[],
  timestamp = BASE_TS + 40,
): SmithersEvent {
  return {
    type: "semantic-completion-update",
    timestamp,
    runId: "run-1",
    totalUnits,
    unitsLanded,
    unitsSemanticallyComplete,
  };
}

function jobScheduled(
  jobType: string,
  agentId: string,
  ticketId: string | null,
  createdAtMs = BASE_TS + 5,
): SmithersEvent {
  return {
    type: "job-scheduled",
    timestamp: createdAtMs + 1,
    jobType,
    agentId,
    ticketId,
    createdAtMs,
  };
}

function jobCompleted(
  jobType: string,
  agentId: string,
  ticketId: string | null,
  timestamp = BASE_TS + 10,
): SmithersEvent {
  return {
    type: "job-completed",
    timestamp,
    jobType,
    agentId,
    ticketId,
  };
}

function passTrackerUpdate(summary: string, maxConcurrency: number, timestamp = BASE_TS + 40): SmithersEvent {
  return {
    type: "pass-tracker-update",
    timestamp,
    runId: "run-1",
    summary,
    maxConcurrency,
  };
}

describe("projectEvents", () => {
  test("handles empty event list", () => {
    const projected = projectEvents([]);
    expect(projected.phase).toBe("starting");
    expect(projected.tickets).toEqual([]);
    expect(projected.discovered).toBe(0);
    expect(projected.activeJobs).toEqual([]);
    expect(projected.inPipeline).toBe(0);
  });

  test("does not mark workflow done for landed-only units", () => {
    const events: SmithersEvent[] = [
      workPlanLoaded([{ id: "ticket-1", name: "Ticket One", tier: "large", priority: "high" }]),
      nodeStarted("ticket-1", "implement"),
      mergeQueueLanded("ticket-1"),
      finalReviewDecision("ticket-1", "invalidated"),
      semanticCompletionUpdate(1, ["ticket-1"], []),
    ];

    const projected = projectEvents(events);
    expect(projected.phase).toBe("pipeline");
    expect(projected.landed).toBe(1);
    expect(projected.semanticallyComplete).toBe(0);
  });

  test("marks workflow done only when units are semantically complete", () => {
    const events: SmithersEvent[] = [
      workPlanLoaded([{ id: "ticket-1", name: "Ticket One", tier: "large", priority: "high" }]),
      mergeQueueLanded("ticket-1"),
      finalReviewDecision("ticket-1", "approved"),
      semanticCompletionUpdate(1, ["ticket-1"], ["ticket-1"]),
    ];

    const projected = projectEvents(events);
    expect(projected.phase).toBe("done");
    expect(projected.semanticallyComplete).toBe(1);
  });

  test("marks stage as failed and keeps workflow in pipeline when a node fails", () => {
    const events: SmithersEvent[] = [
      workPlanLoaded([{ id: "ticket-2", name: "Ticket Two", tier: "small", priority: "medium" }]),
      nodeStarted("ticket-2", "implement"),
      nodeFailed("ticket-2", "implement"),
    ];

    const projected = projectEvents(events);
    const ticket = projected.tickets.find((entry) => entry.id === "ticket-2");
    const implementStage = ticket?.stages.find((stage) => stage.key === "implement");

    expect(projected.phase).toBe("pipeline");
    expect(ticket).toBeDefined();
    expect(implementStage?.status).toBe("failed");
  });

  test("tracks scheduled and completed jobs", () => {
    const now = BASE_TS + 1_000;
    const projected = projectEvents(
      [
        jobScheduled("ticket:implement", "claude", "ticket-1", BASE_TS),
        jobScheduled("discovery", "claude", null, BASE_TS + 100),
        jobCompleted("ticket:implement", "claude", "ticket-1", BASE_TS + 200),
      ],
      now,
    );

    expect(projected.activeJobs).toHaveLength(1);
    expect(projected.activeJobs[0]?.jobType).toBe("discovery");
  });

  test("uses pass tracker update for scheduler reasoning and concurrency", () => {
    const projected = projectEvents([
      passTrackerUpdate("2/6 units in progress", 6),
    ]);
    expect(projected.schedulerReasoning).toBe("2/6 units in progress");
    expect(projected.maxConcurrency).toBe(6);
  });

  test("tracks evicted tickets outside in-pipeline count", () => {
    const projected = projectEvents([
      workPlanLoaded([
        { id: "a", name: "A", tier: "small", priority: "medium" },
        { id: "b", name: "B", tier: "small", priority: "medium" },
      ]),
      mergeQueueEvicted("a"),
      mergeQueueLanded("b"),
      finalReviewDecision("b", "approved"),
      semanticCompletionUpdate(2, ["b"], ["b"]),
    ]);
    expect(projected.evicted).toBe(1);
    expect(projected.inPipeline).toBe(0);
  });
});

describe("monitor rendering with projection output", () => {
  test("renders semantic completion stats and ticket list from projected events", () => {
    const projected = projectEvents([
      workPlanLoaded([{ id: "ticket-1", name: "Ticket One", tier: "large", priority: "high" }]),
      nodeStarted("ticket-1", "implement"),
      finalReviewDecision("ticket-1", "rejected"),
    ]);
    const rendered = renderMonitorSnapshot(projected, {
      selectedIdx: 0,
      hasError: false,
      focus: "pipeline",
    });

    expect(rendered.phaseLine).toContain("Pipeline Active");
    expect(rendered.statsLine).toContain("Semantic:");
    expect(rendered.pipelineText).toContain("Ticket One");
  });
});
