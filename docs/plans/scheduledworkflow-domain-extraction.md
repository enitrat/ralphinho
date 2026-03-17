# Plan: ScheduledWorkflow Domain Extraction

## Overview

Two mechanical refactoring tasks with no behavior change:

1. **Extract `buildFailedUnitReport`** — Move ~50 lines of pure failure-reason computation (ScheduledWorkflow.tsx lines 107-154) into a domain-layer function in `workflow/state.ts`.
2. **Eliminate redundant audit recomputation** — Refactor `buildMergeTickets` to accept a pre-computed `auditMap` instead of calling `getDecisionAudit`/`isMergeEligible` internally (2-3x per unit per render). Also fix the direct `isMergeEligible` call on line 182 of ScheduledWorkflow.tsx.

## TDD Applicability

**TDD does not apply.** This is purely mechanical refactoring:
- Extracting an inline block into a named function with identical logic
- Changing a function to accept a pre-computed parameter instead of recomputing it
- No new behavior, no new code paths, no bug fixes
- The compiler (typecheck) enforces correctness of the wiring
- Existing tests for `buildMergeTickets` cover the behavior and will be updated for the new signature

**Verification**: `bun run typecheck` + existing test suite (`state.test.ts`, `ScheduledWorkflow.test.tsx`).

## Step-by-Step Changes

### Step 1: Add `buildFailedUnitReport` to `workflow/state.ts`

Extract the failure-reason computation into a pure function. The key design decision: use a `stageExists: (key: string, nodeId: string) => boolean` callback to decouple from `SmithersCtx`.

**Function signature:**
```typescript
export type FailedUnitReport = {
  unitId: string;
  lastStage: string;
  reason: string;
};

export function buildFailedUnitReport(
  snapshot: OutputSnapshot,
  units: WorkUnit[],
  auditMap: Map<string, DecisionAudit>,
  maxPasses: number,
  stageExists: (key: string, nodeId: string) => boolean,
): FailedUnitReport[]
```

**Logic** (moved verbatim from ScheduledWorkflow.tsx lines 107-154):
1. Filter units to those where `!auditMap.get(u.id)!.semanticallyComplete`
2. For each unit, determine `lastStage` by checking stages in reverse order via `stageExists`
3. Filter stages by `TIER_STAGES[unit.tier]`
4. Compute failure `reason` with the existing priority cascade (deps blocked → max passes → eviction → test failure → rejected → invalidated → landed-without-completion)

**File**: `src/workflows/ralphinho/workflow/state.ts`
**Imports to add**: `DecisionAudit` from `./decisions`, `TIER_STAGES`, `stageNodeId` from `./contracts`

### Step 2: Refactor `buildMergeTickets` to accept `auditMap`

**New signature:**
```typescript
export function buildMergeTickets(
  snapshot: OutputSnapshot,
  units: WorkUnit[],
  runId: string,
  iteration: number,
  auditMap: Map<string, DecisionAudit>,
): AgenticMergeQueueTicket[]
```

**Changes inside `buildMergeTickets`:**
- Replace `isMergeEligible(snapshot, unit.id)` on line 190 with `auditMap.get(unit.id)!.mergeEligible`
- Replace `isMergeEligible(snapshot, unit.id)` on line 196 with `auditMap.get(unit.id)!.mergeEligible`
- Replace `getDecisionAudit(snapshot, unit.id)` on line 204 with `auditMap.get(unit.id)!`
- Remove imports of `getDecisionAudit` and `isMergeEligible` from `./decisions` (if no other usages remain in state.ts)

### Step 3: Update `ScheduledWorkflow.tsx` call sites

1. **Replace lines 107-154** (failure computation) with:
   ```typescript
   const failedUnits = buildFailedUnitReport(
     snapshot, units, auditMap, maxPasses,
     (key, nodeId) => !!ctx.latest(key as keyof ScheduledOutputs, nodeId),
   );
   ```

2. **Update `buildMergeTickets` call** (lines 158-163) to pass `auditMap`:
   ```typescript
   const mergeTickets = buildMergeTickets(snapshot, units, ctx.runId, ctx.iteration, auditMap);
   ```

3. **Replace `isMergeEligible` call on line 182** with `unitAudit(unit.id).mergeEligible`:
   ```typescript
   if (unitAudit(unit.id).mergeEligible && !unitEvictionContext(unit.id)) return null;
   ```

4. **Clean up imports**: Remove `isMergeEligible` from the decisions import (keep `getDecisionAudit` and `DecisionAudit`). Add `buildFailedUnitReport` to the state import.

### Step 4: Update existing tests in `state.test.ts`

The 6 `buildMergeTickets` tests need the new `auditMap` parameter. For each test:
1. Build the same snapshot as before
2. Compute `auditMap` from `getDecisionAudit(snapshot, unitId)` for each unit in the test
3. Pass `auditMap` as the 5th argument to `buildMergeTickets`

This is mechanical — the tests already set up snapshots with the same data that `getDecisionAudit` reads.

### Step 5: Verify

1. `bun run typecheck` — no errors
2. `bun test src/workflows/ralphinho/workflow/__tests__/state.test.ts` — all 6 `buildMergeTickets` tests pass
3. `bun test src/workflows/ralphinho/components/__tests__/ScheduledWorkflow.test.tsx` — component tests pass
4. Full test suite passes

## Files to Modify

| File | Changes |
|------|---------|
| `src/workflows/ralphinho/workflow/state.ts` | Add `buildFailedUnitReport` function + `FailedUnitReport` type; refactor `buildMergeTickets` to accept `auditMap`; remove `isMergeEligible`/`getDecisionAudit` imports if unused |
| `src/workflows/ralphinho/components/ScheduledWorkflow.tsx` | Replace inline failure logic with `buildFailedUnitReport` call; pass `auditMap` to `buildMergeTickets`; replace `isMergeEligible` with `auditMap` lookup; update imports |
| `src/workflows/ralphinho/workflow/__tests__/state.test.ts` | Update `buildMergeTickets` test calls to pass `auditMap` parameter |

## Files to Create

None.

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| `stageExists` callback type — `ctx.latest` uses typed keys (`keyof ScheduledOutputs`), but extracted function uses `string` | Cast at call site: `(key, nodeId) => !!ctx.latest(key as keyof ScheduledOutputs, nodeId)`. The stage keys are defined in contracts.ts and are valid ScheduledOutputs keys. |
| `auditMap.get(unit.id)!` could be undefined if a unit is missing from the map | The map is built from the same `units` array, so every unit is guaranteed present. The `!` assertion is safe. |
| `isMergeEligible` may have callers outside state.ts/ScheduledWorkflow.tsx | Checked via grep — only used in state.ts (buildMergeTickets), ScheduledWorkflow.tsx (line 182), and state.test.ts. After refactor, only test imports remain (for the `isMergeEligible` describe block). The wrapper function in decisions.ts stays exported for potential external use. |
| Existing `ScheduledWorkflow.test.tsx` may break | The component tests render the component with props — behavior is unchanged, so they should pass. The extracted function is called with the same inputs. |

## Acceptance Criteria Verification

| # | Criterion | How Verified |
|---|-----------|-------------|
| 1 | Lines 109-156 replaced by single call to `buildFailedUnitReport` | Code review of ScheduledWorkflow.tsx |
| 2 | Extracted function has no React imports/JSX | Code review of state.ts — function uses only domain types |
| 3 | `buildMergeTickets` accepts pre-computed `auditMap` | Signature check in state.ts |
| 4 | ScheduledWorkflow passes existing `auditMap` to `buildMergeTickets` | Code review of call site |
| 5 | `isMergeEligible` no longer called from `buildMergeTickets` | Code review + grep |
| 6 | `bun run typecheck` passes | Run typecheck |
| 7 | Existing tests pass | Run test suite |
