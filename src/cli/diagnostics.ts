/**
 * Pre-flight diagnostics — validates agent CLIs + API keys before workflow launch.
 *
 * Wraps smithers-orchestrator/src/agents/diagnostics for the ralphinho CLI.
 * Critical checks (cli_installed, api_key_valid) cause abort.
 * Non-critical checks (rate_limit_status) produce warnings only.
 */

import {
  getDiagnosticStrategy,
  runDiagnostics,
  formatDiagnosticSummary,
  type DiagnosticReport,
} from "smithers-orchestrator/src/agents/diagnostics";
import { createLogger } from "../runtime/logger";

const log = createLogger({ context: { phase: "diagnostics" } });

/** Check IDs that cause a hard abort when they fail. */
const CRITICAL_CHECKS = new Set(["cli_installed", "api_key_valid"]);

export type PreflightResult = {
  ok: boolean;
  reports: DiagnosticReport[];
  failedAgents: string[];
  warnings: string[];
};

export async function runPreflightDiagnostics(opts: {
  enabledAgents: string[];
  cwd: string;
}): Promise<PreflightResult> {
  const { enabledAgents, cwd } = opts;
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
