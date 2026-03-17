# Research: decisions-cleanup-orchestration

**Unit**: decisions-cleanup-orchestration
**Title**: Delete decisions.ts and Update State, Orchestration, and Exports
**Date**: 2026-03-17

---

## Summary

This unit removes `decisions.ts` entirely and updates all consumers to use a structural
`ReviewLoopResult`-based merge eligibility check instead of the row-counting/anti-rubber-stamp
heuristics previously performed by `isMergeEligible()`.

---

## Files to Modify

### 1. `src/workflows/ralphinho/workflow/decisions.ts` — DELETE

**What it contains (✓ VERIFIED)**:
- `DecisionStatus` union type (`"pending" | "rejected" | "approved" | "invalidated"`)
- `DurableDecision` type — per-iteration final-review audit record
- `DecisionAudit` type — full audit aggregate (`history`, `mergeEligible`, `semanticallyComplete`, etc.)
- `deriveDurableDecisionHistory()` — internal helper building history from `FinalReviewRow[]`
- `getDecisionAudit(snapshot, unitId)` — public API: builds a `DecisionAudit` from snapshot
- `isMergeEligible(snapshot, unitId)` — thin wrapper around `getDecisionAudit(...).mergeEligible`

**All exported symbols** (used by callers):
- `DecisionStatus` — imported in state.ts
- `DurableDecision` — not re-exported from index.ts
- `DecisionAudit` — imported in state.ts and ScheduledWorkflow.tsx
- `getDecisionAudit` — imported in state.test.ts and ScheduledWorkflow.tsx
- `isMergeEligible` — imported in state.test.ts only

**Anti-rubber-stamp logic**: detects when an "approval" after a rejection had no substantive
work in between — uses `hasSubstantiveWorkSince()` checking `implementRows`, `reviewFixRows`,
`testRows`. This entire logic is obsoleted by the ReviewLoop's structural exit condition.

---

### 2. `src/workflows/ralphinho/workflow/state.ts` — SIGNIFICANT CHANGES

**Current state (✓ VERIFIED)**:

**Types to remove**:
- `FinalReviewRow` (lines 31–38) — per-iteration final review DB row
- `finalReviewRawSchema` zod schema (lines 73–81)
- `finalReviewRowFromSqlite()` parser function (lines 82–93)

**Type to add**:
- `ReviewLoopResult` — parsed from the `review_loop_result` schema already defined in `schemas.ts`:
  ```typescript
  export type ReviewLoopResult = {
    nodeId: string;
    iterationCount: number;
    codeSeverity: "critical" | "major" | "minor" | "none";
    prdSeverity: "critical" | "major" | "minor" | "none";
    passed: boolean;
    exhausted: boolean;
  };
  ```
- `reviewLoopResultRawSchema` — Zod schema matching SQLite column names
- `reviewLoopResultRowFromSqlite()` parser

**`OutputSnapshot` type changes** (lines 161–172):
- Remove `latestFinalReview: (unitId: string) => FinalReviewRow | null`
- Remove `finalReviewHistory: (unitId: string) => FinalReviewRow[]`
- Add `latestReviewLoopResult: (unitId: string) => ReviewLoopResult | null`

**`SnapshotInput` type changes** (lines 232–238):
- Remove `finalReviewRows: FinalReviewRow[]`
- Add `reviewLoopResultRows: ReviewLoopResult[]`

**`buildOutputSnapshot()` changes** (lines 240–259):
- Remove `finalReviewByUnit` grouping
- Add `reviewLoopResultByUnit` grouping
- Remove `latestFinalReview` and `finalReviewHistory` from returned object
- Add `latestReviewLoopResult`

**`buildMergeTickets()` changes** (lines 346–389):
- Current signature: `(snapshot, units, runId, iteration, auditMap: Map<string, DecisionAudit>)`
- New signature: `(snapshot, units, runId, iteration)` — no `auditMap`
- Replace `!auditMap.get(unit.id)!.mergeEligible` with:
  ```typescript
  !snapshot.latestReviewLoopResult(unit.id)?.passed
  ```
- The eviction fallback branch (`!freshTest.buildPassed`) currently falls back to `auditMap.get(unit.id)!.mergeEligible` — replace with `snapshot.latestReviewLoopResult(unit.id)?.passed ?? false`
- `eligibilityProof` in returned tickets currently uses:
  - `audit.finalDecision?.iteration` → replace with `reviewLoopResult?.iterationCount ?? null`
  - `audit.finalDecision?.approvalSupersededRejection` → remove or replace with `false`

**`buildFailedUnitReport()` changes** (lines 290–344):
- Current signature: `(snapshot, units, auditMap, maxPasses, stageExists)`
- New signature: `(snapshot, units, maxPasses, stageExists)` — no `auditMap`
- Remove `DecisionAudit` import
- Remove lines that set reason based on `audit.status === "rejected"` and `audit.status === "invalidated"` (lines 331–337)
- Remove the `!auditMap.get(u.id)!.semanticallyComplete` filter — replace with `!snapshot.isUnitLanded(u.id)` OR use `snapshot.latestReviewLoopResult(u.id)?.passed !== true` for distinguishing

**`MergeQueueRow` type** (lines 10–21):
- The `ticketsLanded` array has `decisionIteration: number | null` and `approvalSupersededRejection: boolean` fields
- These are vestigial from decisions.ts and tied to the merge_queue schema in `schemas.ts`
- Review whether these should be replaced with `reviewLoopIterationCount: number | null` or just removed

**Import cleanup**:
- Remove `import type { DecisionAudit } from "./decisions"`

---

### 3. `src/workflows/ralphinho/components/ScheduledWorkflow.tsx` — CHANGES

**Current state (✓ VERIFIED)**:

**Imports to remove**:
- `import { type DecisionAudit, getDecisionAudit } from "../workflow/decisions"` (line 40)

**Computations to remove/replace**:
- `auditMap` (lines 88–90): entire Map computation using `getDecisionAudit`
- `unitAudit` (line 91): helper function
- `isSemanticComplete` (line 92): depends on `semanticallyComplete` from DecisionAudit

**Replace merge eligibility check** (line 138):
```tsx
// Old:
if (unitAudit(unit.id).mergeEligible && !unitEvictionContext(unit.id)) return null;

// New:
if (snapshot.latestReviewLoopResult(unit.id)?.passed && !unitEvictionContext(unit.id)) return null;
```

**Replace `done` condition** (line 100):
```tsx
// Old:
const done = currentPass >= maxPasses || allUnitsLanded || allUnitsSemanticallyComplete;

// New:
const done = currentPass >= maxPasses || allUnitsLanded || allUnitsReviewLoopComplete;
```

Where `allUnitsReviewLoopComplete` = `units.every(u => snapshot.isUnitLanded(u.id) || snapshot.latestReviewLoopResult(u.id)?.passed)` or similar.

**Update `buildFailedUnitReport` call** (lines 106–109):
- Remove `auditMap` parameter

**Update `buildMergeTickets` call** (lines 113–119):
- Remove `auditMap` parameter

**`semanticallyCompleteIds` / completion report**:
- Currently derived from `isSemanticComplete` = `unitAudit(unitId).semanticallyComplete`
- `semanticallyComplete` was defined as `isUnitLanded(unitId) && mergeEligible`
- Replace with: units that are landed AND had a passed ReviewLoopResult
- OR simplify further: units that are landed (since landing already implies review loop passed)

**No "rejected by final review" re-entry condition** (✓ VERIFIED):
- Confirmed: no outer-loop re-entry based on final review rejection exists in the current code
- The only re-entry condition is `unitEvictionContext` (merge conflict eviction) — this remains unchanged

---

### 4. `src/workflows/ralphinho/preset.tsx` — NO CHANGES NEEDED

**Current state (✓ VERIFIED)**:
- NO `finalReviewer` role exists in the `roles` object (lines 73–83)
- The `roles` satisfies `Record<keyof ScheduledWorkflowAgents, ...>` which has no `finalReviewer`
- This file is already clean — no changes required

---

### 5. `src/workflows/ralphinho/index.ts` — NO CHANGES NEEDED

**Current state (✓ VERIFIED)**:
- File does NOT re-export anything from `decisions.ts`
- No `DecisionStatus`, `DurableDecision`, `DecisionAudit`, `deriveDurableDecisionHistory`,
  `getDecisionAudit`, or `isMergeEligible` exports
- File is already clean — no changes required

---

### 6. `src/workflows/ralphinho/workflow/snapshot.ts` — CHANGES

**Current state (✓ VERIFIED)**:
- Reads `final_review` table: `ctxAny.outputs("final_review") as FinalReviewRow[]`
- Must change to read `review_loop_result` table instead

**Changes needed**:
- Replace `FinalReviewRow` import with `ReviewLoopResult`
- Replace `finalReviewRows: ctxAny.outputs("final_review") as FinalReviewRow[]` with
  `reviewLoopResultRows: ctxAny.outputs("review_loop_result") as ReviewLoopResult[]`

---

### 7. `src/workflows/ralphinho/workflow/__tests__/state.test.ts` — SIGNIFICANT CHANGES

**Current state (✓ VERIFIED)**:

**Imports to remove**:
- `import { getDecisionAudit, isMergeEligible } from "../decisions"`
- `import type { DecisionAudit } from "../decisions"`
- `type FinalReviewRow` from `../state`

**Test helpers to remove**:
- `finalReview()` helper function (builds `FinalReviewRow` for tests)
- `buildAuditMap()` helper function (calls `getDecisionAudit` per unit)

**`snapshot()` helper to update**:
- Remove `latestFinalReview: () => null` from defaults
- Remove `finalReviewHistory: () => []` from defaults
- Add `latestReviewLoopResult: () => null` to defaults

**Entire test suites to remove or replace**:
- `describe("isMergeEligible", ...)` — 3 tests using FinalReview rows → replace with ReviewLoopResult-based tests
- `describe("decision audits", ...)` — 2 tests for rubber-stamp detection → REMOVE entirely

**`buildMergeTickets` tests to update**:
- Remove `finalReview(...)` row overrides from all snapshots
- Remove `finalReviewHistory` overrides
- Replace `buildAuditMap(s, units)` with nothing (no 5th arg)
- Change merge eligibility source: use `latestReviewLoopResult: () => ({ ..., passed: true })`

**`buildFailedUnitReport`** — if tested, update call signature

---

### 8. `src/workflows/ralphinho/components/__tests__/ScheduledWorkflow.test.tsx` — MINOR CHANGES

**Current state (✓ VERIFIED)**:
- `createAgents()` returns agents WITHOUT `finalReviewer` — already clean
- Tests focus on `landingMode` (merge vs pr) — not on decision/review logic
- Tests call `ScheduledWorkflow(...)` directly which internally calls `buildMergeTickets` and `buildFailedUnitReport`
- When `auditMap` parameter is removed from `buildMergeTickets`/`buildFailedUnitReport`, no call-site changes needed in the test itself (those are internal to ScheduledWorkflow)
- The `createCtx()` returns `latest: () => null` which means `latestReviewLoopResult` will return null — tests will still pass since no units will be merge-eligible (same behavior as before)
- **No changes needed** unless `ScheduledWorkflowAgents` type changes

---

## Schema Context

### `review_loop_result` schema (✓ VERIFIED in schemas.ts lines 99–106)
```typescript
review_loop_result: z.object({
  iterationCount: z.number(),
  codeSeverity: z.enum(["critical", "major", "minor", "none"]),
  prdSeverity: z.enum(["critical", "major", "minor", "none"]),
  passed: z.boolean(),
  exhausted: z.boolean(),
}),
```

This schema is already present. `passed: true` is the structural guarantee that the ReviewLoop
exited with passing reviews. `exhausted: true` means the loop hit `maxReviewPasses` without
passing — unit should be marked failed.

### `final_review` — NOT in schemas.ts (✓ VERIFIED)
The `final_review` table was never added to `scheduledOutputSchemas`. It was a SQLite table
read at runtime by `snapshot.ts` from existing DB data. After removing `decisions.ts`, the
`snapshot.ts` must stop reading `final_review` and read `review_loop_result` instead.

---

## Key Invariants to Preserve

1. **Eviction recovery is unchanged**: `getEvictionContext()`, `isUnitEvicted()` remain intact.
   Units evicted from merge queue still re-enter QualityPipeline on the next outer iteration.

2. **Merge queue tickets still need fresh test validation for evicted units**: The logic in
   `buildMergeTickets` that checks `freshTest?.testsPassed` for evicted units stays.

3. **`MergeQueueRow.ticketsLanded` fields**: `decisionIteration` and `approvalSupersededRejection`
   are part of the merge_queue schema in `schemas.ts` — they may need adjustment in that schema
   and in how `buildMergeTickets` populates `eligibilityProof`.

4. **`isUnitLanded` logic**: Unchanged — reads from `mergeQueueRows`.

5. **Dependency scheduling**: `getUnitState()` unchanged.

---

## Dependency Graph of Changes

```
decisions.ts (DELETE)
  ├── state.ts (heavy changes)
  │     ├── snapshot.ts (update imports + table read)
  │     └── ScheduledWorkflow.tsx (remove auditMap usage)
  ├── state.test.ts (test updates)
  └── ScheduledWorkflow.test.tsx (minor/none)
```

`preset.tsx` and `index.ts` require no changes (already clean).

---

## Files Read

- `/Users/msaug/zama/super-ralph-lite/docs/plans/review-loop-refactor.md`
- `/Users/msaug/zama/super-ralph-lite/src/workflows/ralphinho/workflow/decisions.ts`
- `/Users/msaug/zama/super-ralph-lite/src/workflows/ralphinho/workflow/state.ts`
- `/Users/msaug/zama/super-ralph-lite/src/workflows/ralphinho/components/ScheduledWorkflow.tsx`
- `/Users/msaug/zama/super-ralph-lite/src/workflows/ralphinho/preset.tsx`
- `/Users/msaug/zama/super-ralph-lite/src/workflows/ralphinho/index.ts`
- `/Users/msaug/zama/super-ralph-lite/src/workflows/ralphinho/workflow/__tests__/state.test.ts`
- `/Users/msaug/zama/super-ralph-lite/src/workflows/ralphinho/components/__tests__/ScheduledWorkflow.test.tsx`
- `/Users/msaug/zama/super-ralph-lite/src/workflows/ralphinho/schemas.ts`
- `/Users/msaug/zama/super-ralph-lite/src/workflows/ralphinho/workflow/contracts.ts`
- `/Users/msaug/zama/super-ralph-lite/src/workflows/ralphinho/workflow/snapshot.ts`
- `/Users/msaug/zama/super-ralph-lite/src/workflows/ralphinho/components/QualityPipeline.tsx`
