import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

import { parseEvent, readEventLog } from "../events";

const TMP_PREFIX = `/tmp/super-ralph-events-${process.pid}-`;
const created: string[] = [];

async function writeTmp(contents: string): Promise<string> {
  const path = `${TMP_PREFIX}${Date.now()}-${Math.random().toString(16).slice(2)}.ndjson`;
  await Bun.write(path, contents);
  created.push(path);
  return path;
}

afterEach(() => {
  for (const path of created.splice(0)) {
    try {
      rmSync(path);
    } catch {
      // ignore cleanup failures
    }
  }
});

describe("readEventLog", () => {
  test("returns [] when file does not exist", async () => {
    const events = await readEventLog("/tmp/does-not-exist-events.ndjson");
    expect(events).toEqual([]);
  });

  test("skips malformed JSON lines and unknown event types", async () => {
    const path = await writeTmp([
      '{"type":"node-started","timestamp":1,"runId":"run-1","nodeId":"u:implement","unitId":"u","stageName":"implement"}',
      "not-json",
      '{"type":"unknown-event","timestamp":2}',
      '{"type":"node-completed","timestamp":3,"runId":"run-1","nodeId":"u:implement","unitId":"u","stageName":"implement"}',
      "",
    ].join("\n"));

    const events = await readEventLog(path);
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("node-started");
    expect(events[1]?.type).toBe("node-completed");
  });
});

describe("parseEvent", () => {
  // ── Valid variants ──────────────────────────────────────────────

  test("parses node-started with valid StageName", () => {
    const input = {
      type: "node-started",
      timestamp: 1000,
      runId: "run-1",
      nodeId: "n1",
      unitId: "u1",
      stageName: "implement",
    };
    const result = parseEvent(input);
    expect(result).toEqual(input);
  });

  test("parses node-completed with valid StageName", () => {
    const input = {
      type: "node-completed",
      timestamp: 2000,
      runId: "run-1",
      nodeId: "n1",
      unitId: "u1",
      stageName: "test",
    };
    const result = parseEvent(input);
    expect(result).toEqual(input);
  });

  test("parses node-failed with error string", () => {
    const input = {
      type: "node-failed",
      timestamp: 3000,
      runId: "run-1",
      nodeId: "n1",
      unitId: "u1",
      stageName: "research",
      error: "something broke",
    };
    const result = parseEvent(input);
    expect(result).toEqual(input);
  });

  test("parses node-failed without error (optional field omitted)", () => {
    const input = {
      type: "node-failed",
      timestamp: 3001,
      runId: "run-1",
      nodeId: "n1",
      unitId: "u1",
      stageName: "plan",
    };
    const result = parseEvent(input);
    expect(result).toEqual(input);
  });

  test("parses job-scheduled with null ticketId", () => {
    const input = {
      type: "job-scheduled",
      timestamp: 4000,
      jobType: "ci",
      agentId: "a1",
      ticketId: null,
      createdAtMs: 4000000,
    };
    const result = parseEvent(input);
    expect(result).toEqual(input);
  });

  test("parses job-scheduled with string ticketId", () => {
    const input = {
      type: "job-scheduled",
      timestamp: 4001,
      jobType: "ci",
      agentId: "a1",
      ticketId: "t1",
      createdAtMs: 4001000,
    };
    const result = parseEvent(input);
    expect(result).toEqual(input);
  });

  test("parses job-completed with nullable ticketId", () => {
    const input = {
      type: "job-completed",
      timestamp: 5000,
      jobType: "ci",
      agentId: "a1",
      ticketId: null,
    };
    const result = parseEvent(input);
    expect(result).toEqual(input);
  });

  test("parses merge-queue-landed with null mergeCommit", () => {
    const input = {
      type: "merge-queue-landed",
      timestamp: 6000,
      runId: "run-1",
      ticketId: "t1",
      mergeCommit: null,
      summary: "landed ok",
    };
    const result = parseEvent(input);
    expect(result).toEqual(input);
  });

  test("parses merge-queue-evicted", () => {
    const input = {
      type: "merge-queue-evicted",
      timestamp: 7000,
      runId: "run-1",
      ticketId: "t1",
      reason: "conflict",
      details: "merge conflict in foo.ts",
    };
    const result = parseEvent(input);
    expect(result).toEqual(input);
  });

  test("parses merge-queue-skipped", () => {
    const input = {
      type: "merge-queue-skipped",
      timestamp: 8000,
      runId: "run-1",
      ticketId: "t1",
      reason: "already merged",
    };
    const result = parseEvent(input);
    expect(result).toEqual(input);
  });

  test("parses pass-tracker-update", () => {
    const input = {
      type: "pass-tracker-update",
      timestamp: 9000,
      runId: "run-1",
      summary: "pass 2 of 3",
      maxConcurrency: 4,
    };
    const result = parseEvent(input);
    expect(result).toEqual(input);
  });

  test("parses work-plan-loaded with nested units", () => {
    const input = {
      type: "work-plan-loaded",
      timestamp: 10000,
      units: [
        { id: "u1", name: "Unit 1", tier: "small" as const, priority: "high" },
        { id: "u2", name: "Unit 2", tier: "large" as const, priority: "low" },
      ],
    };
    const result = parseEvent(input);
    expect(result).toEqual(input);
  });

  test("parses final-review-decision", () => {
    const input = {
      type: "final-review-decision",
      timestamp: 11000,
      runId: "run-1",
      unitId: "u1",
      iteration: 2,
      status: "approved" as const,
      reasoning: "looks good",
      approvalSupersededRejection: false,
      approvalOnlyCorrectedFormatting: true,
    };
    const result = parseEvent(input);
    expect(result).toEqual(input);
  });

  test("parses semantic-completion-update with string arrays", () => {
    const input = {
      type: "semantic-completion-update",
      timestamp: 12000,
      runId: "run-1",
      totalUnits: 5,
      unitsLanded: ["u1", "u2"],
      unitsSemanticallyComplete: ["u1"],
    };
    const result = parseEvent(input);
    expect(result).toEqual(input);
  });

  // ── Invalid inputs ──────────────────────────────────────────────

  test("returns null for null input", () => {
    expect(parseEvent(null)).toBeNull();
  });

  test("returns null for string input", () => {
    expect(parseEvent("hello")).toBeNull();
  });

  test("returns null for unknown event type", () => {
    expect(parseEvent({ type: "unknown-event", timestamp: 1 })).toBeNull();
  });

  test("returns null for missing required fields", () => {
    // node-started missing runId, nodeId, unitId, stageName
    expect(parseEvent({ type: "node-started", timestamp: 1 })).toBeNull();
  });

  test("returns null for wrong field types", () => {
    expect(parseEvent({
      type: "node-started",
      timestamp: "not-a-number",
      runId: "run-1",
      nodeId: "n1",
      unitId: "u1",
      stageName: "implement",
    })).toBeNull();
  });

  test("returns null for invalid stage name", () => {
    expect(parseEvent({
      type: "node-started",
      timestamp: 1,
      runId: "run-1",
      nodeId: "n1",
      unitId: "u1",
      stageName: "invalid-stage",
    })).toBeNull();
  });

  test("filters non-string elements from semantic-completion-update arrays", () => {
    const input = {
      type: "semantic-completion-update",
      timestamp: 12000,
      runId: "run-1",
      totalUnits: 5,
      unitsLanded: [1, "a", 2],
      unitsSemanticallyComplete: ["b", null, "c"],
    };
    const result = parseEvent(input);
    expect(result).not.toBeNull();
    expect((result as any).unitsLanded).toEqual(["a"]);
    expect((result as any).unitsSemanticallyComplete).toEqual(["b", "c"]);
  });
});
