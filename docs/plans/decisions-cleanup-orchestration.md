# Plan: Delete decisions.ts and Update State, Orchestration, and Exports

## Overview

Remove `decisions.ts` entirely and replace the complex `DecisionAudit` / `DurableDecision` / `isMergeEligible` machinery with a simple structural check on `review_loop_result` rows (`passed === true`). Units that exhaust their review loop passes are marked failed and not retried.

## Does TDD Apply?

**TDD does NOT apply.** This is primarily dead code removal and simplification:
- Deleting `decisions.ts` (dead code after migration)
- Removing `FinalReviewRow` type and parsing logic (replaced by `ReviewLoopResult`)
- Simplifying `buildMergeTickets()` and `buildFailedUnitReport()` (removing complex decision branches)
- Removing `finalReviewer` role (no new behavior, just removing a role)
- Removing `allUnitsSemanticallyComplete` from done condition (behavior simplification: exhausted = failed)

The compiler enforces correctness for type removals. Existing tests will be updated to match simplified signatures — they verify the same behavior (merge eligibility, failed unit reporting) with simpler inputs.

## Step-by-Step Changes

### Step 1: Add `review_loop_result` schema to `schemas.ts`

**File:** `src/workflows/ralphinho/schemas.ts`

Add new schema entry to `scheduledOutputSchemas`:

```typescript
// ── Review Loop Result ─────────────────────────────────────────────
review_loop_result: z.object({
  passed: z.boolean(),
  iteration: z.number(),
  summary: z.string(),
}),
```

Keep the existing `final_review` schema (backward compat with existing DBs).

### Step 2: Update `state.ts` — Remove FinalReview, Add ReviewLoopResult

**File:** `src/workflows/ralphinho/workflow/state.ts`

**Remove:**
- `import type { DecisionAudit } from "./decisions"` (line 8)
- `FinalReviewRow` type (lines 31–38)
- `finalReviewRawSchema` (lines 73–80)
- `finalReviewRowFromSqlite()` (lines 82–93)
- `OutputSnapshot.latestFinalReview` field (line 164)
- `OutputSnapshot.finalReviewHistory` field (line 168)
- `SnapshotInput.finalReviewRows` field (line 235)
- `buildOutputSnapshot()`: remove `finalReviewByUnit` grouping and `latestFinalReview`/`finalReviewHistory` methods

**Add:**
```typescript
export type ReviewLoopResult = {
  nodeId: string;
  iteration: number;
  passed: boolean;
  summary: string;
};
```

Add to `OutputSnapshot`:
```typescript
latestReviewLoopResult: (unitId: string) => ReviewLoopResult | null;
```

Add to `SnapshotInput`:
```typescript
reviewLoopResultRows: ReviewLoopResult[];
```

Update `buildOutputSnapshot()`:
- Group `reviewLoopResultRows` by unit
- Add `latestReviewLoopResult` accessor

**Update `buildMergeTickets()`:**
- Remove `auditMap: Map<string, DecisionAudit>` parameter (5th param)
- Replace eligibility check:
  ```typescript
  // OLD: if (!auditMap.get(unit.id)!.mergeEligible) return false;
  // NEW:
  const loopResult = snapshot.latestReviewLoopResult(unit.id);
  if (!loopResult?.passed) return false;
  ```
- Eviction recovery: replace `auditMap.get(unit.id)!.mergeEligible` with `snapshot.latestReviewLoopResult(unit.id)?.passed === true`
- Update `eligibilityProof` in ticket mapping:
  ```typescript
  eligibilityProof: {
    reviewLoopIteration: loopResult?.iteration ?? null,
    testIteration: latestTest?.iteration ?? null,
  },
  ```

**Update `buildFailedUnitReport()`:**
- Remove `auditMap: Map<string, DecisionAudit>` parameter (3rd param)
- Replace filter: `!auditMap.get(u.id)!.semanticallyComplete` → filter units that are NOT landed
- Remove `audit.status === "rejected"` branch (lines 332–334)
- Remove `audit.status === "invalidated"` branch (lines 335–339)
- Remove `isUnitLanded && !semanticallyComplete` branch (lines 340–342)
- Simplify reason classification to:
  - "Blocked: dependencies not landed" (unchanged)
  - "Did not complete within N passes" (unchanged)
  - "Evicted from merge queue: ..." (unchanged)
  - "Tests failing: ..." (unchanged)
  - Review loop result: if `loopResult?.passed === false`, add "Review loop did not pass"

### Step 3: Update `snapshot.ts` — Switch from final_review to review_loop_result

**File:** `src/workflows/ralphinho/workflow/snapshot.ts`

- Remove `FinalReviewRow` import
- Add `ReviewLoopResult` import from `./state`
- Replace `finalReviewRows: ctxAny.outputs("final_review") as FinalReviewRow[]` with `reviewLoopResultRows: ctxAny.outputs("review_loop_result") as ReviewLoopResult[]`

### Step 4: Update `ScheduledWorkflow.tsx` — Remove decision audit machinery

**File:** `src/workflows/ralphinho/components/ScheduledWorkflow.tsx`

**Remove:**
- `import { type DecisionAudit, getDecisionAudit } from "../workflow/decisions"` (line 40)
- `auditMap` construction (lines 88–90)
- `unitAudit()` helper (line 91)
- `isSemanticComplete()` helper (line 92)
- `allUnitsSemanticallyComplete` variable (line 99)
- `semanticallyCompleteIds` variable (line 105)
- `auditMap` argument to `buildFailedUnitReport()` (line 107)
- `auditMap` argument to `buildMergeTickets()` (line 118)
- `unitAudit(unit.id).mergeEligible` check in render loop (line 138) — replace with `snapshot.latestReviewLoopResult(unit.id)?.passed === true`

**Update:**
- `done` condition: remove `|| allUnitsSemanticallyComplete` — becomes `currentPass >= maxPasses || allUnitsLanded`
- Completion report `unitsSemanticallyComplete` field: replace with units that have `latestReviewLoopResult?.passed === true`
- Pass tracker `unitsComplete` / `unitsSemanticallyComplete`: same replacement

### Step 5: Update `QualityPipeline.tsx` — Remove finalReviewer from type

**File:** `src/workflows/ralphinho/components/QualityPipeline.tsx`

- Remove `finalReviewer: AgentLike | AgentLike[]` from `QualityPipelineAgents` type (line 42)
- Remove the entire `{tierHasStep(tier, "final-review") && ( <Task ... agent={agents.finalReviewer} ... /> )}` block (around lines 402–430+)
- Remove the `FinalReviewPrompt` import (line 15)

> **Note:** The `final_review` schema remains in `schemas.ts` for backward compat. The stage is removed from the pipeline; a future ReviewLoop component will produce `review_loop_result` rows instead.

### Step 6: Update `preset.tsx` — Remove finalReviewer role

**File:** `src/workflows/ralphinho/preset.tsx`

- Remove `finalReviewer: chooseAgent(...)` from `roles` (line 81)

### Step 7: Update `MergeQueueRow` type in `state.ts`

**File:** `src/workflows/ralphinho/workflow/state.ts`

Update `MergeQueueRow.ticketsLanded` to replace decision-specific fields:
```typescript
ticketsLanded: Array<{
  ticketId: string;
  mergeCommit: string | null;
  summary: string;
  reviewLoopIteration: number | null;  // was decisionIteration
  testIteration: number | null;
  // Remove approvalSupersededRejection
}>;
```

Also update the corresponding `merge_queue` schema in `schemas.ts` to match.

### Step 8: Delete `decisions.ts`

**File:** `src/workflows/ralphinho/workflow/decisions.ts` — DELETE

### Step 9: Check and update `index.ts` re-exports

**Files:** `src/workflows/ralphinho/index.ts`, `src/index.ts`

Per research, neither currently re-exports decisions.ts symbols. Verify and confirm — no changes expected. Remove `FinalReviewRow` re-export if present.

### Step 10: Update `state.test.ts`

**File:** `src/workflows/ralphinho/workflow/__tests__/state.test.ts`

**Remove:**
- `import { getDecisionAudit, isMergeEligible } from "../decisions"` (line 12)
- `import type { DecisionAudit } from "../decisions"` (line 13)
- `import type { FinalReviewRow } from "../state"` (line 9, if only used for final review helpers)
- `buildAuditMap` helper (lines 46–48)
- `finalReview` helper (lines 50–63)
- `describe("isMergeEligible", ...)` block (lines 181–212)
- `describe("decision audits", ...)` block (lines 393–437)

**Update `snapshot()` helper:**
- Remove `latestFinalReview: () => null` and `finalReviewHistory: () => []`
- Add `latestReviewLoopResult: () => null`

**Update `buildMergeTickets` tests:**
- Remove `buildAuditMap(s, units)` as last argument
- Replace `finalReview()` fixture overrides with `latestReviewLoopResult` overrides
- For "includes active, tier-complete units": set `latestReviewLoopResult: () => ({ nodeId: "u1:review-loop", iteration: 2, passed: true, summary: "ok" })`
- For "excludes units that are not tier complete": set `latestReviewLoopResult: () => ({ nodeId: "u1:review-loop", iteration: 1, passed: false, summary: "fail" })`
- Update expected `eligibilityProof` shape

### Step 11: Update `ScheduledWorkflow.test.tsx`

**File:** `src/workflows/ralphinho/components/__tests__/ScheduledWorkflow.test.tsx`

- Remove `finalReviewer: a` from `createAgents()` (line 52)

### Step 12: Update `snapshot.test.ts`

**File:** `src/workflows/ralphinho/workflow/__tests__/snapshot.test.ts`

- Replace `final_review: [...]` in `makeCtx` with `review_loop_result: [...]`
- Remove `latestFinalReview` assertion
- Add `latestReviewLoopResult` assertion

### Step 13: Verify

- `bun run typecheck` — must pass with no errors
- `bun test src/workflows/ralphinho/workflow/__tests__/state.test.ts` — must pass
- `bun test src/workflows/ralphinho/components/__tests__/ScheduledWorkflow.test.tsx` — must pass
- `bun test src/workflows/ralphinho/workflow/__tests__/snapshot.test.ts` — must pass
- Confirm `decisions.ts` does not exist

## Files to Create

None.

## Files to Modify

| File | Change Type |
|------|-------------|
| `src/workflows/ralphinho/schemas.ts` | Add `review_loop_result` schema, update `merge_queue` schema |
| `src/workflows/ralphinho/workflow/state.ts` | Remove FinalReviewRow + decisions import, add ReviewLoopResult, update functions |
| `src/workflows/ralphinho/workflow/snapshot.ts` | Switch from final_review to review_loop_result |
| `src/workflows/ralphinho/components/ScheduledWorkflow.tsx` | Remove decision audit machinery |
| `src/workflows/ralphinho/components/QualityPipeline.tsx` | Remove finalReviewer from type + final-review Task |
| `src/workflows/ralphinho/preset.tsx` | Remove finalReviewer role |
| `src/workflows/ralphinho/workflow/__tests__/state.test.ts` | Remove decision tests, update buildMergeTickets tests |
| `src/workflows/ralphinho/components/__tests__/ScheduledWorkflow.test.tsx` | Remove finalReviewer from createAgents() |
| `src/workflows/ralphinho/workflow/__tests__/snapshot.test.ts` | Switch to review_loop_result fixtures |

## Files to Delete

| File |
|------|
| `src/workflows/ralphinho/workflow/decisions.ts` |

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| `review_loop_result` schema shape may not match future ReviewLoop component output | Schema is minimal (`passed`, `iteration`, `summary`) — easy to extend later |
| Removing final-review Task from QualityPipeline may break other consumers | No external consumers found; QualityPipeline is only used by ScheduledWorkflow |
| `MergeQueueRow.ticketsLanded` schema change breaks existing DB data | Keep old field names as optional in schema or migrate data; for now this is a greenfield workflow |
| Tests may reference more decision-related fixtures than identified | Run full test suite and fix any remaining references |

## Acceptance Criteria Verification

| # | Criterion | Verified By |
|---|-----------|-------------|
| 1 | `decisions.ts` does not exist | Step 8: file deleted |
| 2 | `state.ts` does not import from `decisions.ts` | Step 2: import removed |
| 3 | `buildMergeTickets()` uses `review_loop_result` | Step 2: new eligibility check |
| 4 | `buildFailedUnitReport()` no rejected/invalidated refs | Step 2: branches removed |
| 5 | `preset.tsx` has no `finalReviewer` | Step 6: role removed |
| 6 | `index.ts` doesn't export decision types | Step 9: verified no-op |
| 7 | `bun run typecheck` passes | Step 13: verification |
| 8 | `state.test.ts` passes | Step 13: verification |
| 9 | `ScheduledWorkflow.test.tsx` passes | Step 13: verification |
