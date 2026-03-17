# Research: Linear Adapter Layer

## Unit Summary

Create `parseIssueMetadata()` for extracting structured fields from improvinho-formatted issue descriptions, add `consumeAllTickets()` for batch fetching, and extend `ConsumedTicket` with optional metadata.

## Specification References

- **RFC**: `docs/plans/batch-linear-pipeline.md` §Step 1 (Issue Metadata Parser) and §Step 2 (Batch Linear Fetch)

## Files to Create

### `src/adapters/linear/parse-issue-metadata.ts`

New file containing:
- `IssueMetadata` type: `{ kind, priority, confidence, primaryFile, lineRefs, symbol }` — all nullable strings except `lineRefs: string[]`
- `parseIssueMetadata(description: string | null): IssueMetadata` — regex-based parser

### `src/adapters/linear/parse-issue-metadata.test.ts`

Unit tests covering: full improvinho format, null description, missing individual fields, backtick variations, multi-value Lines field.

## Files to Modify

### `src/adapters/linear/consume-tickets.ts`

- **Export `issueToRfc`**: Currently private (line 13: `function issueToRfc`). Change to `export function issueToRfc`.
- **Add `consumeAllTickets()`**: New async function that:
  1. Fetches unstarted + started issues in parallel via `Promise.all`
  2. Deduplicates by ID
  3. Sorts by priority (ascending = highest priority first)
  4. Parses metadata via `parseIssueMetadata()`
  5. Splits into `tickets` (has primaryFile) and `unparseable` (no primaryFile)
  6. Returns `ConsumedBatch { tickets, unparseable }`
- **Add `ConsumedBatch` type** (can be defined in types.ts or locally)
- **Import `parseIssueMetadata`** from `./parse-issue-metadata`

### `src/adapters/linear/types.ts`

- Add `metadata?: IssueMetadata` field to `ConsumedTicket` type (line 16-20)
- Import `IssueMetadata` from `./parse-issue-metadata`

### `src/adapters/linear/index.ts`

- Export new symbols: `consumeAllTickets`, `parseIssueMetadata`, `IssueMetadata`, `ConsumedBatch`

## Key Implementation Details

### Improvinho Description Format (from `push-findings.ts:29-75`)

The `findingToDescription()` function in push-findings.ts produces this exact format:

```
**Kind:** ${finding.kind}
**Priority:** ${finding.priority}
**Confidence:** ${finding.confidence}
**File:** `${finding.primaryFile}`
**Lines:** `ref1`, `ref2`
**Symbol:** `${finding.symbol}`
```

Key observations:
- `Kind`, `Priority`, `Confidence` values are NOT backtick-wrapped
- `File` value IS backtick-wrapped
- `Lines` has each ref individually backtick-wrapped, comma-separated
- `Symbol` IS backtick-wrapped
- `Lines` and `Symbol` are optional (conditional on `lineRefs.length > 0` and `finding.symbol` being truthy)

### Regex Pattern

The RFC suggests: `\\*\\*${key}:\\*\\*\\s*\`?([^\`\\n]+)\`?`

This pattern:
1. Matches `**Key:**` bold markdown
2. Allows optional leading backtick
3. Captures content until backtick or newline
4. Allows optional trailing backtick

For Lines field: split captured value on `,`, trim each, strip backticks.

### `useLinear().listIssues()` API

From `smithers-orchestrator/linear/useLinear.ts`:
- Accepts `ListIssuesParams { teamId?, assigneeId?, stateType?, limit?, labels? }`
- Returns `Promise<LinearIssue[]>`
- `stateType` maps to Linear state filter (e.g., "unstarted", "started")

### `LinearIssue` Type

From `smithers-orchestrator/linear/types.ts`:
```typescript
type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;        // 1=urgent, 2=high, 3=medium, 4=low
  priorityLabel: string;
  state: { id: string; name: string; type: string } | null;
  assignee: { id: string; name: string; email: string } | null;
  labels: { id: string; name: string }[];
  project: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
  url: string;
};
```

### Current `ConsumedTicket` Type

```typescript
export type ConsumedTicket = {
  issue: import("smithers-orchestrator/linear").LinearIssue;
  rfcContent: string;
};
```

Will become:
```typescript
export type ConsumedTicket = {
  issue: import("smithers-orchestrator/linear").LinearIssue;
  rfcContent: string;
  metadata?: import("./parse-issue-metadata").IssueMetadata;
};
```

### Existing Test Patterns

- Tests use `bun:test` (`describe`, `expect`, `test`)
- Test files are colocated: `*.test.ts` alongside source
- `buildIssue()` helper creates mock `LinearIssue` objects
- `consume-tickets.test.ts` re-implements private `issueToRfc` to test contract (lines 142-172) — once exported, tests can import directly
- Pure function tests preferred over mocked integration tests

### Priority Sort

Priority is numeric: 1=urgent, 2=high, 3=medium, 4=low. Sort ascending: `(a, b) => a.priority - b.priority`.

## Existing Barrel Export (`index.ts`)

```typescript
export { pushFindingsToLinear } from "./push-findings";
export { consumeTicket, markTicketInProgress, markTicketDone } from "./consume-tickets";
export type { PushFindingsResult, ConsumedTicket } from "./types";
```

Must add: `consumeAllTickets`, `issueToRfc`, `parseIssueMetadata`, `IssueMetadata`, `ConsumedBatch`.

## Edge Cases for Tests

1. **Full improvinho format**: All fields present with backticks where expected
2. **Null description**: Returns all-null metadata with empty lineRefs
3. **Missing individual fields**: e.g., no Symbol line, no Lines line
4. **Backtick variations**: File field with/without backticks, Symbol with/without
5. **Multi-value Lines field**: `\`file.ts:10\`, \`file.ts:20\`, \`file.ts:30\``
6. **Extra whitespace**: Spaces after colon, around values
