# Research: event-bridge-refactor

**Unit:** event-bridge-refactor
**Date:** 2026-03-17
**Ticket:** Refactor event-bridge.ts — queryRows helper, remove redundant coercions, add row validation

---

## Summary

This unit applies four improvements to `src/runtime/event-bridge.ts`:

1. **IMP-0001** — Extract `queryRows<T>` generic helper to de-duplicate 5 DB-poll try/catch blocks (lines 244–346) and 3 parseObjectArray blocks (lines 166–237).
2. **IMP-0002** — Replace unsafe `as Array<T>` casts on `.all()` results with Zod schemas or lightweight manual validators.
3. **IMP-0004** — Remove `String()` wrappers after `.filter()` already narrowed the value to `string` (lines 70–72, 184).
4. **IMP-0005** — Determine SQLite boolean return type and fix the cast+coercion redundancy at lines 260, 261, 290, 313, 314.

---

## Key Files

### Primary Target
- **`src/runtime/event-bridge.ts`** (424 lines) — The only file changed by this unit.

### Supporting Types (read-only context)
- **`src/workflows/ralphinho/workflow/state.ts`** — Defines `FinalReviewRow`, `ImplementRow`, `TestRow`, `ReviewFixRow`, `MergeQueueRow`, `OutputSnapshot`. These are the types being populated by the DB-poll blocks.

---

## Detailed Code Analysis

### IMP-0001: Extract `queryRows<T>` helper

**Pattern repeated 5 times** (lines 244–346, one per table: `final_review`, `implement`, `test`, `review_fix`, plus the `_smithers_nodes` block at lines 89–115):

```ts
try {
  const rows = db.query("SELECT ... FROM <table> WHERE run_id = ? ...").all(runId) as Array<RawType>;
  for (const row of rows) {
    if (!parseNodeId(row.node_id)) continue;
    allXRows.push({
      nodeId: row.node_id,
      // ... field mappings with Boolean() coercions
    });
  }
} catch {
  // table may not exist yet
}
```

**Pattern repeated 3 times** (lines 166–237, for `ticketsLanded` / `ticketsEvicted` / `ticketsSkipped`):
Each uses `parseObjectArray(row.tickets_X).filter(item => typeof item.ticketId === "string").map(item => ({ ticketId: String(item.ticketId), ... }))` then pushes to `mergeQueueRows` and also into `events`.

**Proposed helper (from RFC)**:
```ts
function queryRows<T>(db: Database, sql: string, runId: string, mapper: (row: any) => T | null): T[] {
  try {
    return db.query(sql).all(runId)
      .map(mapper)
      .filter((r): r is T => r !== null);
  } catch { return []; }
}
```

**Note:** The `_smithers_nodes` block (lines 89–115) uses a slightly different pattern (pushes multiple event types per row, not a single typed row object), so it may not cleanly fit `queryRows<T>` without modification. The 4 table blocks (final_review, implement, test, review_fix) at lines 244–346 are the clearest targets.

The `parseObjectArray` blocks (lines 166–237) are structurally different — they operate on JSON columns within a single SQL row rather than being separate SQL queries, so a different helper may be more appropriate there.

### IMP-0002: Replace `as Array<T>` with runtime validators

**All cast sites** (✓ VERIFIED by reading file):

| Line | Cast | Table |
|------|------|-------|
| 92 | `.all(runId) as Array<{ node_id: string; state: string; started_at_ms?: number; completed_at_ms?: number }>` | `_smithers_nodes` |
| 124 | `.all() as Array<{ job_type: string; agent_id: string; ticket_id: string \| null; created_at_ms: number }>` | `scheduled_tasks` |
| 146 | `.all(runId) as Array<{ node_id: string; started_at_ms: number \| null }>` | `_smithers_attempts` |
| 170 | `.all(runId) as Array<{ iteration: number; tickets_landed: string \| null; ... }>` | `merge_queue` |
| 247 | `.all(runId) as Array<{ node_id: string; iteration: number; ready_to_move_on: boolean; approved: boolean; ... }>` | `final_review` |
| 273 | `.all(runId) as Array<{ node_id: string; iteration: number; ... believes_complete: boolean; ... }>` | `implement` |
| 301 | `.all(runId) as Array<{ node_id: string; iteration: number; tests_passed: boolean; build_passed: boolean; ... }>` | `test` |
| 325 | `.all(runId) as Array<{ ... all_issues_resolved: boolean; build_passed: boolean; tests_passed: boolean; }>` | `review_fix` |

**bun:sqlite behavior**: `.all()` returns `unknown[]` — the casts are pure compile-time assertions with no runtime checking. If a column is renamed or type changes, data silently mismatches.

**Recommended fix**: Introduce lightweight Zod schemas (or `z.object()` validators) for each row shape. Since this is already a Zod-using project (evidenced by `events.ts` using Zod), using `z.array(schema).parse(rows)` at each call site would catch drift. Alternatively, a manual narrowing function that checks required fields.

### IMP-0004: Remove redundant `String()` coercions

**Site 1** — Lines 70–72:
```ts
.filter((unit) => typeof unit?.id === "string")
.map((unit) => ({
  id: String(unit.id),   // ← String() is redundant; filter proved unit.id is string
```
**Fix**: Change to `id: unit.id` (but note: TS may not carry the narrowing into `.map()` since `unit` is `Record<string, unknown>` — if TS errors, use `unit.id as string`).

**Site 2** — Line 184:
```ts
.filter((item) => typeof item.ticketId === "string")
.map((item) => ({
  ticketId: String(item.ticketId),   // ← redundant
```
**Fix**: Change to `ticketId: item.ticketId as string` (same TypeScript narrowing caveat applies).

**Important caveat from RFC**: "Dismiss if the array element type is `Record<string, unknown>` so TS doesn't carry the narrowing into `.map()`." The `units` array is `Array<Record<string, unknown>>` and `item` in the `parseObjectArray` result is `Record<string, unknown>`. TypeScript does NOT preserve narrowing across `.map()` on these types. The safe fix is `unit.id as string` not just `unit.id` — the `String()` call is semantically no-op but TypeScript will reject the plain access without the cast.

### IMP-0005: Boolean coercion vs SQLite integer columns

**Sites** (✓ VERIFIED by reading file):

| Line | Code | Table | Cast type |
|------|------|-------|-----------|
| 260 | `readyToMoveOn: Boolean(row.ready_to_move_on)` | `final_review` | `ready_to_move_on: boolean` at line 250 |
| 261 | `approved: Boolean(row.approved)` | `final_review` | `approved: boolean` at line 251 |
| 290 | `believesComplete: Boolean(row.believes_complete)` | `implement` | `believes_complete: boolean` at line 279 |
| 313 | `testsPassed: Boolean(row.tests_passed)` | `test` | `tests_passed: boolean` at line 304 |
| 314 | `buildPassed: Boolean(row.build_passed)` | `test` | `build_passed: boolean` at line 305 |

**SQLite boolean behavior**: SQLite has no native boolean type. It stores booleans as `INTEGER` (0 or 1). bun:sqlite returns these as JavaScript `number` (0 or 1), **not** as JS `boolean`. Therefore:

- The `as Array<{ ..., ready_to_move_on: boolean, ... }>` cast at line 247 **lies** — the actual runtime value is `0` or `1`.
- The `Boolean(row.ready_to_move_on)` calls are the **correct** coercions; they are needed.
- The fix is: change the cast type from `boolean` to `number` for these fields, keeping `Boolean()` as the single coercion source.

**Recommended fix per RFC**:
> "Either remove Boolean() wrappers (trust the cast) or remove the boolean type from the cast and keep Boolean() as the single source of truth. Don't do both."

Since SQLite returns integers, the right approach is: **keep `Boolean()`, fix the cast to use `number`** for those fields.

Also note: `review_fix` table (lines 322–346) has the same pattern for `all_issues_resolved`, `build_passed`, `tests_passed` (lines 326–331) — these should also be fixed to `number` in the cast.

---

## Database Schema (inferred from queries)

| Table | Key boolean columns |
|-------|---------------------|
| `final_review` | `ready_to_move_on`, `approved` |
| `implement` | `believes_complete` |
| `test` | `tests_passed`, `build_passed` |
| `review_fix` | `all_issues_resolved`, `build_passed`, `tests_passed` |

---

## Implementation Order

1. **IMP-0005 first** (fix cast types from `boolean` → `number`) — foundational for IMP-0001 since queryRows mapper will use the corrected types.
2. **IMP-0001** (extract `queryRows<T>`) — once types are correct, extract the helper and replace blocks.
3. **IMP-0002** (add row validation) — can be layered on top of `queryRows` by adding a Zod parse step.
4. **IMP-0004** (remove `String()`) — simple, independent, low risk.

---

## TypeScript Narrowing Caveat (IMP-0004)

When the array element type is `Record<string, unknown>`, TypeScript's control-flow narrowing does NOT propagate into `.map()`. This means:

```ts
// TS error: Type 'unknown' is not assignable to type 'string'
.filter((unit) => typeof unit?.id === "string")
.map((unit) => ({ id: unit.id }))

// Correct fix:
.map((unit) => ({ id: unit.id as string }))
```

The RFC says to "replace `String(unit.id)` with `unit.id`" but the safe implementation needs `unit.id as string` to avoid TS errors.

---

## Zod Usage in Project

The project already uses Zod (`events.ts` uses Zod 4 schemas extensively). For IMP-0002, using `z.object()` schemas for row validation is idiomatic. Example:

```ts
const finalReviewRowSchema = z.object({
  node_id: z.string(),
  iteration: z.number(),
  ready_to_move_on: z.number(),  // SQLite returns integer
  approved: z.number(),
  reasoning: z.string(),
  quality_score: z.number().nullable(),
});
```

---

## Files to Modify

- `src/runtime/event-bridge.ts` — sole target

## Files to Read (context only)

- `src/workflows/ralphinho/workflow/state.ts` — row types
- `.tickets/summary.md` — RFC specifications for IMP-0001 through IMP-0005
