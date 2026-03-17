# Batch Linear Pipeline with File-Based Parallelism

> **Status**: Draft
> **Date**: 2026-03-17
> **Goal**: Replace single-ticket Linear consumption with batch fetch + file-overlap scheduling + PR creation

## Problem

Today, `ralphinho run --linear` consumes **one ticket at a time** from Linear, decomposes it via AI into work units, executes the quality pipeline, and lands directly on main via the AgenticMergeQueue. This is sequential and has no PR-based review step.

We want to:
1. Pull **all** approved issues from Linear at once
2. Automatically **schedule them for max parallelism** based on which files they touch
3. **Open PRs on GitHub** instead of merging directly to main

## Key Insight

Improvinho issues already declare their target file in a structured format:

```markdown
**Kind:** simplification
**Priority:** low
**Confidence:** high
**File:** `src/adapters/linear/push-findings.ts`
**Lines:** `src/adapters/linear/push-findings.ts:121`
**Symbol:** `resolveLabel`
```

The `**File:**` field is always present (set from `MergedReviewFinding.primaryFile`, non-nullable in `improvinho/types.ts:71`). This gives us a **free, deterministic scheduling heuristic** — no AI needed.

**Simple rule**: tickets on different files are parallelizable; tickets on the same file are sequential.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    CLI: ralphinho run --linear --batch   │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  1. consumeAllTickets()      ← batch fetch from Linear  │
│     ↓                                                   │
│  2. parseIssueMetadata()     ← extract File: field      │
│     ↓                                                   │
│  3. groupByFileOverlap()     ← union-find partitioning  │
│     ↓                                                   │
│  ┌─── Group A (file1.ts) ───┐  ┌─── Group B ──────┐    │
│  │ ticket-1 → ticket-4      │  │ ticket-2          │    │
│  │ (sequential: same file)  │  │ (standalone)      │    │
│  └───────────────────────────┘  └──────────────────┘    │
│     ↓                           ↓                       │
│  4. groupToWorkPlan()        ← tickets → WorkUnits      │
│     ↓                           ↓                       │
│  5. ScheduledWorkflow        ← existing component!      │
│     (with PushAndCreatePR instead of AgenticMergeQueue) │
│     ↓                                                   │
│  6. markTicketDone()         ← update Linear status     │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Parallelism Model

- **Across groups**: fully parallel (independent file sets, separate Smithers runs)
- **Within a group, across files**: parallel (jj worktrees, existing `<Parallel>` component)
- **Within a group, same file**: sequential (WorkUnit deps chain)

Example with 5 tickets:

```
Tickets:
  IMP-0001 → file1.ts
  IMP-0002 → file2.ts
  IMP-0003 → file1.ts    (shares file with IMP-0001)
  IMP-0004 → file3.ts
  IMP-0005 → file2.ts    (shares file with IMP-0002)

Grouping (union-find):
  Group 0: IMP-0001, IMP-0003         → files: [file1.ts]
  Group 1: IMP-0002, IMP-0005         → files: [file2.ts]
  Group 2: IMP-0004                   → files: [file3.ts]

Within Group 0 WorkPlan:
  IMP-0001 (deps: [])     ← runs first
  IMP-0003 (deps: [IMP-0001])  ← runs after IMP-0001 lands

Groups 0, 1, 2 execute in parallel (separate Smithers runs).
```

### Transitive Conflicts

If ticket A touches file1, B touches file1+file2, C touches file2:
- A↔B share file1, B↔C share file2
- Union-find correctly groups all three together even though A and C don't directly overlap

## Implementation Plan

### Step 1: Issue Metadata Parser

This plan is an inspiration and you are under no obligation to follow it exactly.
Notably, you will respect proper coding practices in Typescript, ensure no inline imports, re-definition of existing exports, functions, etc.

**Create** `src/adapters/linear/parse-issue-metadata.ts`

```typescript
export type IssueMetadata = {
  kind: string | null;
  priority: string | null;
  confidence: string | null;
  primaryFile: string | null;
  lineRefs: string[];
  symbol: string | null;
};

/**
 * Parse structured metadata from an improvinho-generated Linear issue description.
 * Matches the format produced by findingToDescription() in push-findings.ts.
 */
export function parseIssueMetadata(description: string | null): IssueMetadata {
  if (!description) {
    return { kind: null, priority: null, confidence: null, primaryFile: null, lineRefs: [], symbol: null };
  }

  const extract = (key: string): string | null => {
    const match = description.match(new RegExp(`\\*\\*${key}:\\*\\*\\s*\`?([^\`\\n]+)\`?`));
    return match?.[1]?.trim() ?? null;
  };

  const linesRaw = extract("Lines");
  const lineRefs = linesRaw
    ? linesRaw.split(",").map(r => r.trim().replace(/^`|`$/g, "")).filter(Boolean)
    : [];

  return {
    kind: extract("Kind"),
    priority: extract("Priority"),
    confidence: extract("Confidence"),
    primaryFile: extract("File"),
    lineRefs,
    symbol: extract("Symbol"),
  };
}
```

**Tests**: Verify parsing against actual improvinho output format. Test edge cases (null description, missing fields, backtick variations).

### Step 2: Batch Linear Fetch

**Modify** `src/adapters/linear/consume-tickets.ts`

- Export `issueToRfc` (currently private — needed by batch path and fixes test duplication issue IMP-0001)
- Add `consumeAllTickets()` function:

```typescript
export type ConsumedBatch = {
  tickets: ConsumedTicket[];
  unparseable: LinearIssue[];
};

export async function consumeAllTickets(opts: {
  teamId?: string;
  label: string;
}): Promise<ConsumedBatch> {
  const linear = useLinear();

  const [unstarted, started] = await Promise.all([
    linear.listIssues({ teamId: opts.teamId, labels: [opts.label], stateType: "unstarted", limit: 50 }),
    linear.listIssues({ teamId: opts.teamId, labels: [opts.label], stateType: "started", limit: 50 }),
  ]);

  // Deduplicate by ID
  const seen = new Set<string>();
  const allIssues: LinearIssue[] = [];
  for (const issue of [...unstarted, ...started]) {
    if (!seen.has(issue.id)) {
      seen.add(issue.id);
      allIssues.push(issue);
    }
  }

  allIssues.sort((a, b) => a.priority - b.priority);

  const tickets: ConsumedTicket[] = [];
  const unparseable: LinearIssue[] = [];

  for (const issue of allIssues) {
    const meta = parseIssueMetadata(issue.description);
    if (!meta.primaryFile) {
      unparseable.push(issue);
      continue;
    }
    tickets.push({ issue, rfcContent: issueToRfc(issue), metadata: meta });
  }

  return { tickets, unparseable };
}
```

**Modify** `src/adapters/linear/types.ts`

- Add optional `metadata` field to `ConsumedTicket`:

```typescript
export type ConsumedTicket = {
  issue: import("smithers-orchestrator/linear").LinearIssue;
  rfcContent: string;
  metadata?: import("./parse-issue-metadata").IssueMetadata;
};
```

### Step 3: File-Overlap Scheduler

**Create** `src/workflows/ralphinho/scheduler.ts`

Two pure functions:

#### `groupByFileOverlap(tickets) → ParallelismGroup[]`

- Union-find on ticket indices, union when they share a `primaryFile`
- Returns groups with their file sets and tickets (pre-sorted by priority)

```typescript
export type ParallelismGroup = {
  id: string;
  files: string[];
  tickets: ConsumedTicket[];
};

export function groupByFileOverlap(tickets: ConsumedTicket[]): ParallelismGroup[] {
  if (tickets.length === 0) return [];

  const fileToTicketIdx = new Map<string, number[]>();
  for (let i = 0; i < tickets.length; i++) {
    const file = tickets[i].metadata?.primaryFile;
    if (!file) continue;
    const existing = fileToTicketIdx.get(file) ?? [];
    existing.push(i);
    fileToTicketIdx.set(file, existing);
  }

  // Union-Find
  const parent = tickets.map((_, i) => i);
  function find(x: number): number {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  }
  function union(a: number, b: number) { parent[find(a)] = find(b); }

  for (const indices of fileToTicketIdx.values()) {
    for (let i = 1; i < indices.length; i++) {
      union(indices[0], indices[i]);
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < tickets.length; i++) {
    const root = find(i);
    const existing = groups.get(root) ?? [];
    existing.push(i);
    groups.set(root, existing);
  }

  return [...groups.values()].map((indices, groupIdx) => {
    const groupTickets = indices.map(i => tickets[i]);
    const files = [...new Set(
      groupTickets.map(t => t.metadata?.primaryFile).filter(Boolean) as string[]
    )];
    return { id: `group-${groupIdx}`, files, tickets: groupTickets };
  });
}
```

#### `groupToWorkPlan(group, repoConfig) → WorkPlan`

- Per-file chains: tickets on the same file get sequential deps
- Tickets on different files within the group have no deps (parallel via existing `<Parallel>`)
- No AI decomposition needed — each ticket = one WorkUnit

```typescript
export function groupToWorkPlan(
  group: ParallelismGroup,
  repoConfig: { projectName: string; buildCmds: Record<string, string>; testCmds: Record<string, string> },
): WorkPlan {
  const fileChains = new Map<string, ConsumedTicket[]>();
  for (const ticket of group.tickets) {
    const file = ticket.metadata?.primaryFile ?? "__unknown__";
    const chain = fileChains.get(file) ?? [];
    chain.push(ticket);
    fileChains.set(file, chain);
  }

  const units: WorkUnit[] = [];
  for (const [_file, chain] of fileChains) {
    let prevId: string | null = null;
    for (const ticket of chain) {
      const unitId = sanitizeUnitId(ticket.issue.identifier);
      units.push({
        id: unitId,
        name: `${ticket.issue.identifier}: ${ticket.issue.title}`,
        rfcSections: [],
        description: ticket.rfcContent,
        deps: prevId ? [prevId] : [],
        acceptance: [
          "Implement the changes described in the issue",
          "All existing tests pass",
          "Add tests for new behavior where appropriate",
        ],
        tier: "small",
      });
      prevId = unitId;
    }
  }

  return {
    source: "linear-batch",
    generatedAt: new Date().toISOString(),
    repo: repoConfig,
    units,
  };
}

function sanitizeUnitId(identifier: string): string {
  return identifier.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}
```

**Tests**: Pure functions — easy to unit test with mock tickets. Test union-find correctness, transitive conflicts, single-ticket groups, empty input.

### Step 4: PR Creation Component

**Create** `src/workflows/ralphinho/components/PushAndCreatePR.tsx`

Replaces `AgenticMergeQueue` when in PR mode. Same pattern: a `<Task>` with a prompt for an agent.

```tsx
export const prCreationResultSchema = z.object({
  ticketsPushed: z.array(z.object({
    ticketId: z.string(),
    branch: z.string(),
    prUrl: z.string().nullable(),
    prNumber: z.number().nullable(),
    summary: z.string(),
  })),
  ticketsFailed: z.array(z.object({
    ticketId: z.string(),
    reason: z.string(),
  })),
  summary: z.string(),
});
```

The prompt instructs the agent to:
1. `jj git push --bookmark {branch}` for each completed ticket
2. `gh pr create --base {baseBranch} --head {branch} --title "..." --body "..."`
3. Handle existing PRs (skip creation, note URL)
4. Handle push failures (record and continue)

### Step 5: Wire into ScheduledWorkflow

**Modify** `src/workflows/ralphinho/components/ScheduledWorkflow.tsx`

Add a `landingMode` prop:

```typescript
export type ScheduledWorkflowProps = {
  // ... existing props ...
  landingMode?: "merge" | "pr";  // default: "merge" (backward compatible)
};
```

In the render, conditionally use `PushAndCreatePR` or `AgenticMergeQueue`:

```tsx
{landingMode === "pr" ? (
  <PushAndCreatePR
    nodeId={MERGE_QUEUE_NODE_ID}  // reuse same node ID for state tracking
    tickets={prTickets}
    agent={agents.mergeQueue}
    fallbackAgent={fallbacks?.mergeQueue}
    output={outputs.merge_queue}  // or new pr_creation output
    repoRoot={repoRoot}
    baseBranch={baseBranch}
  />
) : (
  <AgenticMergeQueue ... />  // existing behavior
)}
```

**Modify** `src/workflows/ralphinho/schemas.ts`

Add `pr_creation` output schema (or reuse `merge_queue` slot with a union type).

### Step 6: CLI Wiring

**Modify** `src/cli/run.ts`

Add `--batch` flag handling:

```typescript
const batchMode = flags.batch === true;

if (linearEnabled && batchMode && !existsSync(configPath)) {
  return runBatchFromLinear({ repoRoot, ralphDir, linearOpts, force, flags });
}
```

The `runBatchFromLinear()` function:
1. Calls `consumeAllTickets()`
2. Calls `groupByFileOverlap()`
3. Logs the grouping plan
4. Marks all tickets in-progress on Linear
5. For each group: calls `groupToWorkPlan()`, writes plan to disk, launches Smithers
6. On completion: marks tickets done on Linear

**Modify** `src/config/types.ts`

Add optional `landingMode` to scheduled-work config:

```typescript
export const scheduledWorkConfigSchema = baseConfigSchema.extend({
  mode: z.literal("scheduled-work"),
  rfcPath: z.string(),
  baseBranch: z.string().default("main"),
  landingMode: z.enum(["merge", "pr"]).default("merge"),
});
```

## Files Summary

| File | Action | Description |
|------|--------|-------------|
| `src/adapters/linear/parse-issue-metadata.ts` | **Create** | Regex parser for improvinho issue format |
| `src/adapters/linear/consume-tickets.ts` | **Modify** | Add `consumeAllTickets()`, export `issueToRfc` |
| `src/adapters/linear/types.ts` | **Modify** | Add optional `metadata` to `ConsumedTicket` |
| `src/workflows/ralphinho/scheduler.ts` | **Create** | `groupByFileOverlap()` + `groupToWorkPlan()` |
| `src/workflows/ralphinho/components/PushAndCreatePR.tsx` | **Create** | Push branch + create PR component |
| `src/workflows/ralphinho/components/ScheduledWorkflow.tsx` | **Modify** | Add `landingMode` prop, conditional rendering |
| `src/workflows/ralphinho/schemas.ts` | **Modify** | Add `pr_creation` output schema |
| `src/cli/run.ts` | **Modify** | Add `--batch` flag, `runBatchFromLinear()` |
| `src/config/types.ts` | **Modify** | Add `landingMode` to config schema |

## What Stays Untouched

- `QualityPipeline.tsx` — reused as-is
- `AgenticMergeQueue.tsx` — still available for `landingMode: "merge"`
- `decompose.ts` — not used in batch path (tickets are already decomposed)
- `runtimeNames.ts` — reused for branch naming
- `workflow/state.ts`, `decisions.ts`, `snapshot.ts` — all reused
- All Smithers primitives (`<Worktree>`, `<Ralph>`, `<Parallel>`, `<Sequence>`)
- The entire improvinho workflow

## Edge Cases

1. **No file metadata** (manually created Linear issues): Go to `unparseable` bucket, logged and skipped. Could fall back to single-ticket RFC decomposition path.

2. **Transitive conflicts**: Handled correctly by union-find (see architecture section above).

3. **Ticket touches multiple files**: Currently `primaryFile` is always a single file. If we need multi-file awareness later, extend grouping to also use `lineRefs` file paths. For v1, `primaryFile` is sufficient since improvinho findings are file-scoped.

4. **Empty batch**: Early return with message, no Smithers runs launched.

5. **Partial failures**: If one group's Smithers run fails, other groups still complete. Failed tickets stay "In Progress" on Linear (not marked done).

6. **PR conflicts at merge time**: Since groups are file-independent, PRs from different groups won't conflict. PRs within the same group are sequential, so they also won't conflict. The only risk is if `primaryFile` doesn't capture all files a ticket modifies — but for improvinho findings (single-file refactors), this is reliable.

## Future Enhancements (Not in Scope)

- **Parallel group execution**: Run multiple Smithers processes simultaneously (currently sequential)
- **Multi-file awareness**: Parse `lineRefs` to detect tickets that touch multiple files
- **Auto-merge**: Add `gh pr merge --auto` after PR creation for approved tickets
- **PR stacking with jj**: For same-file sequential tickets, create stacked PRs where each PR's base is the previous PR's branch
- **Feedback loop**: If a PR gets review comments on GitHub, feed them back into the quality pipeline
