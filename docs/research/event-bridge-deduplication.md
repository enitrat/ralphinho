# Research: event-bridge-deduplication

## Summary

Eliminate two independent sources of duplication in `event-bridge.ts`:
1. **Parallel Zod schemas + manual snake_case→camelCase mapping** for row types (FinalReviewRow, ImplementRow, TestRow, ReviewFixRow)
2. **Manual typeof guards** for merge_queue inner JSON fields instead of reusing existing Zod schemas from `schemas.ts`

## RFC References

- **IMP-0001**: event-bridge.ts duplicates the entire row-type system from workflow/state.ts
- **IMP-0004**: event-bridge.ts manually typeof-checks every field of parsed merge_queue JSON instead of reusing existing Zod schemas

## Key Files

### `src/runtime/event-bridge.ts` (primary target)
- **Lines 49-83**: Duplicate Zod schemas (`finalReviewRawRowSchema`, `implementRawRowSchema`, `testRawRowSchema`, `reviewFixRawRowSchema`) that define SQLite raw row shapes with snake_case columns and `z.number()` for booleans (SQLite INTEGER 0|1).
- **Lines 332-410**: Manual mapping from snake_case raw rows → camelCase domain types (FinalReviewRow, ImplementRow, TestRow, ReviewFixRow). Each mapper does `safeParse`, `parseNodeId` check, then field-by-field remapping with `Boolean()` coercion for integer booleans and `parseStringArray()` for JSON string arrays.
- **Lines 270-326**: Manual typeof guards for merge_queue inner JSON. After Zod-validating merge_queue rows (line 263-268), the inner JSON strings (`tickets_landed`, `tickets_evicted`, `tickets_skipped`) are parsed via `parseObjectArray` and then each field is individually typeof-checked with fallback defaults.
- **Lines 97-107**: `parseObjectArray` helper — parses JSON string → array of objects, used for merge_queue inner JSON. Will be deleted.

### `src/workflows/ralphinho/workflow/state.ts`
- **Lines 8-55**: Canonical domain types: `MergeQueueRow`, `TestRow`, `FinalReviewRow`, `ImplementRow`, `ReviewFixRow` — all camelCase with proper boolean types.
- **Lines 126-155**: `buildOutputSnapshot()` — takes `SnapshotInput` with all row arrays, returns `OutputSnapshot`.
- **Line 128-134**: `SnapshotInput` type — the interface event-bridge already uses to pass rows to `buildOutputSnapshot`.
- This is where `fromSqliteRow` factory functions should be added per the ticket.

### `src/workflows/ralphinho/schemas.ts`
- **Lines 186-206**: `merge_queue` Zod schema defining `ticketsLanded`, `ticketsEvicted`, `ticketsSkipped` shapes. These are the canonical schemas that should replace the manual typeof checks.
- **Lines 43-49**: `implement` schema
- **Lines 53-60**: `test` schema
- **Lines 79-97**: `review_fix` schema
- **Lines 99-114**: `final_review` schema
- NOTE: These schemas define the **write-path** shapes (booleans as `z.boolean()`, camelCase names). SQLite stores them as snake_case with INTEGER for booleans.

### `src/workflows/ralphinho/workflow/snapshot.ts`
- **Lines 13-22**: `buildSnapshot()` — the workflow-side equivalent that reads from `ctx.outputs()` (already validated by Smithers). Uses simple casts.
- Shows the pattern: workflow side trusts Smithers validation; event-bridge reads raw SQLite and must do its own validation.

### `src/runtime/events.ts`
- SmithersEvent type definitions and parsers. Event-bridge produces these events.

### `src/runtime/__tests__/event-bridge.test.ts`
- Tests only `queryRows` helper currently. Will need updates if `queryRows` signature changes.

## Analysis

### Duplication 1: Row Type Schemas (IMP-0001)

**Current state**: event-bridge.ts defines 4 raw row Zod schemas (lines 49-83) that model SQLite columns (snake_case, integers for booleans). Then 4 mapper functions (lines 332-410) convert these to the canonical domain types from state.ts.

**Key difference from workflow path**: The workflow path (snapshot.ts) reads from `ctx.outputs()` which returns already-validated camelCase objects. Event-bridge reads raw SQLite rows which are snake_case with INTEGER booleans.

**Proposed solution**: Add `fromSqliteRow(row: Record<string, unknown>): T` factory per type in `workflow/state.ts`. Each factory:
1. Validates via a Zod schema (can be co-located or imported)
2. Maps snake_case → camelCase
3. Coerces INTEGER → boolean
4. Returns the canonical domain type

Event-bridge then replaces 4 inline mapper functions with calls to these factories.

**Design considerations**:
- The raw row Zod schemas must handle SQLite INTEGER for booleans (`z.number()` then `Boolean()`)
- The `parseStringArray` helper is needed for `filesCreated`/`filesModified` in ImplementRow (stored as JSON strings in SQLite)
- `parseNodeId` validation is event-bridge specific (filters invalid node IDs) — should remain in event-bridge, not in the factory
- Factory should parse+map but NOT filter by nodeId

### Duplication 2: Manual typeof guards for merge_queue JSON (IMP-0004)

**Current state**: Lines 270-326 parse inner JSON from merge_queue columns and manually typeof-check every field:
- `typeof item.ticketId === 'string'` (filter)
- `typeof item.mergeCommit === 'string' ? ... : null` (coerce)
- `typeof item.summary === 'string' ? ... : row.summary ?? ""` (fallback)
- etc.

**Canonical schemas exist**: `schemas.ts` lines 187-206 define:
- `ticketsLanded`: `z.array(z.object({ ticketId, mergeCommit, summary, decisionIteration, testIteration, approvalSupersededRejection }))`
- `ticketsEvicted`: `z.array(z.object({ ticketId, reason, details }))`
- `ticketsSkipped`: `z.array(z.object({ ticketId, reason }))`

**Proposed solution**: Extract the inner array schemas from `scheduledOutputSchemas.merge_queue` and use `.safeParse()` on the parsed JSON. Example:
```typescript
const ticketsLandedSchema = scheduledOutputSchemas.merge_queue.shape.ticketsLanded;
const parsed = ticketsLandedSchema.safeParse(JSON.parse(row.tickets_landed));
const landed = parsed.success ? parsed.data : [];
```

**Design considerations**:
- The current code has lenient fallback behavior (e.g., `summary` falls back to `row.summary ?? ""`). Using `.safeParse()` with strict Zod schemas will reject rows with missing/wrong-type fields entirely. Need to decide if this is acceptable or if `.partial()` should be used.
- The `parseObjectArray` helper and per-field typeof checks (~50 lines) can be deleted.
- The merge_queue Zod schema uses camelCase field names, which should match the JSON stored in SQLite (Smithers writes camelCase JSON into the text columns).

## Dependencies

- `buildOutputSnapshot` from state.ts — event-bridge already imports and uses this
- `scheduledOutputSchemas` from schemas.ts — will need new import in event-bridge
- Row types from state.ts — already imported

## Existing Learnings

From `docs/learnings/event-bridge-refactor.md`:
- "Define refactoring scope exhaustively before implementation" — audit all occurrences before starting
- "Apply extracted helpers exhaustively" — don't leave partial migration
- Previous refactor already extracted `queryRows` helper but missed some blocks

## Open Questions

1. Should `fromSqliteRow` factories live in `state.ts` or a new `state-sqlite.ts` to avoid coupling state.ts to SQLite concerns?
2. Should the merge_queue inner JSON parsing use strict `.parse()` (throws on invalid) or `.safeParse()` (returns empty on invalid)? Current behavior silently falls back.
3. The `parseStringArray` helper (lines 109-117) is also used for work-plan and completion_report. Should it be preserved as a general utility?
4. Should `parseNodeId` filtering remain inline in event-bridge mappers, or be composed with the factory functions?
