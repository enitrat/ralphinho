# Plan: Deduplicate event-bridge.ts vs snapshot.ts OutputSnapshot Construction

## Overview

Extract a shared `buildOutputSnapshot()` function that both `event-bridge.ts` (DB polling path) and `snapshot.ts` (SmithersCtx path) call to construct an `OutputSnapshot` from pre-typed row data. Then clean up `snapshot.ts` by removing the `SnapshotCapableCtx` type alias and scattered `as` casts.

## Work Type Assessment

**This is a mechanical refactoring** — no observable behavior changes:
- Extract-function refactoring (same logic, single location)
- Type cast cleanup (same runtime behavior, better static types)
- No new features, no API changes, no bug fixes

**TDD does not apply.** The compiler (`bun run typecheck`) enforces correctness. Both callers produce identical `OutputSnapshot` values before and after. No new code paths are introduced.

## Files

| Action | File | Purpose |
|--------|------|---------|
| Modify | `src/workflows/ralphinho/workflow/state.ts` | Add `buildOutputSnapshot()` + `SnapshotInput` type |
| Modify | `src/workflows/ralphinho/workflow/snapshot.ts` | Remove `SnapshotCapableCtx`, use shared builder, eliminate casts |
| Modify | `src/runtime/event-bridge.ts` | Replace inline snapshot construction with shared builder call |

No new files needed — `state.ts` already owns `OutputSnapshot` and all row types, and already contains builder functions (`buildMergeTickets`, `buildDepSummaries`).

## Step-by-Step

### Step 1: Add `buildOutputSnapshot()` to state.ts

Add at the bottom of `state.ts`:

```typescript
import { stageNodeId, type StageName } from "./contracts";

export type SnapshotInput = {
  mergeQueueRows: MergeQueueRow[];
  testRows: TestRow[];
  finalReviewRows: FinalReviewRow[];
  implementRows: ImplementRow[];
  reviewFixRows: ReviewFixRow[];
};

export function buildOutputSnapshot(input: SnapshotInput): OutputSnapshot {
  // Group rows by unitId extracted from nodeId
  const testByUnit = groupByUnit(input.testRows);
  const finalReviewByUnit = groupByUnit(input.finalReviewRows);
  const implementByUnit = groupByUnit(input.implementRows);
  const reviewFixByUnit = groupByUnit(input.reviewFixRows);

  return {
    mergeQueueRows: input.mergeQueueRows,
    latestTest: (id) => latestRow(testByUnit.get(id) ?? []),
    latestFinalReview: (id) => latestRow(finalReviewByUnit.get(id) ?? []),
    latestImplement: (id) => latestRow(implementByUnit.get(id) ?? []),
    freshTest: (id, iteration) =>
      (testByUnit.get(id) ?? []).find((row) => row.iteration === iteration) ?? null,
    testHistory: (id) => testByUnit.get(id) ?? [],
    finalReviewHistory: (id) => finalReviewByUnit.get(id) ?? [],
    implementHistory: (id) => implementByUnit.get(id) ?? [],
    reviewFixHistory: (id) => reviewFixByUnit.get(id) ?? [],
    isUnitLanded: (id) =>
      input.mergeQueueRows.some(
        (row) => row.nodeId === MERGE_QUEUE_NODE_ID
          && row.ticketsLanded.some((ticket) => ticket.ticketId === id),
      ),
  };
}
```

Helper functions (private to module):

```typescript
function groupByUnit<T extends { nodeId?: string }>(rows: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    if (!row.nodeId) continue;
    const unitId = extractUnitId(row.nodeId);
    if (!unitId) continue;
    const current = map.get(unitId) ?? [];
    current.push(row);
    map.set(unitId, current);
  }
  return map;
}

function extractUnitId(nodeId: string): string | null {
  const lastColon = nodeId.lastIndexOf(":");
  if (lastColon <= 0) return null;
  return nodeId.slice(0, lastColon);
}

function latestRow<T>(rows: T[]): T | null {
  return rows.at(-1) ?? null;
}
```

**Note**: `extractUnitId` is the inverse of `stageNodeId(unitId, stage)` which produces `${unitId}:${stage}`. We take everything before the last `:` as the unitId.

### Step 2: Refactor event-bridge.ts to use shared builder

Replace lines 243-383 (the Map building + inline snapshot construction) with:

1. Keep the SQL queries and row normalization (L248-362) — these convert raw SQL to typed rows
2. Collect all rows into flat arrays with `nodeId` populated (already done)
3. Replace the inline `OutputSnapshot` construction (L370-383) with:

```typescript
import { buildOutputSnapshot } from "../workflows/ralphinho/workflow/state";

// ... after SQL row normalization produces flat typed arrays ...
const allTestRows = Array.from(testByUnit.values()).flat();
const allFinalReviewRows = Array.from(finalReviewByUnit.values()).flat();
const allImplementRows = Array.from(implementByUnit.values()).flat();
const allReviewFixRows = Array.from(reviewFixByUnit.values()).flat();

const snapshot = buildOutputSnapshot({
  mergeQueueRows,
  testRows: allTestRows,
  finalReviewRows: allFinalReviewRows,
  implementRows: allImplementRows,
  reviewFixRows: allReviewFixRows,
});
```

**Alternative (cleaner)**: Refactor the SQL parsing to produce flat arrays directly instead of Maps, then pass them straight through. The Maps were only needed for the inline snapshot accessors — `buildOutputSnapshot` handles grouping internally. This removes the `finalReviewByUnit`, `implementByUnit`, `testByUnit`, `reviewFixByUnit` Maps entirely, simplifying ~120 lines to ~80 lines.

For the `unitIds` set (L364-368 used for decision audit events), derive it from the flat arrays:

```typescript
const unitIds = new Set<string>();
for (const row of [...allTestRows, ...allFinalReviewRows, ...allImplementRows, ...allReviewFixRows]) {
  if (row.nodeId) {
    const uid = extractUnitId(row.nodeId);
    if (uid) unitIds.add(uid);
  }
}
```

Or export `extractUnitId` from state.ts.

### Step 3: Refactor snapshot.ts to use shared builder + remove type erasure

Replace the entire `buildSnapshot` function body:

```typescript
import { buildOutputSnapshot, type SnapshotInput } from "./state";

// Helper: add runtime nodeId/iteration to Smithers ctx.outputs() results
type WithRuntimeFields<T> = T & { nodeId: string; iteration: number };

export function buildSnapshot(ctx: SmithersCtx<ScheduledOutputs>): OutputSnapshot {
  // Single boundary cast — Smithers adds nodeId/iteration at runtime
  // but they're not in the Zod schemas
  const testRows = ctx.outputs("test") as WithRuntimeFields<typeof ctx.outputs<"test">[number]>[] as TestRow[];
  const finalReviewRows = ctx.outputs("final_review") as unknown as FinalReviewRow[];
  const implementRows = ctx.outputs("implement") as unknown as ImplementRow[];
  const reviewFixRows = ctx.outputs("review_fix") as unknown as ReviewFixRow[];

  const rawMergeQueue = ctx.outputs("merge_queue");
  const mergeQueueRows = Array.isArray(rawMergeQueue)
    ? rawMergeQueue.map(normalizeMergeQueueRow)
    : [];

  return buildOutputSnapshot({
    mergeQueueRows,
    testRows,
    finalReviewRows,
    implementRows,
    reviewFixRows,
  });
}
```

**Removals:**
- Delete `SnapshotCapableCtx` type alias (L13-16)
- Delete `rowsForNode()` helper (L38-47) — grouping now in shared builder
- Delete the `ctx as SnapshotCapableCtx` cast (L50)
- Delete all per-accessor `as TestRow | null` etc. casts (L61-70)

**Retained:**
- `normalizeMergeQueueRow()` — still needed for merge_queue rows (different schema shape)
- A single boundary cast per table where `ctx.outputs()` results gain the row type

**Cast reduction**: 10 scattered casts → 4 boundary casts at the `ctx.outputs()` call site (one per table). The `as unknown as RowType` pattern is a narrowing cast (safe — row types are subsets of Zod schemas + runtime fields).

### Step 4: Verify

1. `bun run typecheck` — zero errors
2. `bun run build` (if applicable) — passes
3. Manual review: confirm `OutputSnapshot` construction logic exists only in `state.ts`

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| `extractUnitId` doesn't handle edge-case nodeId formats | Unit test the function — format is always `{unitId}:{stageName}` per `stageNodeId()`. Only risk: unitId contains `:` — but `lastIndexOf(":")` handles this correctly. |
| event-bridge.ts `parseNodeId` validates stage names; `extractUnitId` doesn't | `extractUnitId` is only used for grouping (not stage validation). Invalid stages won't match any accessor calls. Low risk. |
| Merge queue normalization differs between paths | Both paths still use their own `normalizeMergeQueueRow`. The shared builder accepts already-normalized `MergeQueueRow[]`. No dedup of merge queue normalization in this PR. |
| `latestRow` function exists in both event-bridge.ts (L52-54) and will exist in state.ts | Remove the local `latestRow` from event-bridge.ts after migration since it's no longer used there. |

## Acceptance Criteria Verification

| # | Criterion | How Verified |
|---|-----------|-------------|
| 1 | OutputSnapshot construction in exactly one place | `buildOutputSnapshot()` in state.ts is the sole constructor |
| 2 | event-bridge.ts calls shared function | Code review — `buildOutputSnapshot()` import and call |
| 3 | snapshot.ts calls shared function | Code review — `buildOutputSnapshot()` import and call |
| 4 | SnapshotCapableCtx removed | `grep "SnapshotCapableCtx" src/` returns nothing |
| 5 | No per-accessor `as TestRow | null` casts | `grep "as TestRow \| null" src/` returns nothing |
| 6 | Typecheck passes | `bun run typecheck` exits 0 |
