/**
 * Tests for pre-flight diagnostics runner.
 *
 * Uses dependency injection (deps param) instead of mock.module to avoid
 * cross-file mock contamination when run alongside run.test.ts.
 */

import { describe, test, expect, mock } from "bun:test";
import { runPreflightDiagnostics, type DiagnosticDeps } from "./diagnostics";

// Types inlined to avoid TS2307 on deep smithers-orchestrator imports in tests
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

// ── Test helpers ────────────────────────────────────────────────────────

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

function makeDeps(overrides?: Partial<DiagnosticDeps>): DiagnosticDeps {
  return {
    getDiagnosticStrategy: mock(() => null) as any,
    runDiagnostics: mock(() => Promise.resolve(makeReport("unknown", []))) as any,
    formatDiagnosticSummary: (r: any) =>
      `[diagnostics] ${r.agentId}: ${r.checks.length} checks`,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("runPreflightDiagnostics", () => {
  test("happy path: all checks pass, returns ok=true", async () => {
    const strategy = { agentId: "claude-code", command: "claude", checks: [] };
    const deps = makeDeps({
      getDiagnosticStrategy: mock(() => strategy) as any,
      runDiagnostics: mock(() =>
        Promise.resolve(
          makeReport("claude-code", [
            makeCheck("cli_installed", "pass", "found"),
            makeCheck("api_key_valid", "pass", "valid"),
            makeCheck("rate_limit_status", "pass", "ok"),
          ]),
        ),
      ) as any,
    });

    const result = await runPreflightDiagnostics({
      enabledAgents: ["claude"],
      cwd: "/tmp",
      deps,
    });

    expect(result.ok).toBe(true);
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0].agentId).toBe("claude-code");
  });

  test("aborts with ok=false when api_key_valid check fails", async () => {
    const strategy = { agentId: "claude-code", command: "claude", checks: [] };
    const deps = makeDeps({
      getDiagnosticStrategy: mock(() => strategy) as any,
      runDiagnostics: mock(() =>
        Promise.resolve(
          makeReport("claude-code", [
            makeCheck("cli_installed", "pass", "found"),
            makeCheck("api_key_valid", "fail", "ANTHROPIC_API_KEY has bad format"),
            makeCheck("rate_limit_status", "pass", "ok"),
          ]),
        ),
      ) as any,
    });

    const result = await runPreflightDiagnostics({
      enabledAgents: ["claude"],
      cwd: "/tmp",
      deps,
    });

    expect(result.ok).toBe(false);
    expect(result.failedAgents).toContain("claude-code");
  });

  test("aborts with ok=false when cli_installed check fails", async () => {
    const strategy = { agentId: "codex", command: "codex", checks: [] };
    const deps = makeDeps({
      getDiagnosticStrategy: mock(() => strategy) as any,
      runDiagnostics: mock(() =>
        Promise.resolve(
          makeReport("codex", [
            makeCheck("cli_installed", "fail", "codex not found on PATH"),
            makeCheck("api_key_valid", "pass", "valid"),
          ]),
        ),
      ) as any,
    });

    const result = await runPreflightDiagnostics({
      enabledAgents: ["codex"],
      cwd: "/tmp",
      deps,
    });

    expect(result.ok).toBe(false);
    expect(result.failedAgents).toContain("codex");
  });

  test("rate_limit fail is warn-only, returns ok=true", async () => {
    const strategy = { agentId: "claude-code", command: "claude", checks: [] };
    const deps = makeDeps({
      getDiagnosticStrategy: mock(() => strategy) as any,
      runDiagnostics: mock(() =>
        Promise.resolve(
          makeReport("claude-code", [
            makeCheck("cli_installed", "pass", "found"),
            makeCheck("api_key_valid", "pass", "valid"),
            makeCheck("rate_limit_status", "fail", "rate limited"),
          ]),
        ),
      ) as any,
    });

    const result = await runPreflightDiagnostics({
      enabledAgents: ["claude"],
      cwd: "/tmp",
      deps,
    });

    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("rate");
  });

  test("only runs diagnostics for enabled agents", async () => {
    const mockGetStrategy = mock((cmd: string) => {
      if (cmd === "claude")
        return { agentId: "claude-code", command: "claude", checks: [] };
      return null;
    });
    const mockRunDiag = mock(() =>
      Promise.resolve(
        makeReport("claude-code", [
          makeCheck("cli_installed", "pass", "found"),
          makeCheck("api_key_valid", "pass", "valid"),
        ]),
      ),
    );
    const deps = makeDeps({
      getDiagnosticStrategy: mockGetStrategy as any,
      runDiagnostics: mockRunDiag as any,
    });

    const result = await runPreflightDiagnostics({
      enabledAgents: ["claude", "codex"],
      cwd: "/tmp",
      deps,
    });

    // Should only run for claude (codex strategy returned null)
    expect(mockRunDiag).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(result.reports).toHaveLength(1);
  });

  test("returns multiple failed agents when both fail", async () => {
    const deps = makeDeps({
      getDiagnosticStrategy: mock((cmd: string) => ({
        agentId: cmd,
        command: cmd,
        checks: [],
      })) as any,
      runDiagnostics: mock(async (strategy: any) =>
        makeReport(strategy.agentId, [
          makeCheck("cli_installed", "fail", `${strategy.command} not found`),
          makeCheck("api_key_valid", "pass", "ok"),
        ]),
      ) as any,
    });

    const result = await runPreflightDiagnostics({
      enabledAgents: ["claude", "codex"],
      cwd: "/tmp",
      deps,
    });

    expect(result.ok).toBe(false);
    expect(result.failedAgents).toContain("claude");
    expect(result.failedAgents).toContain("codex");
  });
});
