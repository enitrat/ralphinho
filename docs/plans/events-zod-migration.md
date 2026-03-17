# Plan: Migrate events.ts to Zod Discriminated Union

## Overview

Replace the hand-rolled event parsing in `src/runtime/events.ts` (6 type guards + 200-line switch) with a Zod discriminated union schema. The `parseEvent` function becomes a thin `.safeParse()` wrapper. All 12 event variants get individual Zod object schemas composed into `z.discriminatedUnion('type', [...])`.

## TDD Applicability

**TDD applies.** While this is a refactoring, the parsing logic has observable behavior (valid/invalid input → typed event or null) that currently has minimal test coverage. The existing tests only cover `readEventLog` (file-not-found, malformed JSON). Writing per-variant tests first ensures the migration preserves exact behavior, especially for edge cases like:
- `semantic-completion-update` filtering non-string array elements
- `node-failed` with optional `error` field
- `work-plan-loaded` with nested unit objects

## Steps

### Phase 1: Write tests (before implementation)

**Step 1 — Export `parseEvent` for testing**

File: `src/runtime/events.ts`
- Add `export` to `parseEvent` function signature (currently private)
- This is temporary for testing; can be re-internalized later if desired

**Step 2 — Write per-variant valid input tests**

File: `src/runtime/__tests__/events.test.ts`
- Add `import { parseEvent } from "../events"`
- Add `describe("parseEvent", () => { ... })` block
- Write 12 tests, one per event variant, each asserting:
  - `parseEvent(validInput)` returns the correctly typed event
  - All fields are present and correctly typed
- Test fixtures (one per variant):
  1. `node-started` — with valid StageName
  2. `node-completed` — with valid StageName
  3. `node-failed` — with valid StageName, with and without optional `error`
  4. `job-scheduled` — with `ticketId: null` and `ticketId: "t1"`
  5. `job-completed` — with nullable ticketId
  6. `merge-queue-landed` — with `mergeCommit: null`
  7. `merge-queue-evicted` — all string fields
  8. `merge-queue-skipped` — all string fields
  9. `pass-tracker-update` — with number maxConcurrency
  10. `work-plan-loaded` — with nested units array
  11. `final-review-decision` — with DecisionStatus and booleans
  12. `semantic-completion-update` — with string arrays

**Step 3 — Write invalid input tests**

File: `src/runtime/__tests__/events.test.ts`
- At least 5 invalid input tests:
  1. `null` → returns null
  2. `"string"` → returns null
  3. `{ type: "unknown" }` → returns null
  4. `{ type: "node-started", timestamp: 1 }` (missing required fields) → returns null
  5. `{ type: "node-started", timestamp: "not-a-number", ... }` → returns null
  6. `{ type: "semantic-completion-update", ..., unitsLanded: [1, "a", 2] }` → verify filtering behavior (returns `["a"]`)

**Step 4 — Run tests, confirm all pass against current implementation**

```bash
bun test src/runtime/__tests__/events.test.ts
```

### Phase 2: Implement Zod migration

**Step 5 — Add Zod schemas for shared enums**

File: `src/runtime/events.ts`
- Add `import { z } from "zod"`
- Define `const stageNameSchema = z.enum(["research", "plan", "implement", "test", "prd-review", "code-review", "review-fix", "final-review", "learnings"])` (derived from DISPLAY_STAGES values)
- Define `const decisionStatusSchema = z.enum(["pending", "rejected", "approved", "invalidated"])`

**Step 6 — Define per-variant Zod object schemas**

File: `src/runtime/events.ts`
- 12 schemas, e.g.:
```typescript
const nodeStartedSchema = z.object({
  type: z.literal("node-started"),
  timestamp: z.number().finite(),
  runId: z.string(),
  nodeId: z.string(),
  unitId: z.string(),
  stageName: stageNameSchema,
});
```
- For `node-failed`: use `error: z.string().optional()`
- For nullable strings: use `z.string().nullable()`
- For `work-plan-loaded`: use `z.array(z.object({ id: z.string(), name: z.string(), tier: z.enum(["small", "large"]), priority: z.string() }))`
- For `semantic-completion-update`: use `z.preprocess()` or `.transform()` to preserve the array-filtering behavior:
```typescript
const stringArrayFilterSchema = z.array(z.unknown()).transform(arr => arr.filter((s): s is string => typeof s === 'string'));
```

**Step 7 — Create discriminated union schema**

File: `src/runtime/events.ts`
```typescript
const smithersEventSchema = z.discriminatedUnion("type", [
  nodeStartedSchema,
  nodeCompletedSchema,
  // ... all 12
]);
```

**Step 8 — Replace parseEvent with Zod-based implementation**

File: `src/runtime/events.ts`
```typescript
export function parseEvent(value: unknown): SmithersEvent | null {
  const result = smithersEventSchema.safeParse(value);
  return result.success ? result.data : null;
}
```

**Step 9 — Delete manual type guards and sets**

File: `src/runtime/events.ts`
- Delete `STAGE_NAMES` Set (line 131)
- Delete `DECISION_STATUSES` Set (line 133)
- Delete 6 functions: `isRecord`, `isString`, `isNumber`, `isNullableString`, `isStageName`, `isDecisionStatus` (lines 135-157)
- Delete the old switch-based `parseEvent` (lines 159-361)
- Remove `DISPLAY_STAGES` import if no longer needed

**Step 10 — Keep interfaces, verify type compatibility**

- Keep the 12 `export interface` declarations — they serve as documentation and are used by consumers
- Verify that `z.infer<typeof smithersEventSchema>` is assignable to/from `SmithersEvent`
- Add a compile-time type assertion:
```typescript
type _TypeCheck = z.infer<typeof smithersEventSchema> extends SmithersEvent ? SmithersEvent extends z.infer<typeof smithersEventSchema> ? true : never : never;
```

### Phase 3: Verify

**Step 11 — Run tests**

```bash
bun test src/runtime/__tests__/events.test.ts
```

**Step 12 — Run typecheck**

```bash
bun run typecheck
```

**Step 13 — Run full test suite**

```bash
bun test
```

## Files to Modify

| File | Change |
|------|--------|
| `src/runtime/events.ts` | Add Zod schemas, replace parseEvent, delete type guards |
| `src/runtime/__tests__/events.test.ts` | Add per-variant tests for parseEvent |

## Files to Create

None.

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| `semantic-completion-update` array filtering behavior change | Use `z.preprocess`/`.transform` to preserve filter-not-reject semantics |
| `z.number().finite()` vs current `isNumber` (which checks `Number.isFinite`) | Both reject NaN/Infinity — identical behavior |
| StageName enum drift if DISPLAY_STAGES changes | Keep stageNameSchema values in sync; consider deriving from DISPLAY_STAGES at schema level |
| `z.infer` type doesn't exactly match interfaces | Keep interfaces, add compile-time type assertion |
| `DecisionStatus` import becomes type-only but enum values needed | Import values from decisions.ts or inline the enum in Zod schema |

## Acceptance Criteria Verification

1. ✅ Six guard functions deleted — Step 9
2. ✅ parseEvent uses `z.discriminatedUnion().safeParse()` — Steps 7-8
3. ✅ All 12 variants parse correctly — Step 2 tests + Step 11
4. ✅ Invalid input returns null — Step 3 tests + Step 11
5. ✅ `bun run typecheck` passes — Step 12
6. ✅ Unit tests cover each variant + 3+ invalid inputs — Steps 2-3
