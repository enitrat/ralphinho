# Research: ScheduledWorkflow Domain Extraction

## Unit ID
scheduledworkflow-domain-extraction

## Summary
Two related architectural improvements:
1. Extract ~50 lines of failure-reason computation from ScheduledWorkflow.tsx (lines 107-154) into a pure function `buildFailedUnitReport` in the workflow domain layer.
2. Fix redundant audit recomputation: `buildMergeTickets` calls `isMergeEligible` (which calls `getDecisionAudit`) even though the caller already has an `auditMap`.

## RFC Sections
- **IMP-0006**: ScheduledWorkflow inlines ~50 lines of failure-reason computation that belongs in the workflow domain layer
- **IMP-0008**: isMergeEligible and isSemanticallyComplete recompute the full decision audit redundantly

## Key Files

### Primary targets
- `src/workflows/ralphinho/components/ScheduledWorkflow.tsx` - Contains the inline failure-reason logic (lines 107-154) and the `auditMap` that could be passed to `buildMergeTickets`
- `src/workflows/ralphinho/workflow/state.ts` - Contains `buildMergeTickets` (lines 180-222) which calls `isMergeEligible` and `getDecisionAudit` redundantly
- `src/workflows/ralphinho/workflow/decisions.ts` - Contains `getDecisionAudit`, `isMergeEligible` wrapper (line 158-160), and `DecisionAudit` type

### Supporting files
- `src/workflows/ralphinho/workflow/contracts.ts` - `TIER_STAGES`, `stageNodeId`, `StageName` type
- `src/workflows/ralphinho/workflow/snapshot.ts` - `buildSnapshot` function
- `src/workflows/ralphinho/types.ts` - `WorkUnit` type with `id`, `name`, `deps`, `tier`
- `src/workflows/ralphinho/components/QualityPipeline.tsx` - `ScheduledOutputs` type

### Test files
- `src/workflows/ralphinho/workflow/__tests__/state.test.ts` - Tests for `buildMergeTickets`, `isMergeEligible`, etc.
- `src/workflows/ralphinho/components/__tests__/ScheduledWorkflow.test.tsx` - Component-level tests

## Analysis

### Task 1: Extract `buildFailedUnitReport`

**Current location**: ScheduledWorkflow.tsx lines 107-154

**Logic overview** (pure domain, no React/JSX):
1. Filters units to those NOT semantically complete
2. For each unit, determines `lastStage` by iterating stages in reverse order (final-review -> research), checking `ctx.latest(stage.key, stage.nodeId)` for existence
3. Stages are filtered by `TIER_STAGES[unit.tier]` (small vs large tiers have different pipeline stages)
4. Computes failure `reason` with priority cascade:
   - Default: "blocked by deps" or "did not complete within N passes"
   - Eviction context overrides
   - Failing tests override
   - `audit.status === "rejected"` overrides
   - `audit.status === "invalidated"` overrides
   - Special case: landed without semantic completion

**Return type**: `Array<{ unitId: string; lastStage: string; reason: string }>`

**Dependencies needed**:
- `OutputSnapshot` (from state.ts)
- `WorkUnit[]` (from types.ts)
- `DecisionAudit` / auditMap (from decisions.ts)
- `TIER_STAGES`, `stageNodeId` (from contracts.ts)
- A way to check stage existence - currently uses `ctx.latest(stage.key, stage.nodeId)`. This is the one React/Smithers dependency. The function needs either:
  - (a) The `ctx` object passed through, or
  - (b) A pre-computed map of which stages have output (e.g., `stageExists: (table: string, nodeId: string) => boolean`)

**Important design consideration**: The `ctx.latest()` call on line 128 reads from the Smithers context, not the snapshot. The function signature should either accept `ctx` or a stage-existence checker to decouple from Smithers.

**Suggested location**: `workflow/state.ts` (consistent with `buildMergeTickets`) or a new `workflow/reports.ts`

### Task 2: Fix redundant audit recomputation in `buildMergeTickets`

**Current call chain**:
1. `ScheduledWorkflow` builds `auditMap` via `getDecisionAudit` for every unit (line 89-91)
2. `ScheduledWorkflow` calls `buildMergeTickets(snapshot, units, runId, iteration)` (line 158-163)
3. Inside `buildMergeTickets`:
   - Line 190: `isMergeEligible(snapshot, unit.id)` -> calls `getDecisionAudit` (1st redundant call per unit)
   - Line 196: `isMergeEligible(snapshot, unit.id)` -> calls `getDecisionAudit` again (2nd redundant call for evicted units)
   - Line 204: `getDecisionAudit(snapshot, unit.id)` -> explicit 3rd call per eligible unit

**Fix approach**:
- Add `auditMap: Map<string, DecisionAudit>` parameter to `buildMergeTickets`
- Replace `isMergeEligible(snapshot, unit.id)` with `auditMap.get(unit.id)!.mergeEligible`
- Replace `getDecisionAudit(snapshot, unit.id)` on line 204 with `auditMap.get(unit.id)!`
- Update the call site in ScheduledWorkflow.tsx to pass the existing `auditMap`
- Update existing tests in state.test.ts

**Signature change**:
```typescript
// Before
export function buildMergeTickets(
  snapshot: OutputSnapshot,
  units: WorkUnit[],
  runId: string,
  iteration: number,
): AgenticMergeQueueTicket[]

// After
export function buildMergeTickets(
  snapshot: OutputSnapshot,
  units: WorkUnit[],
  runId: string,
  iteration: number,
  auditMap?: Map<string, DecisionAudit>,  // optional for backward compat, or required
): AgenticMergeQueueTicket[]
```

### Test impact
- `state.test.ts` tests for `buildMergeTickets` will need updating if signature changes (6 test cases)
- New tests needed for `buildFailedUnitReport` function
- `ScheduledWorkflow.test.tsx` should continue passing as behavior doesn't change

## Stage definitions used in failure-reason logic

The allStages array maps output table keys to stage names:
```
final_review -> final-review
review_fix   -> review-fix
code_review  -> code-review  (not in current code - uses prd-review instead)
prd_review   -> prd-review
test         -> test
implement    -> implement
plan         -> plan
research     -> research
```

Note: The stages are checked in reverse order (final-review first, research last) to find the "last completed stage".

## Open questions
1. Should `buildFailedUnitReport` accept `ctx` directly or a `stageExists` callback to avoid coupling to SmithersCtx?
2. Should `auditMap` be required or optional in `buildMergeTickets`? Making it required is cleaner but breaks backward compat.
3. Should `isMergeEligible` wrapper in decisions.ts be removed entirely (per IMP-0007) as part of this change, or kept for other potential callers?
4. The `ScheduledWorkflow` also calls `isMergeEligible` directly on line 182 - should this also use the auditMap?
