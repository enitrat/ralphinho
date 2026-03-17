# Research: events-zod-migration

## Summary

Migrate `src/runtime/events.ts` from hand-rolled type guards and switch-based parsing to a Zod discriminated union. This eliminates ~200 lines of manual validation (6 type guards + 12-case switch) in favor of ~60 lines of Zod schema declarations.

## RFC References

### IMP-0002 (High)
- **File**: `src/runtime/events.ts` lines 135-361
- **Issue**: 6 manual type-guard functions (`isRecord`, `isString`, `isNumber`, `isNullableString`, `isStageName`, `isDecisionStatus`) and a 200-line `parseEvent` switch statement
- **Solution**: Replace with `z.discriminatedUnion('type', [...]).safeParse()`
- **Precedent**: `src/config/types.ts:38` already uses `z.discriminatedUnion("mode", [...])` for config parsing

### IMP-0007 (Medium)
- Same finding from different reviewers (refactor-hunter, type-system-purist), confirming the 200-line hand-rolled parsing is a simplification target
- Notes that Zod is already used everywhere else in the codebase (schemas.ts, config/types.ts, types.ts)

## Key Files

### Primary target
- **`src/runtime/events.ts`** (389 lines) — The file to migrate
  - Lines 6-18: `SmithersEvent` discriminated union type (12 variants)
  - Lines 20-129: 12 event interfaces, each with `type` discriminator field
  - Lines 131-133: `STAGE_NAMES` Set and `DECISION_STATUSES` Set (used for validation)
  - Lines 135-157: 6 type-guard functions to delete
  - Lines 159-361: `parseEvent` switch function to replace with Zod
  - Lines 363-389: `readEventLog` function (reads NDJSON, calls parseEvent) — keep but adapt

### Existing tests
- **`src/runtime/__tests__/events.test.ts`** (46 lines) — Minimal tests for `readEventLog`
  - Tests: file-not-found returns [], malformed JSON skipped, unknown types skipped
  - Needs expansion: per-variant validation, invalid field rejection, null/error return

### Consumers of SmithersEvent type
- **`src/runtime/projections.ts`** — `projectEvents(events: SmithersEvent[])` switches on `event.type`
- **`src/runtime/event-bridge.ts`** — Imports `SmithersEvent` type, constructs events from SQLite DB rows
- **`src/runtime/__tests__/projections.test.ts`** — Creates `SmithersEvent` objects for test fixtures

### Zod pattern reference
- **`src/config/types.ts`** — Uses `z.discriminatedUnion("mode", [...])` with `z.infer<>` for types (lines 38-47)

## Dependencies

### StageName (from contracts.ts)
```typescript
type StageName = "research" | "plan" | "implement" | "test" | "prd-review" | "code-review" | "review-fix" | "final-review" | "learnings";
```
- Used in: `NodeStartedEvent`, `NodeCompletedEvent`, `NodeFailedEvent`
- Current validation: `STAGE_NAMES` Set built from `DISPLAY_STAGES`
- Zod approach: `z.enum(["research", "plan", ...])` or derive from `DISPLAY_STAGES`

### DecisionStatus (from decisions.ts)
```typescript
type DecisionStatus = "pending" | "rejected" | "approved" | "invalidated";
```
- Used in: `FinalReviewDecisionEvent`
- Current validation: `DECISION_STATUSES` Set
- Zod approach: `z.enum(["pending", "rejected", "approved", "invalidated"])`

## Design Considerations

### Type compatibility
The Zod schema must produce `z.infer<typeof smithersEventSchema>` that is structurally identical to the current `SmithersEvent` union type. This ensures downstream consumers (`projections.ts`, `event-bridge.ts`, test files) require zero changes.

### parseEvent return type
Currently returns `SmithersEvent | null`. With Zod, use `.safeParse()` and return `result.data` on success, `null` on failure — same contract.

### readEventLog stays
The `readEventLog` function (lines 363-389) reads NDJSON and calls `parseEvent`. It should be preserved but updated to call the Zod-based parser.

### NDJSON error tolerance
Current behavior: malformed JSON lines and unknown event types are silently skipped. The Zod version must preserve this behavior (no throwing on invalid input).

### work-plan-loaded nested validation
The `work-plan-loaded` event has a nested `units` array with objects. The Zod schema needs `z.array(z.object({...}))` for this.

### semantic-completion-update array filtering
Currently: `value.unitsLanded.filter(isString)` — filters non-string elements from arrays. Zod `z.array(z.string())` would reject the entire event if any element isn't a string. Consider using `z.array(z.string()).or(z.array(z.unknown()).transform(arr => arr.filter(s => typeof s === 'string')))` or accept stricter validation.

### Performance
The RFC notes: "Accept if: The event types are stable enough that switching to Zod won't break NDJSON parsing performance requirements." This is a monitor polling path, not millions of events/sec. Zod overhead is acceptable.

## Implementation Plan

1. **Define Zod schemas** for each of the 12 event variants
2. **Create `smithersEventSchema`** as `z.discriminatedUnion('type', [...])`
3. **Derive `SmithersEvent` type** via `z.infer<typeof smithersEventSchema>` — delete manual interfaces only if Zod inference matches exactly, otherwise keep interfaces and add type tests
4. **Replace `parseEvent`** with `.safeParse()` wrapper returning `SmithersEvent | null`
5. **Delete** the 6 type-guard functions
6. **Delete** `STAGE_NAMES` Set and `DECISION_STATUSES` Set (validation moves into Zod enums)
7. **Expand tests** with per-variant valid/invalid cases

## Open Questions

1. Should the 12 event interfaces be deleted and replaced with `z.infer<>` types, or kept alongside for documentation? The config pattern (`config/types.ts`) uses `z.infer<>` exclusively.
2. The `semantic-completion-update` event currently filters non-string values from arrays rather than rejecting. Should we preserve this lenient behavior or accept stricter Zod validation?
3. Should `stageNameSchema` and `decisionStatusSchema` be exported for reuse by other modules (e.g., event-bridge.ts which has its own `STAGE_NAMES` Set)?
