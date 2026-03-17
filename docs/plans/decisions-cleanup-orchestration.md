# Plan: Delete decisions.ts and Update State, Orchestration, and Exports

**Unit**: decisions-cleanup-orchestration
**Date**: 2026-03-17

---

## Work Type Assessment

This is **primarily dead code removal and refactoring** with a **minor behavioral change**:

- **Dead code removal**: `decisions.ts` and all its types/functions (`DecisionStatus`, `DurableDecision`, `DecisionAudit`, `deriveDurableDecisionHistory`, `getDecisionAudit`, `isMergeEligible`) are deleted
- **Behavioral change**: Merge eligibility switches from `DecisionAudit.mergeEligible` (which required final-review approval + passing tests) to `ReviewLoopResult.passed` (structural exit from review loop). The new signal is semantically equivalent but uses a different data source.
- **Schema change**: `eligibilityProof` in `AgenticMergeQueueTicket` and `merge_queue` schema fields `decisionIteration`/`approvalSupersededRejection` become vestigial — updated to use `reviewLoopIterationCount`.

## TDD Applicability

**TDD does not fully apply.** The core work is removing dead code and re-wiring existing signals. The compiler (TypeScript typechecker) enforces most correctness. However, the `buildMergeTickets` and `buildFailedUnitReport` functions have behavioral tests that must be **updated** (not written first) to reflect the new eligibility source. This is a **test-update-alongside-implementation** pattern, not TDD.

---

## Step-by-Step Plan

### Step 1: Add `ReviewLoopResult` type and parser to `state.ts`

**File**: `src/workflows/ralphinho/workflow/state.ts`

Add after the `ReviewFixRow` type (line 57):

```typescript
export type ReviewLoopResultRow = {
  nodeId: string;
  iterationCount: number;
  codeSeverity: "critical" | "major" | "minor" | "none";
  prdSeverity: "critical" | "major" | "minor" | "none";
  passed: boolean;
  exhausted: boolean;
};
```

Add raw schema and parser after `reviewFixRowFromSqlite()`:

```typescript
const reviewLoopResultRawSchema = z.object({
  node_id: z.string(),
  iteration_count: z.number(),
  code_severity: z.string(),
  prd_severity: z.string(),
  passed: z.number(),
  exhausted: z.number(),
});

export function reviewLoopResultRowFromSqlite(row: Record<string, unknown>): ReviewLoopResultRow | null {
  const r = reviewLoopResultRawSchema.safeParse(row);
  if (!r.success) return null;
  return {
    nodeId: r.data.node_id,
    iterationCount: r.data.iteration_count,
    codeSeverity: r.data.code_severity as ReviewLoopResultRow["codeSeverity"],
    prdSeverity: r.data.prd_severity as ReviewLoopResultRow["prdSeverity"],
    passed: Boolean(r.data.passed),
    exhausted: Boolean(r.data.exhausted),
  };
}
```

### Step 2: Update `OutputSnapshot` type in `state.ts`

**File**: `src/workflows/ralphinho/workflow/state.ts`

In `OutputSnapshot` (lines 161–172):
- Remove `latestFinalReview: (unitId: string) => FinalReviewRow | null`
- Remove `finalReviewHistory: (unitId: string) => FinalReviewRow[]`
- Add `latestReviewLoopResult: (unitId: string) => ReviewLoopResultRow | null`

### Step 3: Update `SnapshotInput` and `buildOutputSnapshot()` in `state.ts`

**File**: `src/workflows/ralphinho/workflow/state.ts`

In `SnapshotInput` (lines 232–238):
- Remove `finalReviewRows: FinalReviewRow[]`
- Add `reviewLoopResultRows: ReviewLoopResultRow[]`

In `buildOutputSnapshot()` (lines 240–259):
- Remove `finalReviewByUnit` grouping
- Add `reviewLoopResultByUnit` grouping
- Remove `latestFinalReview` and `finalReviewHistory` from returned object
- Add `latestReviewLoopResult: (id) => latestRow(reviewLoopResultByUnit.get(id) ?? [])`

### Step 4: Remove `FinalReviewRow` type, schema, and parser from `state.ts`

**File**: `src/workflows/ralphinho/workflow/state.ts`

- Remove `FinalReviewRow` type (lines 31–38)
- Remove `finalReviewRawSchema` (lines 73–81)
- Remove `finalReviewRowFromSqlite()` (lines 82–93)
- Remove `import type { DecisionAudit } from "./decisions"`

### Step 5: Update `buildMergeTickets()` in `state.ts`

**File**: `src/workflows/ralphinho/workflow/state.ts`

- Remove `auditMap: Map<string, DecisionAudit>` parameter (5th arg)
- Replace `!auditMap.get(unit.id)!.mergeEligible` with `!snapshot.latestReviewLoopResult(unit.id)?.passed`
- Replace eviction fallback `auditMap.get(unit.id)!.mergeEligible` with `snapshot.latestReviewLoopResult(unit.id)?.passed ?? false`
- Update `eligibilityProof`:
  - `decisionIteration` → `snapshot.latestReviewLoopResult(unit.id)?.iterationCount ?? null`
  - `approvalSupersededRejection` → `false` (no longer relevant)

### Step 6: Update `buildFailedUnitReport()` in `state.ts`

**File**: `src/workflows/ralphinho/workflow/state.ts`

- Remove `auditMap: Map<string, DecisionAudit>` parameter (3rd arg)
- Replace filter `!auditMap.get(u.id)!.semanticallyComplete` with: units that are NOT landed AND don't have a passing review loop result:
  ```typescript
  .filter((u) => !(snapshot.isUnitLanded(u.id) && snapshot.latestReviewLoopResult(u.id)?.passed))
  ```
- Remove lines 331–338 that set reason based on `audit.status === "rejected"` and `audit.status === "invalidated"`
- Remove line 339 that checks `snapshot.isUnitLanded(u.id) && !auditMap.get(u.id)!.semanticallyComplete`

### Step 7: Update `snapshot.ts`

**File**: `src/workflows/ralphinho/workflow/snapshot.ts`

- Replace `FinalReviewRow` import with `ReviewLoopResultRow`
- Replace `finalReviewRows: ctxAny.outputs("final_review") as FinalReviewRow[]` with `reviewLoopResultRows: ctxAny.outputs("review_loop_result") as ReviewLoopResultRow[]`

### Step 8: Update `ScheduledWorkflow.tsx`

**File**: `src/workflows/ralphinho/components/ScheduledWorkflow.tsx`

- Remove import: `import { type DecisionAudit, getDecisionAudit } from "../workflow/decisions"`
- Remove `auditMap` computation (lines 88–90)
- Remove `unitAudit` helper (line 91)
- Remove `isSemanticComplete` helper (line 92)
- Replace `allUnitsSemanticallyComplete` (line 99):
  ```typescript
  const allUnitsReviewComplete = units.every(
    (u) => snapshot.isUnitLanded(u.id) || snapshot.latestReviewLoopResult(u.id)?.passed
  );
  ```
- Update `done` condition (line 100): use `allUnitsReviewComplete` instead of `allUnitsSemanticallyComplete`
- Replace `semanticallyCompleteIds` (line 105):
  ```typescript
  const reviewCompleteIds = units
    .filter((u) => snapshot.isUnitLanded(u.id) && (snapshot.latestReviewLoopResult(u.id)?.passed ?? false))
    .map((u) => u.id);
  ```
- Update `buildFailedUnitReport` call: remove `auditMap` arg
- Update `buildMergeTickets` call: remove `auditMap` arg
- Replace `unitAudit(unit.id).mergeEligible` (line 138) with `snapshot.latestReviewLoopResult(unit.id)?.passed`
- Update pass_tracker and completion_report references from `semanticallyCompleteIds` → `reviewCompleteIds`

### Step 9: Delete `decisions.ts`

**File**: `src/workflows/ralphinho/workflow/decisions.ts` — DELETE

### Step 10: Update `AgenticMergeQueueTicket` eligibilityProof

**File**: `src/workflows/ralphinho/components/AgenticMergeQueue.tsx`

Update `eligibilityProof` type:
- `decisionIteration: number | null` → `reviewLoopIterationCount: number | null` (rename)
- `approvalSupersededRejection: boolean` → remove or keep as `false` for backwards compat

Also update `merge_queue` schema in `schemas.ts`:
- `decisionIteration` → `reviewLoopIterationCount`
- Remove `approvalSupersededRejection` field

**Note**: This is a schema migration. If there's existing data in SQLite, this could break reads. Evaluate whether to keep old field names as aliases or do a clean rename. Since the schema defines the agent output format, and this is a new deployment, a clean rename is acceptable.

### Step 11: Update `MergeQueueRow` in `state.ts`

**File**: `src/workflows/ralphinho/workflow/state.ts`

Update `MergeQueueRow.ticketsLanded`:
- `decisionIteration: number | null` → `reviewLoopIterationCount: number | null`
- Remove `approvalSupersededRejection: boolean`

### Step 12: Update tests in `state.test.ts`

**File**: `src/workflows/ralphinho/workflow/__tests__/state.test.ts`

- Remove imports: `getDecisionAudit`, `isMergeEligible`, `DecisionAudit`, `FinalReviewRow`
- Remove `buildAuditMap()` helper
- Remove `finalReview()` helper
- Update `snapshot()` helper:
  - Remove `latestFinalReview: () => null`
  - Remove `finalReviewHistory: () => []`
  - Add `latestReviewLoopResult: () => null`
- Delete entire `describe("isMergeEligible", ...)` block (lines 181–212)
- Delete entire `describe("decision audits", ...)` block (lines 393–437)
- Update `buildMergeTickets` tests:
  - Replace `latestFinalReview`/`finalReviewHistory` overrides with `latestReviewLoopResult` returning `{ nodeId: "u1:review-loop-result", iterationCount: N, codeSeverity: "none", prdSeverity: "none", passed: true, exhausted: false }`
  - Remove `buildAuditMap(s, units)` as 5th arg to `buildMergeTickets`
  - Update expected `eligibilityProof` to use `reviewLoopIterationCount` instead of `decisionIteration`
  - Remove `approvalSupersededRejection` from expected output
- Update `MergeQueueRow` literals in test data: rename `decisionIteration` → `reviewLoopIterationCount`, remove `approvalSupersededRejection`

### Step 13: Verify `ScheduledWorkflow.test.tsx`

**File**: `src/workflows/ralphinho/components/__tests__/ScheduledWorkflow.test.tsx`

- Likely needs update to `createAgents()` if `ScheduledWorkflowAgents` type changed (it won't — only `QualityPipelineAgents` keys + `mergeQueue`)
- Verify `learningsExtractor` is handled (it's in `QualityPipelineAgents` but not in test's `createAgents()` — this may already be a pre-existing issue)
- Update `MergeQueueRow` field names if they appear in test fixtures (they don't — tests don't use merge queue rows directly)
- **Minimal changes expected** — mainly confirming the test still compiles and passes

### Step 14: Verify

1. `bun run typecheck` — no errors
2. `bun test src/workflows/ralphinho/workflow/__tests__/state.test.ts` — passes
3. `bun test src/workflows/ralphinho/components/__tests__/ScheduledWorkflow.test.tsx` — passes

---

## Files to Modify

| File | Change Type |
|------|-------------|
| `src/workflows/ralphinho/workflow/state.ts` | Heavy: add ReviewLoopResultRow, update OutputSnapshot, SnapshotInput, buildOutputSnapshot, buildMergeTickets, buildFailedUnitReport, MergeQueueRow; remove FinalReviewRow + related |
| `src/workflows/ralphinho/workflow/snapshot.ts` | Light: swap FinalReviewRow → ReviewLoopResultRow, swap table read |
| `src/workflows/ralphinho/components/ScheduledWorkflow.tsx` | Medium: remove DecisionAudit/auditMap usage, rewire eligibility checks |
| `src/workflows/ralphinho/components/AgenticMergeQueue.tsx` | Light: update eligibilityProof type |
| `src/workflows/ralphinho/schemas.ts` | Light: update merge_queue schema fields |
| `src/workflows/ralphinho/workflow/__tests__/state.test.ts` | Heavy: remove decision-related tests, update buildMergeTickets tests |
| `src/workflows/ralphinho/components/__tests__/ScheduledWorkflow.test.tsx` | Minimal: verify compiles, possibly add learningsExtractor |

## Files to Delete

| File |
|------|
| `src/workflows/ralphinho/workflow/decisions.ts` |

## Files Confirmed Clean (no changes needed)

| File | Reason |
|------|--------|
| `src/workflows/ralphinho/preset.tsx` | No finalReviewer role exists |
| `src/workflows/ralphinho/index.ts` | No decisions.ts re-exports |

---

## Risks and Mitigations

1. **Schema migration for `merge_queue`**: Renaming `decisionIteration` → `reviewLoopIterationCount` changes the SQLite schema. If existing workflow DBs are resumed, old rows will have the old field name. **Mitigation**: This is acceptable for a new deployment. For existing DBs, the `MergeQueueRow` type read from SQLite already uses snake_case → camelCase conversion, so the raw schema needs updating in tandem.

2. **`learningsExtractor` missing from test's `createAgents()`**: Pre-existing issue — the test creates agents without `learningsExtractor` which is part of `QualityPipelineAgents`. If the type is enforced, tests may fail. **Mitigation**: Check if this is already handled by `satisfies` or type assertion.

3. **`review_loop_result` table data availability**: The `review_loop_result` table must have rows for units to be merge-eligible. If a workflow was started before this change and has `final_review` rows but no `review_loop_result` rows, units will never become merge-eligible. **Mitigation**: This is expected — the review loop refactor (prior unit) already writes `review_loop_result` rows.

---

## Acceptance Criteria Verification

| # | Criterion | How Verified |
|---|-----------|-------------|
| 1 | decisions.ts does not exist | Step 9: file deleted |
| 2 | state.ts does not import from decisions.ts | Steps 4, 5, 6: import removed |
| 3 | buildMergeTickets uses review_loop_result | Step 5: `snapshot.latestReviewLoopResult(unit.id)?.passed` |
| 4 | buildFailedUnitReport no 'rejected'/'invalidated' | Step 6: removed audit.status branches |
| 5 | preset.tsx has no finalReviewer | Already clean — no changes |
| 6 | index.ts no decision exports | Already clean — no changes |
| 7 | typecheck passes | Step 14 |
| 8 | state.test.ts passes | Step 14 |
| 9 | ScheduledWorkflow.test.tsx passes | Step 14 |
