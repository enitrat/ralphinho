import React from "react";
import { Task } from "smithers-orchestrator";
import type { SmithersCtx, AgentLike } from "smithers-orchestrator";
import type { z } from "zod";
import { scheduledOutputSchemas } from "../schemas";
import { STAGE_RETRY_POLICIES } from "../workflow/contracts";
import type { ScheduledOutputs } from "./QualityPipeline";
import { buildFileSummary, getAllFiles, buildMarkdownTable, type MarkdownColumn } from "./markdownTableUtils";

export const mergeQueueResultSchema = scheduledOutputSchemas.merge_queue;
export type MergeQueueResult = z.infer<typeof mergeQueueResultSchema>;

export type AgenticMergeQueueTicket = {
  ticketId: string;
  ticketTitle: string;
  ticketCategory: string;
  priority: "critical" | "high" | "medium" | "low";
  reportComplete: boolean;
  landed: boolean;
  filesModified: string[];
  filesCreated: string[];
  worktreePath: string;
  eligibilityProof: {
    decisionIteration: number | null;
    testIteration: number | null;
    approvalSupersededRejection: boolean;
  };
};

export type AgenticMergeQueueProps = {
  ctx: SmithersCtx<ScheduledOutputs>;
  outputs: ScheduledOutputs;
  tickets: AgenticMergeQueueTicket[];
  agent: AgentLike | AgentLike[];
  fallbackAgent?: AgentLike;
  postLandChecks: string[];
  preLandChecks: string[];
  repoRoot: string;
  baseBranch?: string;
  maxSpeculativeDepth?: number;
  output: typeof scheduledOutputSchemas.merge_queue;
  /** Override the Task node ID (default: "agentic-merge-queue") */
  nodeId?: string;
  /** Branch prefix for unit branches (default: "ticket/") */
  branchPrefix?: string;
};

const PRIORITY_ORDER: Record<AgenticMergeQueueTicket["priority"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function buildQueueStatusTable(tickets: AgenticMergeQueueTicket[]): string {
  const sorted = [...tickets].sort(
    (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority],
  );

  const columns: MarkdownColumn<AgenticMergeQueueTicket>[] = [
    { header: "#", cell: (_t, i) => String(i + 1) },
    { header: "Ticket ID", cell: (t) => t.ticketId },
    { header: "Title", cell: (t) => t.ticketTitle },
    { header: "Category", cell: (t) => t.ticketCategory },
    { header: "Priority", cell: (t) => t.priority },
    { header: "Files Touched", cell: (t) => buildFileSummary(t) },
    { header: "Worktree", cell: (t) => t.worktreePath },
  ];

  return buildMarkdownTable(columns, sorted);
}

function buildFileOverlapAnalysis(tickets: AgenticMergeQueueTicket[]): string {
  const fileToTickets = new Map<string, string[]>();
  for (const t of tickets) {
    for (const f of getAllFiles(t)) {
      const existing = fileToTickets.get(f) ?? [];
      existing.push(t.ticketId);
      fileToTickets.set(f, existing);
    }
  }
  const conflicts = [...fileToTickets.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([file, ids]) => `- \`${file}\` touched by: ${ids.join(", ")}`);

  if (conflicts.length === 0) return "No file overlaps detected — all tickets can be landed in parallel.";
  return `**File overlaps detected** (land these tickets sequentially, not speculatively):\n${conflicts.join("\n")}`;
}

function buildMergeQueuePrompt(
  tickets: AgenticMergeQueueTicket[],
  repoRoot: string,
  baseBranch: string,
  preLandChecks: string[],
  postLandChecks: string[],
  maxSpeculativeDepth: number,
  branchPrefix: string = "ticket/",
): string {
  const readyTickets = tickets.filter((t) => t.reportComplete && !t.landed);
  const queueTable = buildQueueStatusTable(readyTickets);

  const preLandCmds = preLandChecks.length
    ? preLandChecks.map((cmd) => `  - \`${cmd}\``).join("\n")
    : "  - (none configured)";

  const postLandCmds = postLandChecks.length
    ? postLandChecks.map((cmd) => `  - \`${cmd}\``).join("\n")
    : "  - (none configured)";

  const overlapAnalysis = buildFileOverlapAnalysis(readyTickets);
  const readyTicketIds = readyTickets.map((ticket) => ticket.ticketId).join(", ") || "(none)";
  const worktreeList = readyTickets
    .map((ticket) => {
      const proof = ticket.eligibilityProof;
      const proofBits = [
        `decisionIteration=${proof.decisionIteration ?? "unknown"}`,
        `testIteration=${proof.testIteration ?? "unknown"}`,
        `supersededRejection=${proof.approvalSupersededRejection}`,
      ];
      return `- \`${ticket.ticketId}\`: \`${ticket.worktreePath}\` (${proofBits.join(", ")})`;
    })
    .join("\n");

  return `# Merge Queue Coordinator

You are the **merge queue coordinator**. You operate against the target branch \`${baseBranch}\`.
Your job is to land completed tickets onto \`${baseBranch}\` in priority order.

## Current Time
${new Date().toISOString()}

## Repository
- Root: \`${repoRoot}\`
- Base branch: \`${baseBranch}\`
- Max speculative depth: ${maxSpeculativeDepth}

## Queue Status (${readyTickets.length} ticket(s) ready to land)

${queueTable}

## File Overlap Analysis

${overlapAnalysis}

## Worktrees

${worktreeList || "- (none)"}

**IMPORTANT:** When file overlaps exist, land non-overlapping tickets first (they can be speculative). Then land overlapping tickets one-by-one sequentially, rebasing each onto the updated ${baseBranch} before attempting the next. This prevents the systematic rebase conflicts seen when all tickets diverge from the same base.

## Instructions

Process tickets in **priority order** (critical > high > medium > low). For each ticket:

1. **Pre-land checks** — Run these in the ticket's worktree to verify it's still healthy:
${preLandCmds}

2. **Rebase onto ${baseBranch}** — Rebase the ticket branch onto the current tip of ${baseBranch}:
   \`\`\`
   jj rebase -b bookmark("${branchPrefix}{ticketId}") -d ${baseBranch}
   \`\`\`
   If conflicts occur, attempt to understand the conflict. If it's trivially resolvable (e.g. lockfile, generated code), resolve it. Otherwise evict the ticket with detailed context about what conflicted and why.

3. **Post-land checks** — Run CI checks after rebase to verify the merged result:
${postLandCmds}

4. **Advance ${baseBranch}** — If all checks pass:
   \`\`\`
   jj bookmark set ${baseBranch} -r bookmark("${branchPrefix}{ticketId}")
   \`\`\`

5. **Push** — Push the updated \`${baseBranch}\` bookmark if this repository expects remote landing from the merge queue:
   \`\`\`
   jj git push --bookmark ${baseBranch}
   \`\`\`
   Do not substitute \`main\` here unless \`${baseBranch}\` is literally named \`main\`.

6. **Cleanup** — Delete the ticket bookmark. If you close worktrees, use the actual worktree path recorded for the ticket above rather than an invented workspace name.
   Example:
   \`\`\`
   jj bookmark delete ${branchPrefix}{ticketId}
   # then close/remove the matching worktree path for that ticket if appropriate
   \`\`\`

## Handling Failures

- **Merge conflicts**: Inspect the conflict markers. If trivially resolvable, resolve and continue. If complex, evict the ticket with:
  - Which files conflicted
  - What the conflicting changes are
  - What landed on ${baseBranch} since the ticket branched that caused the conflict
- **CI failures**: Check if the failure is flaky (retry once). If it fails again, evict with the full CI output.
- **Push failures**: This usually means \`${baseBranch}\` moved. Fetch, re-rebase, and retry. If it fails 3 times, evict.

## Available jj Operations

All operations use \`jj\` (NOT git). Key commands:
- \`jj rebase -b bookmark("${branchPrefix}{ticketId}") -d ${baseBranch}\` — Rebase ticket onto \`${baseBranch}\`
- \`jj bookmark set ${baseBranch} -r bookmark("${branchPrefix}{ticketId}")\` — Advance \`${baseBranch}\`
- \`jj git push --bookmark ${baseBranch}\` — Push \`${baseBranch}\` to remote when remote landing is intended
- \`jj git fetch\` — Fetch latest from remote
- \`jj log -r "${baseBranch}..bookmark(\\"${branchPrefix}{ticketId}\\")" --reversed\` — Show ticket commits
- \`jj diff -r "roots(${baseBranch}..bookmark(\\"${branchPrefix}{ticketId}\\"))" --summary\` — Show changed files
- \`jj bookmark delete ${branchPrefix}{ticketId}\` — Remove ticket bookmark
- Ready tickets in this run: ${readyTicketIds}

## Output Format

Return a JSON object matching this schema:
- \`ticketsLanded\`: Array of tickets you successfully landed, with their merge commit hash, a short summary, and the exact eligibility proof copied from the ready ticket metadata
- \`ticketsEvicted\`: Array of tickets you evicted, with the reason and detailed context
- \`ticketsSkipped\`: Array of tickets you skipped (not ready, already landed, etc.) with reason
- \`summary\`: One paragraph summarizing what happened this merge queue run
- \`nextActions\`: Any follow-up actions needed (e.g. "ticket X needs conflict resolution"), or null`;
}

export function AgenticMergeQueue({
  tickets,
  agent,
  fallbackAgent,
  postLandChecks,
  preLandChecks,
  repoRoot,
  baseBranch = "main",
  maxSpeculativeDepth = 4,
  output,
  nodeId = "agentic-merge-queue",
  branchPrefix = "ticket/",
}: AgenticMergeQueueProps) {
  const readyTickets = tickets.filter((t) => t.reportComplete && !t.landed);

  if (readyTickets.length === 0) {
    return (
      <Task id={nodeId} output={output}>
        {{
          ticketsLanded: [],
          ticketsEvicted: [],
          ticketsSkipped: [],
          summary: "No tickets ready for merge queue this iteration.",
          nextActions: null,
        }}
      </Task>
    );
  }

  const prompt = buildMergeQueuePrompt(
    tickets,
    repoRoot,
    baseBranch,
    preLandChecks,
    postLandChecks,
    maxSpeculativeDepth,
    branchPrefix,
  );

  return (
    <Task
      id={nodeId}
      output={output}
      agent={agent}
      fallbackAgent={fallbackAgent}
      retries={STAGE_RETRY_POLICIES["merge-queue"].retries}
      meta={{ retryPolicy: STAGE_RETRY_POLICIES["merge-queue"] }}
    >
      {prompt}
    </Task>
  );
}
