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
  const env = process.env as Record<string, string>;
  const reports: DiagnosticReport[] = [];
  const failedAgents: string[] = [];
  const warnings: string[] = [];

  for (const agent of enabledAgents) {
    const strategy = getDiagnosticStrategy(agent);
    if (!strategy) continue;

    const report = await runDiagnostics(strategy, { env, cwd });
    reports.push(report);
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
