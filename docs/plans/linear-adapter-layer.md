# Plan: Linear Adapter Layer — Metadata Parser + Batch Fetch

## Overview

Add structured metadata parsing for improvinho-formatted Linear issue descriptions, a batch fetch function that retrieves all actionable tickets in parallel, and expose `issueToRfc` as a public export. This is **new feature work** that adds observable behavior (new functions, new types, new public API surface).

## TDD Applies

**Yes.** This unit adds:
- A new pure function (`parseIssueMetadata`) with well-defined inputs/outputs
- A new async function (`consumeAllTickets`) with batch/dedup/sort logic
- New public exports and type extensions

All of these change observable behavior and benefit from tests-first.

## Step-by-Step Plan

### Step 1: Create `IssueMetadata` type and `parseIssueMetadata` tests

**File:** `src/adapters/linear/parse-issue-metadata.test.ts` (CREATE)

Write tests covering all acceptance criteria for the parser:

1. **Full improvinho format** — all six fields present, backtick-wrapped where expected
2. **Null description** — returns `{ kind: null, priority: null, confidence: null, primaryFile: null, lineRefs: [], symbol: null }`
3. **Missing individual fields** — e.g. no Symbol line → `symbol: null`, no Lines line → `lineRefs: []`
4. **Backtick variations** — `**File:** \`src/foo.ts\`` vs `**File:** src/foo.ts` (both should work)
5. **Multi-value Lines** — `` **Lines:** `file.ts:10`, `file.ts:20`, `file.ts:30` `` → `["file.ts:10", "file.ts:20", "file.ts:30"]`
6. **Extra whitespace** — spaces after colon, around values

Test imports:
```typescript
import { parseIssueMetadata } from "./parse-issue-metadata";
import type { IssueMetadata } from "./parse-issue-metadata";
```

### Step 2: Implement `parseIssueMetadata`

**File:** `src/adapters/linear/parse-issue-metadata.ts` (CREATE)

```typescript
export type IssueMetadata = {
  kind: string | null;
  priority: string | null;
  confidence: string | null;
  primaryFile: string | null;
  lineRefs: string[];
  symbol: string | null;
};

export function parseIssueMetadata(description: string | null): IssueMetadata {
  // Return all-null for null/empty description
  // For each field, use regex: /\*\*Kind:\*\*\s*`?([^`\n]+)`?/
  // For Lines: capture full value, split on comma, trim each, strip backticks
  // Strip backticks from primaryFile and symbol captures
}
```

Regex pattern per field: `\*\*${Key}:\*\*\s*\`?([^\`\n]+)\`?`

Special handling:
- **Lines**: After capturing the full value, split on `,`, trim each entry, strip surrounding backticks
- **primaryFile/symbol**: Strip leading/trailing backticks from captured value
- **kind/priority/confidence**: Plain text, no backtick stripping needed

Run tests: `bun test src/adapters/linear/parse-issue-metadata.test.ts`

### Step 3: Add `metadata` field to `ConsumedTicket` type

**File:** `src/adapters/linear/types.ts` (MODIFY)

```typescript
import type { IssueMetadata } from "./parse-issue-metadata";

export type ConsumedTicket = {
  issue: import("smithers-orchestrator/linear").LinearIssue;
  rfcContent: string;
  metadata?: IssueMetadata;
};
```

### Step 4: Export `issueToRfc` from `consume-tickets.ts`

**File:** `src/adapters/linear/consume-tickets.ts` (MODIFY)

Change line 13 from:
```typescript
function issueToRfc(issue: LinearIssue): string {
```
to:
```typescript
export function issueToRfc(issue: LinearIssue): string {
```

### Step 5: Write `consumeAllTickets` tests

**File:** `src/adapters/linear/consume-tickets.test.ts` (MODIFY)

Add a new `describe("consumeAllTickets", ...)` block with tests:

1. **Fetches unstarted + started in parallel, deduplicates by ID** — provide overlapping sets, verify unique results
2. **Sorts by priority ascending** — verify order in returned tickets
3. **Splits into tickets (has primaryFile) and unparseable (no primaryFile)** — issues with/without improvinho metadata
4. **Returns ConsumedBatch shape** — `{ tickets: ConsumedTicket[], unparseable: ConsumedTicket[] }`

These tests will need the mock helper to be extended to support `consumeAllTickets`.

### Step 6: Implement `consumeAllTickets`

**File:** `src/adapters/linear/consume-tickets.ts` (MODIFY)

```typescript
import { parseIssueMetadata } from "./parse-issue-metadata";
import type { IssueMetadata } from "./parse-issue-metadata";

export type ConsumedBatch = {
  tickets: ConsumedTicket[];
  unparseable: ConsumedTicket[];
};

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
```

Run tests: `bun test src/adapters/linear/consume-tickets.test.ts`

### Step 7: Update barrel exports

**File:** `src/adapters/linear/index.ts` (MODIFY)

```typescript
export { pushFindingsToLinear } from "./push-findings";
export { consumeTicket, consumeAllTickets, issueToRfc, markTicketInProgress, markTicketDone } from "./consume-tickets";
export type { ConsumedBatch } from "./consume-tickets";
export { parseIssueMetadata } from "./parse-issue-metadata";
export type { IssueMetadata } from "./parse-issue-metadata";
export type { PushFindingsResult, ConsumedTicket } from "./types";
```

### Step 8: Typecheck and full test run

```bash
bun run typecheck
bun test src/adapters/linear/
```

## Files

### Create
- `src/adapters/linear/parse-issue-metadata.ts`
- `src/adapters/linear/parse-issue-metadata.test.ts`

### Modify
- `src/adapters/linear/types.ts` — add optional `metadata?: IssueMetadata`
- `src/adapters/linear/consume-tickets.ts` — export `issueToRfc`, add `consumeAllTickets`, add `ConsumedBatch` type
- `src/adapters/linear/consume-tickets.test.ts` — add tests for `consumeAllTickets`
- `src/adapters/linear/index.ts` — add new exports

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Regex doesn't handle edge cases in descriptions | Comprehensive test suite with real format from `push-findings.ts` |
| `consume-tickets.test.ts` mock helper tightly coupled | Extend existing `mockConsumeTicket` or add a parallel `mockConsumeAllTickets` helper |
| `ConsumedBatch` type co-located in `consume-tickets.ts` vs `types.ts` | Keep in `consume-tickets.ts` since it's only used by that function; can move later |
| Existing `consume-tickets.test.ts` has duplicated `issueToRfc` | Once exported, tests can import directly — but keep existing tests passing as-is first |

## Acceptance Criteria Verification

| # | Criterion | Verified By |
|---|-----------|-------------|
| 1 | `parseIssueMetadata` extracts all six fields | Test: full improvinho format |
| 2 | Returns null for null/missing fields | Tests: null description, missing fields |
| 3 | Handles backtick-wrapped and plain primaryFile | Test: backtick variations |
| 4 | Splits comma-separated Lines, strips backticks | Test: multi-value Lines |
| 5 | `consumeAllTickets` parallel fetch + dedup | Test: overlapping issue sets |
| 6 | Issues without primaryFile → unparseable | Test: split logic |
| 7 | `issueToRfc` exported | Barrel export + typecheck |
| 8 | `ConsumedTicket.metadata` optional field | Type definition + typecheck |
| 9 | `bun run typecheck` passes | Step 8 |
