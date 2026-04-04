import { describe, expect, test } from "bun:test";
import { fmtTokenCount, metricsContent } from "../advanced-monitor-ui";
import type { PollData } from "../runtime/projections";

function makePollData(overrides: Partial<PollData> = {}): PollData {
  return {
    tickets: [],
    activeJobs: [],
    discovered: 0,
    landed: 0,
    semanticallyComplete: 0,
    evicted: 0,
    inPipeline: 0,
    maxConcurrency: 0,
    phase: "pipeline",
    mergeQueueActivity: null,
    schedulerReasoning: null,
    discoveryCount: 0,
    inputTokensTotal: 0,
    outputTokensTotal: 0,
    cacheReadTokensTotal: 0,
    runDurationMs: 0,
    ...overrides,
  };
}

describe("fmtTokenCount", () => {
  test("formats large numbers with commas", () => {
    expect(fmtTokenCount(1234567)).toBe("1,234,567");
  });

  test("returns dash for zero", () => {
    expect(fmtTokenCount(0)).toBe("—");
  });

  test("formats small numbers without commas", () => {
    expect(fmtTokenCount(42)).toBe("42");
  });
});

describe("metricsContent", () => {
  test("returns dashes when all token fields are zero", () => {
    const result = metricsContent(makePollData(), 0);
    // All token lines should show dash
    expect(result).toContain("—");
    // Should not contain any digit except in Agents/Errors lines
    const lines = result.split("\n");
    expect(lines[0]).toContain("—"); // Tokens In
    expect(lines[1]).toContain("—"); // Cache Read
    expect(lines[2]).toContain("—"); // Duration
  });

  test("formats token counts when data is present", () => {
    const result = metricsContent(makePollData({
      inputTokensTotal: 1234567,
      outputTokensTotal: 45678,
      cacheReadTokensTotal: 98765,
    }), 0);
    expect(result).toContain("1,234,567");
    expect(result).toContain("45,678");
    expect(result).toContain("98,765");
  });

  test("shows active agent count from activeJobs.length", () => {
    const result = metricsContent(makePollData({
      activeJobs: [
        { agentId: "a", jobType: "discovery", ticketId: null, elapsedMs: 100 },
        { agentId: "b", jobType: "discovery", ticketId: null, elapsedMs: 200 },
        { agentId: "c", jobType: "discovery", ticketId: null, elapsedMs: 300 },
      ],
    }), 0);
    expect(result).toContain("Agents:");
    expect(result).toMatch(/Agents:\s+3/);
  });

  test("shows error count", () => {
    const result = metricsContent(makePollData(), 5);
    expect(result).toContain("Errors: 5");
  });

  test("formats duration as Xm YYs", () => {
    const result = metricsContent(makePollData({ runDurationMs: 754000 }), 0);
    expect(result).toContain("12m34s");
  });
});
