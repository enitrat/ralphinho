# Plan: event-bridge-deduplication

## Overview

Eliminate two independent sources of duplication in `event-bridge.ts`:

1. **Row type schemas + manual mappers** (lines 49-83, 332-410): Replace 4 local Zod schemas and 4 inline mapper functions with `fromSqliteRow` factory functions in `workflow/state.ts`.
2. **Manual typeof guards for merge_queue JSON** (lines 270-326): Replace ~50 lines of per-field typeof checks with `.safeParse()` calls on existing Zod schemas from `schemas.ts`. Delete `parseObjectArray` helper.

## TDD Applicability

**TDD does not apply.** This is a mechanical refactoring:

- No new features, APIs, or code paths are introduced
- Output shapes are preserved exactly (same types flow into `buildOutputSnapshot` and event emission)
- The compiler enforces type correctness at every boundary (`FinalReviewRow`, `ImplementRow`, `TestRow`, `ReviewFixRow`, `MergeQueueRow`)
- Existing tests for `queryRows` remain valid and unchanged
- Verification: `bun run typecheck` + manual inspection of output shape preservation

## Step-by-Step Changes

### Step 1: Add `fromSqliteRow` factories to `workflow/state.ts`

Add 4 factory functions after the existing type definitions (after line 55). Each factory:
- Takes `row: Record<string, unknown>`
- Validates with an internal Zod schema (snake_case, `z.number()` for booleans)
- Maps snake_case to camelCase, coerces `Boolean()` for integers
- Returns `T | null` (null on validation failure)

```typescript
import { z } from "zod";

// Internal raw row schemas (SQLite: snake_case, INTEGER for booleans)
const finalReviewRawSchema = z.object({
  node_id: z.string(),
  iteration: z.number(),
  ready_to_move_on: z.number(),
  approved: z.number(),
  reasoning: z.string(),
  quality_score: z.number().nullable(),
});

export function finalReviewRowFromSqlite(row: Record<string, unknown>): FinalReviewRow | null {
  const r = finalReviewRawSchema.safeParse(row);
  if (!r.success) return null;
  return {
    nodeId: r.data.node_id,
    iteration: r.data.iteration,
    readyToMoveOn: Boolean(r.data.ready_to_move_on),
    approved: Boolean(r.data.approved),
    reasoning: r.data.reasoning ?? "",
    qualityScore: r.data.quality_score,
  };
}

// Similarly for implementRowFromSqlite, testRowFromSqlite, reviewFixRowFromSqlite
```

**Design decisions:**
- `parseNodeId` filtering stays in event-bridge (it's event-bridge-specific logic, not row mapping)
- `parseStringArray` is used inside `implementRowFromSqlite` for `filesCreated`/`filesModified` — move `parseStringArray` to state.ts or pass it as a dependency. Since it's a pure utility, move it to state.ts.
- Factories return `T | null` to match the existing mapper signature used by `queryRows`

### Step 2: Update `event-bridge.ts` — replace row schemas and mappers

1. **Delete** local Zod schemas: `finalReviewRawRowSchema`, `implementRawRowSchema`, `testRawRowSchema`, `reviewFixRawRowSchema` (lines 49-83)
2. **Import** new factories from `workflow/state.ts`:
   ```typescript
   import { finalReviewRowFromSqlite, implementRowFromSqlite, testRowFromSqlite, reviewFixRowFromSqlite } from "../workflows/ralphinho/workflow/state";
   ```
3. **Replace** inline mapper functions (lines 332-410) with factory calls:
   ```typescript
   const allFinalReviewRows: FinalReviewRow[] = queryRows(
     db,
     "SELECT node_id, iteration, ready_to_move_on, approved, reasoning, quality_score FROM final_review WHERE run_id = ? ORDER BY iteration ASC",
     [runId],
     (row) => {
       const mapped = finalReviewRowFromSqlite(row as Record<string, unknown>);
       if (!mapped || !parseNodeId(mapped.nodeId)) return null;
       return mapped;
     },
   );
   ```
4. **Move** `parseStringArray` from event-bridge.ts to state.ts (it's needed by `implementRowFromSqlite` for JSON array columns). Keep the import in event-bridge.ts since it's also used for work-plan and completion_report parsing.

### Step 3: Replace merge_queue typeof guards with Zod schemas

1. **Import** `scheduledOutputSchemas` from `schemas.ts`:
   ```typescript
   import { scheduledOutputSchemas } from "../workflows/ralphinho/schemas";
   ```
2. **Extract** inner array schemas:
   ```typescript
   const ticketsLandedSchema = scheduledOutputSchemas.merge_queue.shape.ticketsLanded;
   const ticketsEvictedSchema = scheduledOutputSchemas.merge_queue.shape.ticketsEvicted;
   const ticketsSkippedSchema = scheduledOutputSchemas.merge_queue.shape.ticketsSkipped;
   ```
3. **Replace** the merge_queue inner loop (lines 270-326) — replace `parseObjectArray` + typeof guards with:
   ```typescript
   for (const row of rows) {
     const landedParsed = ticketsLandedSchema.safeParse(safeJsonParse(row.tickets_landed));
     const landed = landedParsed.success ? landedParsed.data : [];
     const evictedParsed = ticketsEvictedSchema.safeParse(safeJsonParse(row.tickets_evicted));
     const evicted = evictedParsed.success ? evictedParsed.data : [];
     const skippedParsed = ticketsSkippedSchema.safeParse(safeJsonParse(row.tickets_skipped));
     const skipped = skippedParsed.success ? skippedParsed.data : [];

     mergeQueueRows.push({
       nodeId: "merge-queue",
       ticketsLanded: landed.map((item) => ({
         ...item,
         summary: item.summary || row.summary ?? "",
       })),
       ticketsEvicted: evicted,
     });

     for (const item of landed) {
       events.push({ type: "merge-queue-landed", timestamp: now + row.iteration, runId, ticketId: item.ticketId, mergeCommit: item.mergeCommit, summary: item.summary || row.summary ?? "" });
     }
     for (const item of evicted) {
       events.push({ type: "merge-queue-evicted", timestamp: now + row.iteration, runId, ticketId: item.ticketId, reason: item.reason, details: item.details });
     }
     for (const item of skipped) {
       events.push({ type: "merge-queue-skipped", timestamp: now + row.iteration, runId, ticketId: item.ticketId, reason: item.reason });
     }
   }
   ```
4. **Add** a tiny `safeJsonParse` helper (replaces `parseObjectArray`):
   ```typescript
   function safeJsonParse(raw: unknown): unknown {
     if (typeof raw !== "string") return undefined;
     try { return JSON.parse(raw); } catch { return undefined; }
   }
   ```
5. **Delete** `parseObjectArray` function (lines 97-107)
6. **Keep** `parseStringArray` — it's still used for completion_report and work-plan

### Step 4: Verify

1. `bun run typecheck` — no errors
2. Confirm no local Zod schemas for raw rows remain in event-bridge.ts
3. Confirm no `typeof` guards for merge_queue inner JSON fields remain
4. Confirm `parseObjectArray` is deleted
5. Confirm `buildOutputSnapshot` and `getDecisionAudit` callers receive the same shaped data

## Files to Modify

| File | Changes |
|------|---------|
| `src/workflows/ralphinho/workflow/state.ts` | Add 4 `fromSqliteRow` factories, add `parseStringArray` utility |
| `src/runtime/event-bridge.ts` | Delete 4 raw row schemas, delete 4 inline mappers, delete `parseObjectArray`, import factories + schemas, replace merge_queue typeof guards |

## Files to Create

None.

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| **Zod strictness change**: Current merge_queue typeof guards are lenient (fall back on missing fields). Zod `.safeParse()` rejects the entire array if any item is invalid. | The schemas from `schemas.ts` match what Smithers writes — if data passes Smithers validation on write, it will pass safeParse on read. For corrupt/partial data, the current fallback to `[]` is preserved. |
| **Summary fallback**: Current code falls back `item.summary` to `row.summary ?? ""`. Zod schema requires `summary: z.string()` which means partial items get rejected. | Keep the summary fallback by mapping after safeParse: `item.summary \|\| row.summary ?? ""` |
| **parseStringArray moved**: Moving to state.ts could break imports if not re-exported. | Export from state.ts, update import in event-bridge.ts |
| **INTEGER boolean coercion**: SQLite returns 0/1 as numbers. Factories must use `Boolean()` coercion. | Zod schemas use `z.number()` for boolean columns, factories apply `Boolean()` |

## Acceptance Criteria Verification

1. **No local Zod schemas for row types** — Verified by deleting lines 49-83 and confirming typecheck passes
2. **Uses fromSqliteRow factories** — Verified by searching for `fromSqliteRow` imports in event-bridge.ts
3. **No typeof guards for merge_queue fields** — Verified by searching for `typeof item.ticketId`, `typeof item.mergeCommit`, etc.
4. **Merge_queue uses Zod schemas from schemas.ts** — Verified by searching for `scheduledOutputSchemas` import
5. **parseObjectArray removed** — Verified by searching for `parseObjectArray` in codebase
6. **Typecheck passes** — `bun run typecheck`
7. **Same output shape** — Types enforce this: `FinalReviewRow[]`, `ImplementRow[]`, etc. feed into `buildOutputSnapshot` which hasn't changed
