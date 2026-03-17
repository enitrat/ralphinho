import React from "react";
import { Task } from "smithers-orchestrator";
import type { SmithersCtx, AgentLike } from "smithers-orchestrator";
import type { z } from "zod";
import { scheduledOutputSchemas } from "../schemas";
import { STAGE_RETRY_POLICIES } from "../workflow/contracts";
import type { ScheduledOutputs } from "./QualityPipeline";
import { buildFileSummary, buildMarkdownTable, type MarkdownColumn } from "./markdownTableUtils";

// ── Schema ───────────────────────────────────────────────────────────

export const prCreationResultSchema = scheduledOutputSchemas.pr_creation;
export type PrCreationResult = z.infer<typeof prCreationResultSchema>;

// ── Ticket type ──────────────────────────────────────────────────────

export type PushAndCreatePRTicket = {
  ticketId: string;
  ticketTitle: string;
  branch: string;
  worktreePath: string;
  filesModified: string[];
  filesCreated: string[];
};

// ── Props ────────────────────────────────────────────────────────────

export type PushAndCreatePRProps = {
  ctx: SmithersCtx<ScheduledOutputs>;
  tickets: PushAndCreatePRTicket[];
  agent: AgentLike | AgentLike[];
  fallbackAgent?: AgentLike;
  repoRoot: string;
  baseBranch?: string;
  branchPrefix?: string;
  output: typeof scheduledOutputSchemas.pr_creation;
  nodeId?: string;
};

// ── Prompt builder ───────────────────────────────────────────────────

function buildTicketTable(tickets: PushAndCreatePRTicket[]): string {
  const columns: MarkdownColumn<PushAndCreatePRTicket>[] = [
    { header: "#", separator: "---", cell: (_t, i) => String(i + 1) },
    { header: "Ticket ID", separator: "-----------", cell: (t) => t.ticketId },
    { header: "Title", separator: "-----", cell: (t) => t.ticketTitle },
    { header: "Branch", separator: "--------", cell: (t) => t.branch },
    { header: "Files Touched", separator: "---------------", cell: (t) => buildFileSummary(t) },
    { header: "Worktree", separator: "----------", cell: (t) => t.worktreePath },
  ];

  return buildMarkdownTable(columns, tickets);
}

function buildPRCreationPrompt(
  tickets: PushAndCreatePRTicket[],
  repoRoot: string,
  baseBranch: string,
  branchPrefix: string,
): string {
  const ticketTable = buildTicketTable(tickets);
  const ticketIds = tickets.map((t) => t.ticketId).join(", ") || "(none)";
  const worktreeList = tickets
    .map((t) => `- \`${t.ticketId}\`: \`${t.worktreePath}\` (branch: \`${t.branch}\`)`)
    .join("\n");

  return `# PR Creation Coordinator

You are the **PR creation coordinator**. Your job is to push branches and create GitHub pull requests for completed tickets.

## Current Time
${new Date().toISOString()}

## Repository
- Root: \`${repoRoot}\`
- Base branch: \`${baseBranch}\`

## Tickets to Process (${tickets.length} ticket(s))

${ticketTable}

## Worktrees

${worktreeList || "- (none)"}

## Instructions

Process each ticket in order. For each ticket:

1. **Push the branch** — Push the ticket branch to the remote:
   \`\`\`
   jj git push --bookmark ${branchPrefix}{ticketId}
   \`\`\`
   If the push fails, record the ticket in \`ticketsFailed\` with the reason and continue to the next ticket.

2. **Check for existing PR** — Check if a PR already exists for this branch:
   \`\`\`
   gh pr list --head ${branchPrefix}{ticketId} --json number,url
   \`\`\`
   If a PR already exists, record its URL and number in \`ticketsPushed\` and move to the next ticket.

3. **Create the PR** — If no PR exists, create one:
   \`\`\`
   gh pr create --base ${baseBranch} --head ${branchPrefix}{ticketId} --title "{ticketTitle}" --body "Automated PR for ticket {ticketId}"
   \`\`\`
   Record the PR URL and number in \`ticketsPushed\`.

4. **Handle failures** — If PR creation fails (e.g. branch not pushed, permissions), record in \`ticketsFailed\` with the error reason and continue.

## Available Commands

- \`jj git push --bookmark {branch}\` — Push a bookmark/branch to the remote
- \`gh pr create --base ${baseBranch} --head {branch} --title "..." --body "..."\` — Create a PR
- \`gh pr list --head {branch} --json number,url\` — Check for existing PRs
- Ready tickets in this run: ${ticketIds}

## Output Format

Return a JSON object matching this schema:
- \`ticketsPushed\`: Array of tickets you successfully pushed/created PRs for, with branch, prUrl (nullable if push succeeded but PR creation failed), prNumber (nullable), and summary
- \`ticketsFailed\`: Array of tickets that failed, with ticketId and reason
- \`summary\`: One paragraph summarizing what happened this PR creation run`;
}

// ── Component ────────────────────────────────────────────────────────

export function PushAndCreatePR({
  tickets,
  agent,
  fallbackAgent,
  repoRoot,
  baseBranch = "main",
  branchPrefix = "ticket/",
  output,
  nodeId = "pr-creation",
}: PushAndCreatePRProps) {
  if (tickets.length === 0) {
    return (
      <Task id={nodeId} output={output}>
        {{
          ticketsPushed: [],
          ticketsFailed: [],
          summary: "No tickets ready for PR creation this iteration.",
        }}
      </Task>
    );
  }

  const prompt = buildPRCreationPrompt(tickets, repoRoot, baseBranch, branchPrefix);

  return (
    <Task
      id={nodeId}
      output={output}
      agent={agent}
      fallbackAgent={fallbackAgent}
      retries={STAGE_RETRY_POLICIES["pr-creation"].retries}
      meta={{ retryPolicy: STAGE_RETRY_POLICIES["pr-creation"] }}
    >
      {prompt}
    </Task>
  );
}
