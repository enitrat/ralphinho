/**
 * Tests for pre-flight diagnostics runner.
 *
 * Mocks the smithers-orchestrator diagnostics module to test
 * routing, abort-on-fail, skip-diagnostics, and warn-only behaviors.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
// Types inlined to avoid TS2307 on deep smithers-orchestrator imports
type DiagnosticCheckId = "cli_installed" | "api_key_valid" | "rate_limit_status";
type DiagnosticCheckStatus = "pass" | "fail" | "skip" | "error";
type DiagnosticCheck = {
  id: DiagnosticCheckId;
  status: DiagnosticCheckStatus;
  message: string;
  detail?: Record<string, unknown>;
  durationMs: number;
};
type DiagnosticReport = {
  agentId: string;
  command: string;
  timestamp: string;
  checks: DiagnosticCheck[];
  durationMs: number;
};

// ── Mock infrastructure ──────────────────────────────────────────────

function makeCheck(
  id: DiagnosticCheck["id"],
  status: DiagnosticCheck["status"],
  message: string,
): DiagnosticCheck {
  return { id, status, message, durationMs: 10 };
}

function makeReport(
  agentId: string,
  checks: DiagnosticCheck[],
): DiagnosticReport {
  return {
    agentId,
    command: agentId,
    timestamp: new Date().toISOString(),
    checks,
    durationMs: 30,
  };
}

const mockGetDiagnosticStrategy = mock((_cmd: string) => null as any);
const mockRunDiagnostics = mock(
  (_strategy: any, _ctx: any) => Promise.resolve(makeReport("claude-code", [])) as any,
);

mock.module("smithers-orchestrator/src/agents/diagnostics", () => ({
  getDiagnosticStrategy: mockGetDiagnosticStrategy,
  runDiagnostics: mockRunDiagnostics,
  formatDiagnosticSummary: (r: DiagnosticReport) =>
    `[diagnostics] ${r.agentId}: ${r.checks.length} checks`,
}));

// Import after mocks
const { runPreflightDiagnostics } = await import("./diagnostics");

// ── Tests ────────────────────────────────────────────────────────────

describe("runPreflightDiagnostics", () => {
  beforeEach(() => {
    mockGetDiagnosticStrategy.mockReset();
    mockRunDiagnostics.mockReset();
  });

  test("happy path: all checks pass, returns ok=true", async () => {
    const strategy = { agentId: "claude-code", command: "claude", checks: [] };
    mockGetDiagnosticStrategy.mockReturnValue(strategy);
    mockRunDiagnostics.mockResolvedValue(
      makeReport("claude-code", [
        makeCheck("cli_installed", "pass", "found"),
        makeCheck("api_key_valid", "pass", "valid"),
        makeCheck("rate_limit_status", "pass", "ok"),
      ]),
    );

    const result = await runPreflightDiagnostics({
      enabledAgents: ["claude"],
      cwd: "/tmp",
    });

    expect(result.ok).toBe(true);
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0].agentId).toBe("claude-code");
  });

  test("aborts with ok=false when api_key_valid check fails", async () => {
    const strategy = { agentId: "claude-code", command: "claude", checks: [] };
    mockGetDiagnosticStrategy.mockReturnValue(strategy);
    mockRunDiagnostics.mockResolvedValue(
      makeReport("claude-code", [
        makeCheck("cli_installed", "pass", "found"),
        makeCheck("api_key_valid", "fail", "ANTHROPIC_API_KEY has bad format"),
        makeCheck("rate_limit_status", "pass", "ok"),
      ]),
    );

    const result = await runPreflightDiagnostics({
      enabledAgents: ["claude"],
      cwd: "/tmp",
    });

    expect(result.ok).toBe(false);
    expect(result.failedAgents).toContain("claude-code");
  });

  test("aborts with ok=false when cli_installed check fails", async () => {
    const strategy = { agentId: "codex", command: "codex", checks: [] };
    mockGetDiagnosticStrategy.mockReturnValue(strategy);
    mockRunDiagnostics.mockResolvedValue(
      makeReport("codex", [
        makeCheck("cli_installed", "fail", "codex not found on PATH"),
        makeCheck("api_key_valid", "pass", "valid"),
      ]),
    );

    const result = await runPreflightDiagnostics({
      enabledAgents: ["codex"],
      cwd: "/tmp",
    });

    expect(result.ok).toBe(false);
    expect(result.failedAgents).toContain("codex");
  });

  test("rate_limit fail is warn-only, returns ok=true", async () => {
    const strategy = { agentId: "claude-code", command: "claude", checks: [] };
    mockGetDiagnosticStrategy.mockReturnValue(strategy);
    mockRunDiagnostics.mockResolvedValue(
      makeReport("claude-code", [
        makeCheck("cli_installed", "pass", "found"),
        makeCheck("api_key_valid", "pass", "valid"),
        makeCheck("rate_limit_status", "fail", "rate limited"),
      ]),
    );

    const result = await runPreflightDiagnostics({
      enabledAgents: ["claude"],
      cwd: "/tmp",
    });

    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("rate");
  });

  test("only runs diagnostics for enabled agents", async () => {
    // claude has a strategy, codex does not (return null for codex)
    mockGetDiagnosticStrategy.mockImplementation((cmd: string) => {
      if (cmd === "claude")
        return { agentId: "claude-code", command: "claude", checks: [] };
      return null;
    });
    mockRunDiagnostics.mockResolvedValue(
      makeReport("claude-code", [
        makeCheck("cli_installed", "pass", "found"),
        makeCheck("api_key_valid", "pass", "valid"),
      ]),
    );

    const result = await runPreflightDiagnostics({
      enabledAgents: ["claude", "codex"],
      cwd: "/tmp",
    });

    // Should only run for claude (codex strategy returned null)
    expect(mockRunDiagnostics).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(result.reports).toHaveLength(1);
  });

  test("returns multiple failed agents when both fail", async () => {
    let callCount = 0;
    mockGetDiagnosticStrategy.mockImplementation((cmd: string) => {
      return { agentId: cmd, command: cmd, checks: [] };
    });
    mockRunDiagnostics.mockImplementation(async (strategy: any) => {
      return makeReport(strategy.agentId, [
        makeCheck("cli_installed", "fail", `${strategy.command} not found`),
        makeCheck("api_key_valid", "pass", "ok"),
      ]);
    });

    const result = await runPreflightDiagnostics({
      enabledAgents: ["claude", "codex"],
      cwd: "/tmp",
    });

    expect(result.ok).toBe(false);
    expect(result.failedAgents).toContain("claude");
    expect(result.failedAgents).toContain("codex");
  });
});
