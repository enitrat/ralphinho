/**
 * Consume an approved ticket from Linear for ralphinho implementation.
 *
 * Fetches the highest-priority issue matching a label filter,
 * converts it to RFC-like markdown content for the scheduled-work pipeline,
 * and provides helpers to update the ticket after completion.
 */

import { useLinear } from "smithers-orchestrator/linear";
import type { LinearIssue } from "smithers-orchestrator/linear";
import type { ConsumedTicket } from "./types";
import { parseIssueMetadata } from "./parse-issue-metadata";

export type ConsumedBatch = {
  tickets: ConsumedTicket[];
  unparseable: ConsumedTicket[];
};

export function issueToRfc(issue: LinearIssue): string {
  const lines: string[] = [];

  lines.push(`# ${issue.identifier}: ${issue.title}`);
  lines.push("");

  if (issue.description) {
    lines.push("## Description");
    lines.push("");
    lines.push(issue.description);
    lines.push("");
  }

  lines.push("## Context");
  lines.push("");
  lines.push(`- **Linear issue:** ${issue.identifier} (${issue.url})`);
  if (issue.state) {
    lines.push(`- **Status:** ${issue.state.name}`);
  }
  if (issue.priorityLabel) {
    lines.push(`- **Priority:** ${issue.priorityLabel}`);
  }
  if (issue.labels.length > 0) {
    lines.push(`- **Labels:** ${issue.labels.map((l) => l.name).join(", ")}`);
  }
  lines.push("");

  lines.push("## Acceptance Criteria");
  lines.push("");
  lines.push("- Implement the changes described above");
  lines.push("- Ensure all existing tests pass");
  lines.push("- Add tests for new behavior where appropriate");
  lines.push("");

  return lines.join("\n");
}

/**
 * Fetch the highest-priority approved ticket from Linear.
 * Returns null if no matching tickets are found.
 */
export async function consumeTicket(opts: {
  teamId?: string;
  label: string;
}): Promise<ConsumedTicket | null> {
  const { teamId, label } = opts;
  const linear = useLinear();

  const issues = await linear.listIssues({
    teamId,
    labels: [label],
    stateType: "unstarted",
    limit: 10,
  });

  if (issues.length === 0) {
    // Also check "started" state in case some are in progress
    const startedIssues = await linear.listIssues({
      teamId,
      labels: [label],
      stateType: "started",
      limit: 10,
    });

    if (startedIssues.length === 0) {
      return null;
    }

    // Sort by priority (1=urgent, 4=low) and take the first
    startedIssues.sort((a, b) => a.priority - b.priority);
    const issue = startedIssues[0]!;
    return { issue, rfcContent: issueToRfc(issue) };
  }

  // Sort by priority (1=urgent, 4=low) and take the first
  issues.sort((a, b) => a.priority - b.priority);
  const issue = issues[0]!;

  return { issue, rfcContent: issueToRfc(issue) };
}

/**
 * Mark a ticket as in-progress in Linear.
 * Finds the "In Progress" state for the team and transitions the issue.
 */
export async function markTicketInProgress(opts: {
  issueId: string;
  teamId: string;
}): Promise<void> {
  const linear = useLinear();

  const statuses = await linear.listIssueStatuses(opts.teamId);
  const inProgressState = statuses.find((s) => s.type === "started");

  if (inProgressState) {
    await linear.updateIssueState(opts.issueId, inProgressState.id);
  }

  await linear.addComment(
    opts.issueId,
    "Ralphinho is working on this ticket.",
  );
}

/**
 * Mark a ticket as done in Linear with implementation details.
 * Finds the "Done" state for the team and transitions the issue.
 */
export async function markTicketDone(opts: {
  issueId: string;
  teamId?: string;
  summary: string;
  prUrl?: string;
}): Promise<void> {
  const linear = useLinear();

  if (opts.teamId) {
    const statuses = await linear.listIssueStatuses(opts.teamId);
    const doneState = statuses.find((s) => s.type === "completed");
    if (doneState) {
      await linear.updateIssueState(opts.issueId, doneState.id);
    }
  }

  const lines = ["## Implementation Complete"];
  lines.push("");
  lines.push(opts.summary);

  if (opts.prUrl) {
    lines.push("");
    lines.push(`**PR:** ${opts.prUrl}`);
  }

  lines.push("");
  lines.push("*Implemented by ralphinho*");

  await linear.addComment(opts.issueId, lines.join("\n"));
}

/**
 * Fetch all actionable tickets from Linear (unstarted + started),
 * deduplicate, sort by priority, parse metadata, and split into
 * parseable tickets vs unparseable ones.
 */
export async function consumeAllTickets(opts: {
  teamId?: string;
  label: string;
}): Promise<ConsumedBatch> {
  const { teamId, label } = opts;
  const linear = useLinear();

  // 1. Fetch both states in parallel
  const [unstartedIssues, startedIssues] = await Promise.all([
    linear.listIssues({ teamId, labels: [label], stateType: "unstarted", limit: 50 }),
    linear.listIssues({ teamId, labels: [label], stateType: "started", limit: 50 }),
  ]);

  // 2. Deduplicate by ID
  const seen = new Set<string>();
  const allIssues: LinearIssue[] = [];
  for (const issue of [...unstartedIssues, ...startedIssues]) {
    if (!seen.has(issue.id)) {
      seen.add(issue.id);
      allIssues.push(issue);
    }
  }

  // 3. Sort by priority ascending (1=urgent first)
  allIssues.sort((a, b) => a.priority - b.priority);

  // 4. Parse metadata and split
  const tickets: ConsumedTicket[] = [];
  const unparseable: ConsumedTicket[] = [];

  for (const issue of allIssues) {
    const metadata = parseIssueMetadata(issue.description);
    const consumed: ConsumedTicket = {
      issue,
      rfcContent: issueToRfc(issue),
      metadata,
    };

    if (metadata.primaryFile) {
      tickets.push(consumed);
    } else {
      unparseable.push(consumed);
    }
  }

  return { tickets, unparseable };
}
