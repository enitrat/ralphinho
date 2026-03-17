# Research: Workflow Layer Cleanup

## RFC References
- **IMP-0002**: snapshot.ts hand-rolls ~70 lines of row validators duplicating Smithers' Zod write-path validation
- **IMP-0003**: snapshot.ts contains ~65 lines of hand-rolled runtime validators duplicating Zod schema guarantees
- **IMP-0007**: getFinalDecision and isSemanticallyComplete are dead exports (only used in tests)
- **IMP-0009**: isUnitLanded in state.ts is a pure pass-through wrapper over snapshot.isUnitLanded
- **IMP-0010**: Row types declare nodeId/iteration as optional despite Smithers always providing them

---

## Files to Modify

### 1. `src/workflows/ralphinho/workflow/state.ts`
- **Row type definitions** (lines 21-55): Make `nodeId` and `iteration` required on TestRow, FinalReviewRow, ImplementRow, ReviewFixRow
- **isUnitLanded wrapper** (lines 83-85): Delete this pass-through function
- **groupByUnit** (line 168): Change generic constraint from `{ nodeId?: string }` to `{ nodeId: string }` — remove the `if (!row.nodeId) continue` guard
- **Internal call sites** of `isUnitLanded(snapshot, unitId)` at lines 88, 94, 104, 108, 193: Replace with `snapshot.isUnitLanded(unitId)`
- **Import of isMergeEligible** (line 6): Keep — still used in buildMergeTickets

### 2. `src/workflows/ralphinho/workflow/decisions.ts`
- **`?? 0` fallbacks** at lines 36, 41, 54, 58, 75: Remove all — fields will be required
- **byIterationAsc** (line 35): Change generic constraint from `{ iteration?: number }` to `{ iteration: number }`
- **getFinalDecision** (lines 161-163): Delete dead export
- **isSemanticallyComplete** (lines 169-171): Delete dead export

### 3. `src/workflows/ralphinho/workflow/snapshot.ts`
- **Delete validators** (lines 48-112): requireObject, requireBoolean, requireString, validateTestRow, validateFinalReviewRow, validateImplementRow, validateReviewFixRow (~65 lines)
- **Delete normalizeMergeQueueRow** (lines 13-31): Replace with direct cast
- **Delete runtimeOutputs** (lines 38-40): Replace with direct typed casts
- **buildSnapshot** (lines 114-135): Simplify to cast `ctx.outputs(table)` directly as typed arrays

### 4. `src/workflows/ralphinho/components/ScheduledWorkflow.tsx`
- **Import** (line 39): Remove `isUnitLanded` from state import
- **Line 86**: Replace `isUnitLanded(snapshot, unitId)` with `snapshot.isUnitLanded(unitId)`

### 5. `src/workflows/ralphinho/workflow/__tests__/state.test.ts`
- **Import** (line 13): Remove `isSemanticallyComplete` import
- **Line 430**: Replace `isSemanticallyComplete(s, "u1")` with `getDecisionAudit(s, "u1").semanticallyComplete`
- **Lines 61-77**: Tests for `isUnitLanded` — update to test `snapshot.isUnitLanded()` directly (or keep testing via state functions that now call it internally)
- **Import** (line 9): Remove `isUnitLanded` from state import (tests can test via getUnitState or snapshot directly)

### 6. `src/workflows/ralphinho/workflow/__tests__/snapshot.test.ts`
- **All "throws when X is missing" tests** (lines 15-118): These test the hand-rolled validators. Delete them entirely since validators are being removed.
- Keep the well-formed row acceptance tests if they test buildSnapshot generally, or delete if they only test validation.

---

## Key Observations

### nodeId/iteration are always provided by Smithers
- ✓ VERIFIED: `smithers-orchestrator/src/db/output.ts` lines 80-85 — `upsertOutputRowEffect` always sets `values.nodeId = key.nodeId` and `values.iteration = key.iteration ?? 0`
- ✓ VERIFIED: `smithers-orchestrator/src/context.ts` lines 62-68 — `resolveRow` reads `row.nodeId` and `row.iteration` from stored rows
- ✓ VERIFIED: event-bridge.ts (lines 332-410) always constructs rows WITH nodeId and iteration from SQL queries

### event-bridge.ts constructs rows with nodeId/iteration
- ✓ VERIFIED: Lines 341-348 (finalReview), 361-369 (implement), 382-389 (test), 401-408 (reviewFix) all include `nodeId: r.node_id` and `iteration: r.iteration`
- Making these fields required is compatible with event-bridge.ts

### Test file row construction
- ✓ VERIFIED: state.test.ts helper `finalReview()` (line 46-59) always provides nodeId and iteration
- ✓ VERIFIED: All test row literals in state.test.ts include nodeId and iteration (e.g., `{ nodeId: "u1:test", iteration: 2, ... }`)
- Some test rows omit iteration (e.g., line 180: `{ nodeId: "u1:test", testsPassed: false, buildPassed: true }`) — these need `iteration` added

### Smithers validates output via Zod at write time
- ✓ VERIFIED: `smithers-orchestrator/src/db/output.ts` lines 126-140 — `validateOutput` calls `createInsertSchema(table).safeParse(payload)`
- The hand-rolled validators in snapshot.ts are redundant

### isMergeEligible is NOT dead — keep it
- ✓ VERIFIED: Used in state.ts:195, state.ts:201, ScheduledWorkflow.tsx:184, plus tests
- Only getFinalDecision and isSemanticallyComplete are dead in production code

### isUnitLanded call sites (6 internal + 1 in ScheduledWorkflow)
- state.ts:88 (isUnitEvicted) → `snapshot.isUnitLanded(unitId)`
- state.ts:94 (getEvictionContext) → `snapshot.isUnitLanded(unitId)`
- state.ts:104 (getUnitState) → `snapshot.isUnitLanded(unitId)`
- state.ts:108 (getUnitState deps) → `snapshot.isUnitLanded(depId)`
- state.ts:193 (buildMergeTickets) → `snapshot.isUnitLanded(unit.id)`
- ScheduledWorkflow.tsx:86 → `snapshot.isUnitLanded(unitId)`

### snapshot.test.ts will need significant changes
- All "throws when X is missing" tests (15 tests) test the validators being deleted
- These tests should be removed entirely
- The "accepts a well-formed row" tests could be simplified to just verify buildSnapshot doesn't throw

---

## Risks and Edge Cases

1. **Test rows without iteration**: Some test fixtures in state.test.ts omit `iteration` on TestRow literals (e.g., line 180). Making iteration required means these need updating.
2. **snapshot.test.ts rewrite**: Deleting validators means deleting nearly all tests in snapshot.test.ts — consider whether any minimal smoke tests should remain.
3. **isMergeEligible redundant computation**: IMP-0008 notes that isMergeEligible recomputes the audit, but this ticket only removes dead exports — isMergeEligible stays. Could be a follow-up.
