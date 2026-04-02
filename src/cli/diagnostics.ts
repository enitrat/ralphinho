/**
 * Pre-flight diagnostics — validates agent CLIs + API keys before workflow launch.
 *
 * Wraps smithers-orchestrator diagnostics for the ralphinho CLI.
 * Critical checks (cli_installed, api_key_valid) cause abort.
 * Non-critical checks (rate_limit_status) produce warnings only.
 *
 * Types are defined locally to avoid deep imports into smithers-orchestrator
 * internals. Runtime functions are loaded via dynamic import.
 */

import { createLogger } from "../runtime/logger";

const log = createLogger({ context: { phase: "diagnostics" } });

// ── Local types mirroring smithers-orchestrator/src/agents/diagnostics ───

type DiagnosticCheckId = "cli_installed" | "api_key_valid" | "rate_limit_status";
type DiagnosticCheckStatus = "pass" | "fail" | "skip" | "error";

type DiagnosticCheck = {
  id: DiagnosticCheckId;
  status: DiagnosticCheckStatus;
  message: string;
  detail?: Record<string, unknown>;
  durationMs: number;
};

export type DiagnosticReport = {
  agentId: string;
  command: string;
  timestamp: string;
  checks: DiagnosticCheck[];
  durationMs: number;
};

type DiagnosticStrategy = {
  agentId: string;
  command: string;
  checks: unknown[];
};

type DiagnosticContext = {
  env: Record<string, string>;
  cwd: string;
};

// ── Public API ──────────────────────────────────────────────────────────

/** Check IDs that cause a hard abort when they fail. */
const CRITICAL_CHECKS = new Set<DiagnosticCheckId>(["cli_installed", "api_key_valid"]);

export type PreflightResult = {
  ok: boolean;
  reports: DiagnosticReport[];
  failedAgents: string[];
  warnings: string[];
};

/** Injectable deps for testing without module-level mocks. */
export type DiagnosticDeps = {
  getDiagnosticStrategy: (command: string) => DiagnosticStrategy | null;
  runDiagnostics: (strategy: DiagnosticStrategy, ctx: DiagnosticContext) => Promise<DiagnosticReport>;
  formatDiagnosticSummary: (report: DiagnosticReport) => string;
};

async function loadDefaultDeps(): Promise<DiagnosticDeps> {
  const mod = await import("smithers-orchestrator/src/agents/diagnostics");
  return {
    getDiagnosticStrategy: mod.getDiagnosticStrategy,
    runDiagnostics: mod.runDiagnostics,
    formatDiagnosticSummary: mod.formatDiagnosticSummary,
  };
}

export async function runPreflightDiagnostics(opts: {
  enabledAgents: string[];
  cwd: string;
  deps?: DiagnosticDeps;
}): Promise<PreflightResult> {
  const { enabledAgents, cwd } = opts;
  const deps = opts.deps ?? await loadDefaultDeps();
  const { getDiagnosticStrategy, runDiagnostics, formatDiagnosticSummary } = deps;

  // Filter out undefined env values to satisfy Record<string, string>
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }

  const failedAgents: string[] = [];
  const warnings: string[] = [];

  // Collect strategies, skipping agents without a diagnostic strategy
  const strategies = enabledAgents
    .map((agent) => getDiagnosticStrategy(agent))
    .filter((s): s is NonNullable<typeof s> => s !== null);

  // Run all agent diagnostics in parallel since checks are independent
  const reports = await Promise.all(
    strategies.map((strategy) => runDiagnostics(strategy, { env, cwd })),
  );

  for (const report of reports) {
    log.info(formatDiagnosticSummary(report));

    for (const check of report.checks) {
      if (check.status === "fail") {
        if (CRITICAL_CHECKS.has(check.id)) {
          failedAgents.push(report.agentId);
        } else {
          warnings.push(`${report.agentId}: ${check.id} — ${check.message}`);
        }
      }
    }
  }

  return {
    ok: failedAgents.length === 0,
    reports,
    failedAgents,
    warnings,
  };
}
