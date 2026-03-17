# Implementation Plan: event-bridge-refactor

**Unit:** event-bridge-refactor
**Date:** 2026-03-17
**File:** `src/runtime/event-bridge.ts` (424 lines, sole target)

---

## Overview

A single-file mechanical refactoring pass applying four improvements:

1. **IMP-0001** — Extract `queryRows<T>` generic helper, replacing the repeated try/catch → db.query → map → filter pattern in the 4 typed-row blocks (lines 244–346).
2. **IMP-0002** — Replace all `as Array<T>` casts on `.all()` results with Zod `safeParse` row validators so schema drift is caught at runtime rather than silently mistyped.
3. **IMP-0004** — Replace `String(unit.id)` / `String(item.ticketId)` with `as string` casts where the preceding `.filter()` already narrows to string.
4. **IMP-0005** — Fix boolean field types in the raw-row casts from `boolean` → `number` (matching SQLite's 0/1 integer return), keeping `Boolean()` as the sole coercion layer.

---

## Work Type Assessment

**Primarily mechanical refactoring.** No new features, no public API changes, no bug fixes — the existing code produces correct outputs. The changes either:
- Remove redundancy (`String()` wrappers, over-broad type casts)
- Improve accuracy (type annotations now reflect what bun:sqlite actually returns)
- Add observability (Zod validation surfaces schema drift as swallowed errors rather than silent mismatch)

**Does TDD apply?**
Partially. Most changes (IMP-0004, IMP-0005, the extraction in IMP-0001) are mechanical and the compiler enforces correctness. However:
- The `queryRows` helper is net-new code with specific behaviours (null-filter, error-swallow) that are not exercised by existing tests
- Acceptance criteria explicitly requires "new tests cover the `queryRows` helper's null-filter and error-swallow behaviour"
- IMP-0002's Zod integration changes runtime behaviour (invalid rows now produce null from `safeParse` rather than blowing past unchecked)

**TDD verdict:** Write tests for `queryRows` alongside its extraction (Step 3 below). Other changes verified by typecheck + existing test suite.

---

## Step-by-Step Changes

### Step 1 — IMP-0005: Fix boolean cast types (lines 247–346)

**Why first:** Correctness foundation. The `as Array<{..., ready_to_move_on: boolean}>` casts lie — SQLite returns integers. Fixing the cast types before extracting `queryRows` means the mapper signatures will be correct from the start.

**Changes in `src/runtime/event-bridge.ts`:**

In the `final_review` block (line ~247 cast):
```ts
// Before
.all(runId) as Array<{
  node_id: string;
  iteration: number;
  ready_to_move_on: boolean;   // ← lies: SQLite returns 0|1
  approved: boolean;           // ← lies
  reasoning: string;
  quality_score: number | null;
}>;

// After
.all(runId) as Array<{
  node_id: string;
  iteration: number;
  ready_to_move_on: number;    // ← correct: SQLite INTEGER
  approved: number;            // ← correct
  reasoning: string;
  quality_score: number | null;
}>;
```

Same pattern for:
- `implement` block (line ~273): `believes_complete: boolean` → `believes_complete: number`
- `test` block (line ~301): `tests_passed: boolean`, `build_passed: boolean` → both `number`
- `review_fix` block (line ~325): `all_issues_resolved: boolean`, `build_passed: boolean`, `tests_passed: boolean` → all `number`

Keep all `Boolean()` wrappers at lines 260, 261, 290, 313, 314, 339, 340, 341 — these are now the single coercion source.

**Verification:** `bun run typecheck` — should still pass (Boolean() accepts number).

---

### Step 2 — IMP-0001: Extract `queryRows<T>` helper

**Add a structural interface** near the top of the file (after imports, before `parseNodeId`) to type the `db` parameter without requiring a dynamic import:

```ts
interface SqliteDb {
  query(sql: string): { all(...params: unknown[]): unknown[] };
}
```

**Add `queryRows` function** after `normalizeTier` (~line 50):

```ts
function queryRows<T>(
  db: SqliteDb,
  sql: string,
  params: unknown[],
  mapper: (row: unknown) => T | null,
): T[] {
  try {
    return db.query(sql).all(...params)
      .map(mapper)
      .filter((r): r is T => r !== null);
  } catch {
    return [];
  }
}
```

**Replace the 4 typed-row blocks** (lines 244–346) with `queryRows` calls. The `allFinalReviewRows`, `allImplementRows`, `allTestRows`, `allReviewFixRows` variables become `const` assignments instead of `let [] + try/catch`:

```ts
const allFinalReviewRows: FinalReviewRow[] = queryRows(
  db,
  "SELECT node_id, iteration, ready_to_move_on, approved, reasoning, quality_score FROM final_review WHERE run_id = ? ORDER BY iteration ASC",
  [runId],
  (row) => {
    // Zod or manual validation here (Step 4 adds Zod)
    const r = row as { node_id: string; iteration: number; ready_to_move_on: number; approved: number; reasoning: string; quality_score: number | null };
    if (!parseNodeId(r.node_id)) return null;
    return {
      nodeId: r.node_id,
      iteration: r.iteration,
      readyToMoveOn: Boolean(r.ready_to_move_on),
      approved: Boolean(r.approved),
      reasoning: r.reasoning ?? "",
      qualityScore: r.quality_score,
    };
  },
);
```

Repeat for `implement`, `test`, `review_fix`.

**Note:** The `_smithers_nodes` block (lines 89–115) emits multiple event types per row (node-started, node-completed, node-failed) and does NOT fit the `queryRows<T>` pattern cleanly. Leave it as-is; IMP-0002 will add Zod validation to it in place.

**Note:** The `merge_queue` block (lines 166–237) operates on JSON columns within rows rather than being a separate DB-poll block. Leave it as-is; IMP-0002 will add Zod validation to it.

---

### Step 3 — Write tests for `queryRows`

**File to create:** `src/runtime/__tests__/event-bridge.test.ts`

Use `bun:sqlite` in-memory DB (`:memory:`) for isolation. Test the helper's two critical behaviours:

```ts
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

// Import the queryRows helper — requires exporting it from event-bridge.ts
// OR testing via pollEventsFromDb with a mock DB path
// Preferred: export queryRows for direct unit testing
```

**Test cases:**
1. `queryRows — returns correctly mapped rows for valid data`
2. `queryRows — filters out null when mapper returns null` (null-filter behaviour — e.g. parseNodeId returns null for invalid node_id)
3. `queryRows — returns [] when DB throws` (error-swallow behaviour — e.g. query against non-existent table)
4. `queryRows — returns [] for empty result set`
5. `queryRows — propagates mapper result types correctly` (TypeScript-level, verified by typecheck)

**Implementation note:** Export `queryRows` with `export` keyword so it can be imported in tests. It's an internal helper but direct testing is cleaner than going through `pollEventsFromDb`.

---

### Step 4 — IMP-0002: Add Zod row schemas

**Add Zod schemas** near the top of `event-bridge.ts` (after imports):

```ts
import { z } from "zod";

// Raw row schemas — boolean columns are number (SQLite INTEGER)
const smithersNodeRow = z.object({
  node_id: z.string(),
  state: z.string(),
  started_at_ms: z.number().optional(),
  completed_at_ms: z.number().optional(),
});

const scheduledTaskRow = z.object({
  job_type: z.string(),
  agent_id: z.string(),
  ticket_id: z.string().nullable(),
  created_at_ms: z.number(),
});

const smithersAttemptRow = z.object({
  node_id: z.string(),
  started_at_ms: z.number().nullable(),
});

const mergeQueueRow = z.object({
  iteration: z.number(),
  tickets_landed: z.string().nullable(),
  tickets_evicted: z.string().nullable(),
  tickets_skipped: z.string().nullable(),
  summary: z.string().nullable(),
});

const finalReviewRawRow = z.object({
  node_id: z.string(),
  iteration: z.number(),
  ready_to_move_on: z.number(),
  approved: z.number(),
  reasoning: z.string(),
  quality_score: z.number().nullable(),
});

const implementRawRow = z.object({
  node_id: z.string(),
  iteration: z.number(),
  what_was_done: z.string(),
  files_created: z.string().nullable(),
  files_modified: z.string().nullable(),
  believes_complete: z.number(),
  summary: z.string().nullable(),
});

const testRawRow = z.object({
  node_id: z.string(),
  iteration: z.number(),
  tests_passed: z.number(),
  build_passed: z.number(),
  failing_summary: z.string().nullable(),
});

const reviewFixRawRow = z.object({
  node_id: z.string(),
  iteration: z.number(),
  summary: z.string(),
  all_issues_resolved: z.number(),
  build_passed: z.number(),
  tests_passed: z.number(),
});
```

**Update `queryRows` mappers** to use `safeParse` instead of the inline `as` cast:

```ts
(row) => {
  const parsed = finalReviewRawRow.safeParse(row);
  if (!parsed.success) return null;
  const r = parsed.data;
  if (!parseNodeId(r.node_id)) return null;
  return { ... };
},
```

**Update the non-queryRows blocks** (_smithers_nodes, scheduled_tasks, _smithers_attempts, merge_queue) to use Zod array safeParse:

```ts
// Replace: .all(runId) as Array<SomeType>
// With:
const rawRows = smithersNodeRow.array().safeParse(db.query(sql).all(runId));
const rows = rawRows.success ? rawRows.data : [];
```

This ensures no `as Array<T>` cast appears without a runtime shape check.

---

### Step 5 — IMP-0004: Remove redundant `String()` wrappers

**Change 1 — Line 72:**
```ts
// Before
id: String(unit.id),
// After
id: unit.id as string,
```

**Change 2 — Line 184:**
```ts
// Before
ticketId: String(item.ticketId),
// After
ticketId: item.ticketId as string,
```

**Change 3 — Line 194 (ticketsEvicted, same pattern):**
```ts
// Before
ticketId: String(item.ticketId),
// After
ticketId: item.ticketId as string,
```

**Rationale:** `String()` is semantically equivalent to `as string` after the preceding `.filter(item => typeof item.ticketId === "string")`, but the `as string` is more honest — it documents that TypeScript's control-flow narrowing doesn't propagate across `.map()` on `Record<string, unknown>`.

---

### Step 6 — Final Verification

```bash
# Type check
bun run typecheck

# New tests
bun test src/runtime/__tests__/event-bridge.test.ts

# All existing tests
bun test src/runtime/__tests__/
```

---

## Files to Create

- `src/runtime/__tests__/event-bridge.test.ts` — Unit tests for `queryRows` helper

## Files to Modify

- `src/runtime/event-bridge.ts` — All four IMP changes applied in one pass

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Zod `safeParse` in mapper — a single bad row throws inside `queryRows`'s try/catch, returning `[]` instead of filtering | Use `safeParse` not `parse`; return `null` on `!success` so bad rows are individually skipped without aborting the whole block |
| `queryRows` db param requires `bun:sqlite` Database type but that's dynamically imported | Use structural `SqliteDb` interface — structurally compatible, no import needed |
| TS narrowing from `.filter()` doesn't carry into `.map()` on `Record<string, unknown>` | Use `as string` not bare `unit.id` (documented in research; `String()` removal is NOT dropping the cast entirely) |
| `queryRows` export exposes internal helper in module API | Acceptable tradeoff for testability; prefix with `_` or add `@internal` JSDoc if needed |
| Zod version — project uses Zod 4 (per research, events.ts uses Zod 4 schemas) | Use `z.object()` / `z.array()` which are stable across v3/v4 |
| `review_fix` has 3 boolean columns vs final_review's 2 — easy to miss one | Fix all 8 boolean fields in one pass (Step 1) before extracting helper |

---

## Acceptance Criteria Checklist

1. **queryRows helper** — single `queryRows<T>` function called for all 4 DB-poll blocks (final_review, implement, test, review_fix) that previously repeated try/catch
2. **No unsafe casts** — every `.all()` result goes through Zod `safeParse` or array safeParse before use; no bare `as Array<T>` without shape check
3. **String() removed** — `String(unit.id)` → `unit.id as string` (line 72), `String(item.ticketId)` → `item.ticketId as string` (lines 184, 194)
4. **Single boolean coercion** — all SQLite boolean columns typed as `number` in raw schemas; `Boolean()` retained as sole coercion; no field has both `as boolean` cast AND `Boolean()` wrapper
5. **Typecheck passes** — `bun run typecheck` exits 0 with no new errors
6. **Tests pass** — new `event-bridge.test.ts` covers null-filter and error-swallow; existing runtime tests pass
