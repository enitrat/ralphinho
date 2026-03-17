import type { Issue } from "../schemas";
import { TIER_STAGES } from "./contracts";
import type { ScheduledTier } from "./contracts";

export function tierHasStep(tier: ScheduledTier, step: string): boolean {
  return (TIER_STAGES[tier] as readonly string[]).includes(step);
}

export function buildIssueList(issues: Issue[] | null | undefined): string[] {
  if (!issues) return [];
  return issues.map((issue) => {
    const sev = issue.severity ? `[${issue.severity}] ` : "";
    const desc = issue.description ?? "Unspecified issue";
    const file = issue.file ? ` (${issue.file})` : "";
    return `${sev}${desc}${file}`;
  });
}
