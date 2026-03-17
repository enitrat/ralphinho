# Research: decisions-cleanup-orchestration

**Unit:** Delete decisions.ts and Update State, Orchestration, and Exports
**Category:** large
**Status:** SUPERSEDED — All changes already landed on main

---

## Executive Summary

All work described in this ticket has already been implemented on main by two prior commits:
- `ylkwrxzs` — `feat(workflow): create review loop component and refactor quality pipeline`
- `usqqmvut` — `refactor(workflow): remove decisions module and use review-loop merge gating`

**There is no remaining delta to implement.** All files are already in their target state.

---

## Verified Current State (✓ VERIFIED — all files read)

### 1. `decisions.ts` — DELETED ✓
The file `src/workflows/ralphinho/workflow/decisions.ts` does **not exist**.
Directory listing confirms: only `contracts.ts`, `snapshot.ts`, `state.ts`, and `__tests__/` remain.

### 2. `src/workflows/ralphinho/workflow/state.ts` — FULLY UPDATED ✓

Current contents:
- `ReviewLoopResult` type (lines 29–34): `{ nodeId, iteration, passed, summary }`
- `reviewLoopResultRawSchema` + `reviewLoopResultRowFromSqlite()` (lines 69–85)
- `OutputSnapshot.latestReviewLoopResult` accessor present (line 156)
- **No** `FinalReviewRow`, `finalReviewRawSchema`, `finalReviewRowFromSqlite`
- **No** `DecisionAudit` import
- `SnapshotInput.reviewLoopResultRows: ReviewLoopResult[]` (line 226)
- **No** `finalReviewRows`
- `buildMergeTickets()` — uses `snapshot.latestReviewLoopResult(unit.id)?.passed`, no `auditMap` param
- `buildFailedUnitReport()` — uses `snapshot.latestReviewLoopResult(u.id)?.passed === false`, no `auditMap` param
- `MergeQueueRow.ticketsLanded` has `reviewLoopIteration: number | null` (not `decisionIteration`)

### 3. `src/workflows/ralphinho/schemas.ts` — FULLY UPDATED ✓

- `review_loop_result` schema present (lines 117–121): `{ passed, iteration, summary }`
- `merge_queue` schema uses `reviewLoopIteration: z.number().nullable()` (not `decisionIteration`)
- `final_review` schema retained for backward compat (lines 99–114)

### 4. `src/workflows/ralphinho/workflow/snapshot.ts` — FULLY UPDATED ✓

- Imports `ReviewLoopResult` from `./state`
- Passes `reviewLoopResultRows: ctxAny.outputs("review_loop_result") as ReviewLoopResult[]`
- **No** `FinalReviewRow` import, **no** `finalReviewRows`

### 5. `src/workflows/ralphinho/components/ScheduledWorkflow.tsx` — FULLY UPDATED ✓

- **No** import from `"../workflow/decisions"`
- Uses `snapshot.latestReviewLoopResult(unit.id)?.passed === true` for quality-complete check (line 130)
- `done` condition: `currentPass >= maxPasses || allUnitsLanded` — **no** `allUnitsSemanticallyComplete`
- `semanticallyCompleteIds` uses `snapshot.latestReviewLoopResult(u.id)?.passed === true` (line 97)
- `buildFailedUnitReport()` and `buildMergeTickets()` called without `auditMap`
- Eviction recovery unchanged

### 6. `src/workflows/ralphinho/components/QualityPipeline.tsx` — FULLY UPDATED ✓

`QualityPipelineAgents` type (lines 33–42):
- **No** `finalReviewer` field
- Roles: researcher, planner, implementer, tester, prdReviewer, codeReviewer, reviewFixer, learningsExtractor?
- **No** FinalReviewPrompt import
- **No** final-review Task block

### 7. `src/workflows/ralphinho/preset.tsx` — FULLY UPDATED ✓

`roles` map (lines 73–83):
- **No** `finalReviewer` entry
- 8 roles: researcher, planner, implementer, tester, prdReviewer, codeReviewer, reviewFixer, learningsExtractor, mergeQueue

### 8. `src/workflows/ralphinho/index.ts` — NO CHANGES NEEDED ✓

No decisions.ts exports were ever present. Current exports: components, types, schemas, domain logic. No `DecisionStatus`, `DurableDecision`, `DecisionAudit`, etc.

### 9. `src/index.ts` — NO CHANGES NEEDED ✓

Re-exports from `./workflows/ralphinho` — no decisions types present.

### 10. `state.test.ts` — FULLY UPDATED ✓

- Imports: `OutputSnapshot`, `ReviewLoopResult` from `../state` — **no** decisions imports
- `reviewLoopResult()` helper function (lines 25–33)
- `snapshot()` helper has `latestReviewLoopResult: () => null` (line 41)
- `buildMergeTickets` tests use `latestReviewLoopResult` overrides
- `eligibilityProof` shape: `{ reviewLoopIteration, testIteration }` (not `decisionIteration`)
- **No** `buildAuditMap`, **no** `finalReview` helper, **no** `isMergeEligible` tests, **no** `decision audits` describe block

### 11. `snapshot.test.ts` — FULLY UPDATED ✓

- Uses `review_loop_result: [{ nodeId: "u1:review-loop", iteration: 1, passed: true, summary: "ok" }]` in `makeCtx`
- Asserts `snapshot.latestReviewLoopResult("u1")` — **no** `latestFinalReview`

### 12. `ScheduledWorkflow.test.tsx` — FULLY UPDATED ✓

`createAgents()` returns 8 roles (researcher, planner, implementer, tester, prdReviewer, codeReviewer, reviewFixer, mergeQueue) — **no** `finalReviewer`.

---

## Eviction Root Cause Analysis

The merge queue eviction produced conflicts in:
- `state.ts`, `schemas.ts`, `snapshot.ts`, `snapshot.test.ts`, `state.test.ts` — because the landed commits made the same edits this ticket intended
- `ScheduledWorkflow.tsx`, `QualityPipeline.tsx` — same edits already applied
- `event-bridge.ts`, `AgenticMergeQueue.tsx` — likely unrelated naming differences (reviewLoopIterationCount vs reviewLoopIteration)

The semantic conflicts arose because:
1. The landed commits used `reviewLoopIteration` (simple noun) while this ticket's branch used potentially different variable names
2. Query patterns differed: main uses `snapshot.latestReviewLoopResult()` while the branch may have used `allReviewLoopRows.filter().at(-1)`

---

## Files Read

- `src/workflows/ralphinho/workflow/state.ts` ✓
- `src/workflows/ralphinho/schemas.ts` ✓
- `src/workflows/ralphinho/workflow/snapshot.ts` ✓
- `src/workflows/ralphinho/components/ScheduledWorkflow.tsx` ✓
- `src/workflows/ralphinho/components/QualityPipeline.tsx` ✓
- `src/workflows/ralphinho/preset.tsx` ✓
- `src/workflows/ralphinho/index.ts` ✓
- `src/index.ts` ✓
- `src/workflows/ralphinho/workflow/__tests__/state.test.ts` ✓
- `src/workflows/ralphinho/workflow/__tests__/snapshot.test.ts` ✓
- `src/workflows/ralphinho/components/__tests__/ScheduledWorkflow.test.tsx` ✓
- `docs/plans/decisions-cleanup-orchestration.md` ✓
- `docs/research/decisions-cleanup-orchestration.md` (prior version) ✓

---

## Action Required

**None.** The implementation is complete. The implementer agent for this unit should:
1. Verify `bun run typecheck` passes
2. Verify `bun test` passes for the relevant test files
3. Close the ticket as superseded/already-done
