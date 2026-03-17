# Research: decisions-cleanup-orchestration

**Unit:** Delete decisions.ts and Update State, Orchestration, and Exports
**Category:** large

---

## Overview

This unit removes `decisions.ts` entirely and migrates all its consumers to a simpler model: merge eligibility is determined by a structural `review_loop_result` row with `passed=true`, replacing the complex `DecisionAudit` / `DurableDecision` / `isMergeEligible` machinery.

---

## Files to Modify

### 1. `src/workflows/ralphinho/workflow/decisions.ts` — DELETE ENTIRELY

**✓ VERIFIED** — Full content read.

Contains:
- `DecisionStatus` type (`"pending" | "rejected" | "approved" | "invalidated"`)
- `DurableDecision` type
- `DecisionAudit` type (with `mergeEligible`, `semanticallyComplete`, etc.)
- `deriveDurableDecisionHistory()` — internal function, inspects `FinalReviewRow` history
- `getDecisionAudit()` — public API, returns `DecisionAudit`
- `isMergeEligible()` — thin wrapper around `getDecisionAudit()`

**Action:** Delete the file.

---

### 2. `src/workflows/ralphinho/workflow/state.ts` — SIGNIFICANT CHANGES

**✓ VERIFIED** — Full content read.

#### Things to REMOVE:

| Item | Lines | Notes |
|------|-------|-------|
| `FinalReviewRow` type | 31–38 | Exported type |
| `finalReviewRawSchema` | 73–81 | Zod schema |
| `finalReviewRowFromSqlite()` | 82–93 | Parser function |
| `OutputSnapshot.latestFinalReview` | 165 | `(unitId: string) => FinalReviewRow \| null` |
| `OutputSnapshot.finalReviewHistory` | 168 | `(unitId: string) => FinalReviewRow[]` |
| `SnapshotInput.finalReviewRows` | 237 | Input field |
| `import type { DecisionAudit } from "./decisions"` | 8 | Import |
| `buildMergeTickets` `auditMap` param | 348–390 | Replaced with `ReviewLoopResult` check |
| `buildFailedUnitReport` `auditMap` param | 290–345 | Replaced with simpler pass/fail classification |

#### Things to ADD:

**`ReviewLoopResult` type** (parsed from `review_loop_result` schema):
```typescript
export type ReviewLoopResult = {
  nodeId: string;
  passed: boolean;
  // potentially: iteration, summary, etc. — depends on the schema shape
};
```

The schema must be added to `schemas.ts` as well (see below).

#### Function Signature Changes:

**`buildMergeTickets`** — remove `auditMap` parameter, replace eligibility check:
```typescript
// OLD:
if (!auditMap.get(unit.id)!.mergeEligible) return false;

// NEW (structural check):
const reviewLoopResult = snapshot.latestReviewLoopResult(unit.id);
if (!reviewLoopResult?.passed) return false;
```

Also update `eligibilityProof` shape in the return value — remove `decisionIteration`, `approvalSupersededRejection` fields (or adapt them).

**`buildFailedUnitReport`** — remove `auditMap` parameter, simplify classification:
```typescript
// OLD: checks semanticallyComplete via DecisionAudit
// NEW: classify as:
//   - "completed review loop" if review_loop_result.passed
//   - "exhausted max passes" if not
// Remove the "rejected by final review", "invalidated" reason branches
```

#### `OutputSnapshot` — update to add `ReviewLoopResult` queries:
```typescript
latestReviewLoopResult: (unitId: string) => ReviewLoopResult | null;
```

Remove `latestFinalReview` and `finalReviewHistory`.

#### `SnapshotInput` — remove `finalReviewRows`, add `reviewLoopResultRows`:
```typescript
export type SnapshotInput = {
  mergeQueueRows: MergeQueueRow[];
  testRows: TestRow[];
  reviewLoopResultRows: ReviewLoopResult[];  // NEW
  implementRows: ImplementRow[];
  reviewFixRows: ReviewFixRow[];
  // finalReviewRows: removed
};
```

---

### 3. `src/workflows/ralphinho/workflow/snapshot.ts` — UPDATE

**✓ VERIFIED** — Full content read.

Currently imports `FinalReviewRow` from `state` and passes `finalReviewRows` from `ctx.outputs("final_review")`.

**Changes:**
- Remove `FinalReviewRow` import
- Replace `finalReviewRows: ctxAny.outputs("final_review") as FinalReviewRow[]` with `reviewLoopResultRows: ctxAny.outputs("review_loop_result") as ReviewLoopResult[]`
- Import `ReviewLoopResult` from `state`

---

### 4. `src/workflows/ralphinho/schemas.ts` — ADD NEW SCHEMA

**✓ VERIFIED** — Full content read. `review_loop_result` schema does **not** exist yet.

Need to add:
```typescript
// ── Review Loop Result ─────────────────────────────────────────────
review_loop_result: z.object({
  passed: z.boolean(),
  // Add other fields as appropriate for the ReviewLoop component's output
}),
```

This schema is the source of truth for what `ReviewLoopResult` row contains.

---

### 5. `src/workflows/ralphinho/components/ScheduledWorkflow.tsx` — SIGNIFICANT CHANGES

**✓ VERIFIED** — Full content read.

#### Remove:
- `import { type DecisionAudit, getDecisionAudit } from "../workflow/decisions"` (line 40)
- `const auditMap = new Map<string, DecisionAudit>(...)` (lines 88–90)
- `const unitAudit = (unitId: string) => auditMap.get(unitId)!` (line 91)
- `const isSemanticComplete = (unitId: string) => unitAudit(unitId).semanticallyComplete` (line 92)
- `const allUnitsSemanticallyComplete = units.every((u) => isSemanticComplete(u.id))` (line 99)
- `const semanticallyCompleteIds = units.filter((u) => isSemanticComplete(u.id)).map(...)` (line 105)
- Pass `auditMap` to `buildMergeTickets()` (line 118) and `buildFailedUnitReport()` (line 107)
- `unitAudit(unit.id).mergeEligible` check in the render loop (line 138)

#### Replace:
- `done` condition: remove `allUnitsSemanticallyComplete` from OR clause — units that exhaust their review loop are marked failed, not retried
- Merge eligibility skip check: replace `unitAudit(unit.id).mergeEligible` with snapshot-based review loop result lookup
- `buildFailedUnitReport` / `buildMergeTickets` calls: remove `auditMap` argument
- Completion report `unitsSemanticallyComplete` field: either remove or replace with simpler "units with passed review loop" logic

#### Keep unchanged:
- Eviction recovery logic (re-entering QualityPipeline after merge conflict remains as-is)
- All other pipeline orchestration

#### Update type imports:
- Remove `type DecisionAudit` from `"../workflow/decisions"` import
- Update `buildMergeTickets` / `buildFailedUnitReport` call signatures

---

### 6. `src/workflows/ralphinho/preset.tsx` — REMOVE `finalReviewer`

**✓ VERIFIED** — Full content read.

```typescript
// REMOVE this entry from roles:
finalReviewer: chooseAgent(AGENT_OVERRIDE ?? "opus", "Final Reviewer — Decide if unit is complete"),

// The agents object is derived from roles, so it will be automatically cleaned up
```

Note: `roles` is typed as `Record<keyof ScheduledWorkflowAgents, ...>` via `satisfies`. Once `finalReviewer` is removed from `QualityPipelineAgents` (in QualityPipeline.tsx), this will type-check correctly.

Also note: `QualityPipelineAgents` in `QualityPipeline.tsx` currently has `finalReviewer` — removing from preset implies removing from the type too.

---

### 7. `src/index.ts` — CHECK RE-EXPORTS

**✓ VERIFIED** — Full content read.

`src/index.ts` exports from `./workflows/ralphinho`, which in turn exports from `ralphinho/index.ts`. The `ralphinho/index.ts` does NOT currently export from `decisions.ts`. Therefore:
- `DecisionStatus`, `DurableDecision`, `DecisionAudit`, `deriveDurableDecisionHistory`, `getDecisionAudit`, `isMergeEligible` are **NOT** re-exported via `src/index.ts`
- **No changes needed to `src/index.ts`** unless decisions.ts types were added there separately

The ticket says to "remove any re-exports of decisions.ts types" — currently none exist in index.ts or ralphinho/index.ts, so this is a no-op unless they get added before this unit runs.

---

### 8. `src/workflows/ralphinho/workflow/__tests__/state.test.ts` — UPDATE TESTS

**✓ VERIFIED** — Full content read.

Tests that must be **removed** (rely on decisions.ts):
- `describe("isMergeEligible", ...)` block (lines 181–212) — tests `isMergeEligible()` function
- `describe("decision audits", ...)` block (lines 393–437) — tests `getDecisionAudit()`, `isMergeEligible()`
- Import of `getDecisionAudit, isMergeEligible` from `"../decisions"` (line 12)
- Import of `type DecisionAudit` from `"../decisions"` (line 13)
- Import of `FinalReviewRow` from `"../state"` (line 9)
- `buildAuditMap` helper function (lines 46–48)
- `finalReview` helper function (lines 50–63) — used in final review tests

Tests that must be **updated**:
- `describe("buildMergeTickets", ...)` — currently uses `buildAuditMap(s, units)` as last arg; update to new signature without auditMap; test cases using `finalReview()` snapshots need to use `reviewLoopResult` snapshots instead
- `describe("buildFailedUnitReport", ...)` — if any such tests exist (not found in the file currently, but the function exists)

The `snapshot()` helper needs updating:
- Remove `latestFinalReview`, `finalReviewHistory` from the returned object
- Add `latestReviewLoopResult: () => null` (or the appropriate override)

---

### 9. `src/workflows/ralphinho/components/__tests__/ScheduledWorkflow.test.tsx` — UPDATE TESTS

**✓ VERIFIED** — Full content read.

Changes needed:
- Remove `finalReviewer` from `createAgents()` helper (line 53)
- No other decisions.ts references found — the test file doesn't directly test merge eligibility logic

---

### 10. `src/workflows/ralphinho/workflow/snapshot.test.ts` — UPDATE TESTS

**✓ VERIFIED** — Full content read.

In `snapshot.test.ts` (lines 20–33):
- The test passes `final_review` rows to `makeCtx` — remove this
- Replace with `review_loop_result` rows
- Update assertions to use `latestReviewLoopResult` instead of `latestFinalReview`

---

## Key Architecture Change

**Before (decisions.ts model):**
1. `QualityPipeline` runs inner loop (implement → test → code-review → review-fix → final-review)
2. `decisions.ts` inspects `FinalReviewRow` history to build a complex `DecisionAudit`
3. `isMergeEligible = finalDecision.status === "approved" && latestTest.testsPassed`
4. Units "rejected by final review" could re-enter the outer loop
5. The "invalidated" status handled approval-without-new-work edge cases

**After (review_loop_result model):**
1. `QualityPipeline` (or a new ReviewLoop wrapper) produces a `review_loop_result` row with `passed: boolean`
2. Merge eligibility = `review_loop_result.passed === true`
3. Units that exhaust max passes are marked **failed** and not retried
4. No outer-loop re-entry for "rejected by final review"
5. Eviction recovery (merge conflict → re-run QualityPipeline) remains unchanged

---

## Dependency Warning

The `review_loop_result` schema **does not yet exist** in `schemas.ts`. This unit depends on that schema being defined (either in this unit or a prior one). The `ReviewLoopResult` row type and `review_loop_result` Zod schema need to be added as part of this work.

---

## Files Read

- `src/workflows/ralphinho/workflow/decisions.ts` ✓
- `src/workflows/ralphinho/workflow/state.ts` ✓
- `src/workflows/ralphinho/workflow/snapshot.ts` ✓
- `src/workflows/ralphinho/workflow/contracts.ts` ✓
- `src/workflows/ralphinho/workflow/__tests__/state.test.ts` ✓
- `src/workflows/ralphinho/workflow/__tests__/contracts.test.ts` ✓
- `src/workflows/ralphinho/workflow/__tests__/snapshot.test.ts` ✓
- `src/workflows/ralphinho/components/ScheduledWorkflow.tsx` ✓
- `src/workflows/ralphinho/components/__tests__/ScheduledWorkflow.test.tsx` ✓
- `src/workflows/ralphinho/components/QualityPipeline.tsx` ✓
- `src/workflows/ralphinho/preset.tsx` ✓
- `src/workflows/ralphinho/schemas.ts` ✓
- `src/workflows/ralphinho/index.ts` ✓
- `src/index.ts` ✓
