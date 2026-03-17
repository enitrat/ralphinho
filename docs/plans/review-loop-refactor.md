# Plan: review-loop-refactor

## Overview

Replace the current single-pass `Final Review` gate with an **inner review loop** inside `QualityPipeline`. The loop iterates `Code Review + PRD Review → Review Fix → Test` until both reviews report severity ≤ minor. This eliminates the need for `Final Review` and removes the costly outer-loop retry (re-running the entire QualityPipeline when final review rejects).

### Current flow (per unit)

```
Large:  Research → Plan → Implement → Test → [PRD Review ‖ Code Review] → Review Fix → Final Review → Learnings
Small:  Implement → Test → Code Review → Review Fix → Final Review → Learnings
```

If Final Review rejects → unit re-enters QualityPipeline on the **next Ralph Loop iteration** (Implement/Test/Reviews all re-run).

### Proposed flow (per unit)

```
Large:  Research → Plan → Implement → ReviewLoop[ Test → [PRD Review ‖ Code Review] → Review Fix? ] → Learnings
Small:  Implement → ReviewLoop[ Test → Code Review → Review Fix? ] → Learnings
```

ReviewLoop exits when both reviews report severity ≤ minor (no critical/major). Review Fix is skipped if there's nothing to fix.

## Motivation

- **Tighter feedback loop**: Review issues are fixed immediately in the same worktree/branch, not after a full Ralph Loop iteration.
- **No wasted re-computation**: Currently, rejection by Final Review forces a full QualityPipeline re-run (including cached-but-still-invoked Research/Plan + fresh Implement/Test). The inner loop only re-runs Test + Reviews + Fix.
- **Simpler outer loop**: The Ralph Loop only handles dependency scheduling and merge queue eviction recovery — not review failures.
- **Remove Final Review**: Redundant when the review loop already guarantees quality before exit.
- **Remove decisions.ts anti-rubber-stamp logic**: The review loop provides a structural guarantee that work was done — no need for row-counting heuristics.

## Detailed Changes

### 1. Create `ReviewLoop` component

**File**: `src/workflows/ralphinho/components/ReviewLoop.tsx` (new)

A `<Ralph>` loop (or equivalent iteration primitive) that:
1. Runs `Test` stage
2. Runs `Code Review` (and `PRD Review` for large tier) in parallel
3. Evaluates exit condition: both reviews have `severity` ∈ `{none, minor}`
4. If exit → done, unit is merge-eligible
5. If not → runs `Review Fix`, then loops back to step 1

Props:
- `unit: WorkUnit` — the work unit being reviewed
- `agents` — reviewer/fixer/tester agents
- `maxReviewPasses?: number` — safety cap (default: 3-5) to avoid infinite loops
- `tier: "small" | "large"` — determines whether PRD review runs
- Context props: `baseBranch`, `repoConfig`, etc.

Output: structured result indicating pass/fail + final review scores.

**Exit condition logic**:
```typescript
const exitCondition = (codeReview, prdReview?) => {
  const codeSeverity = codeReview.severity; // "critical" | "major" | "minor" | "none"
  const prdSeverity = prdReview?.severity ?? "none";
  return codeSeverity !== "critical" && codeSeverity !== "major"
      && prdSeverity !== "critical" && prdSeverity !== "major";
};
```

**Safety cap**: If `maxReviewPasses` is reached without exit, mark unit as failed with "review loop exhausted" — do NOT send to merge queue.

### 2. Modify `QualityPipeline.tsx`

**File**: `src/workflows/ralphinho/components/QualityPipeline.tsx`

Replace the current linear sequence:
```
Test → [PRD Review ‖ Code Review] → Review Fix → Final Review → Learnings
```

With:
```
ReviewLoop[ Test → [PRD Review ‖ Code Review] → Review Fix? ] → Learnings
```

Specifically:
- Remove the `Test`, `PRD Review`, `Code Review`, `Review Fix`, and `Final Review` stage invocations
- Insert `<ReviewLoop>` after `Implement` (or after `Plan` for large tier)
- Keep `Learnings` as the final stage, fed by the ReviewLoop output
- Remove `finalReviewer` agent from the agent map (no longer needed)
- For Smithers to support Nested Ralph Loops, The <Ralph> component must be nested inside a <Sequence> component.

### 3. Update `contracts.ts`

**File**: `src/workflows/ralphinho/workflow/contracts.ts`

- Remove `"final-review"` from `StageName` union
- Remove `"final-review"` from both `TIER_STAGES.small` and `TIER_STAGES.large` pipeline definitions
- Consider adding `"review-loop"` as a meta-stage or keep individual stages tracked separately within the loop

### 4. Remove `decisions.ts`

**File**: `src/workflows/ralphinho/workflow/decisions.ts` (delete)

The entire module (`deriveDurableDecisionHistory`, `getDecisionAudit`, `isMergeEligible`) becomes unnecessary:
- **Merge eligibility** is now structural: a unit exits the review loop only when reviews pass → it's merge-eligible by construction
- **Anti-rubber-stamp** is unnecessary: the loop guarantees substantive review-fix work between iterations
- **Decision audit** tracking is no longer needed for the completion report

### 5. Update `state.ts` — merge eligibility

**File**: `src/workflows/ralphinho/workflow/state.ts`

- `buildMergeTickets()` currently calls `isMergeEligible()` from `decisions.ts`. Replace with a simpler check: unit completed ReviewLoop successfully (has a ReviewLoop completion row with passing status)
- `buildFailedUnitReport()` currently references decision audit statuses ("invalidated", "rejected"). Simplify to: unit either completed the review loop or didn't (exhausted max passes, or still in progress)
- Remove `FinalReviewRow` type and related query logic
- Add `ReviewLoopResult` row type if needed for tracking loop completion

### 6. Update `ScheduledWorkflow.tsx` — outer loop simplification

**File**: `src/workflows/ralphinho/components/ScheduledWorkflow.tsx`

- The outer Ralph Loop no longer needs to handle "rejected by final review" as a re-entry condition
- Units that exit their ReviewLoop successfully go straight to merge queue
- Units that exhaust their review loop max passes are marked failed (not retried in outer loop)
- Eviction from merge queue (conflicts) still triggers re-entry into QualityPipeline on the next outer iteration — this is unchanged

### 7. Remove `FinalReview.mdx` prompt

**File**: `src/workflows/ralphinho/prompts/FinalReview.mdx` (delete)

No longer needed. The review loop's exit condition replaces the final review gate.

### 8. Update `schemas.ts`

**File**: `src/workflows/ralphinho/schemas.ts`

- Remove `final_review` table/schema
- Add `review_loop_result` schema if needed (to track loop completion, iteration count, final severity scores)

### 9. Update `preset.tsx`

**File**: `src/workflows/ralphinho/preset.tsx`

- Remove `finalReviewer` agent creation
- Remove `finalReviewer` from the agent map passed to `ScheduledWorkflow`

### 10. Update `index.ts` exports

**File**: `src/workflows/ralphinho/index.ts`

- Remove any re-exports related to `decisions.ts` or final review types

## New flow diagram

```
┌─────────────────── Ralph Loop (outer, max 9 passes) ────────────────────┐
│                                                                          │
│  Phase 1: QualityPipeline (parallel per active unit)                     │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ Research* → Plan* → Implement →                                   │  │
│  │   ┌─── ReviewLoop (inner, max 3-5 passes) ───┐                   │  │
│  │   │ Test → [Code Review ‖ PRD Review*]        │                   │  │
│  │   │   └→ severity ≤ minor? → EXIT             │                   │  │
│  │   │   └→ else → Review Fix → ↩ loop           │                   │  │
│  │   └───────────────────────────────────────────┘                   │  │
│  │ → Learnings                                                       │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│  (* = large tier only, cached)                                           │
│                                                                          │
│  Phase 2: Merge Queue                                                    │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ Land merge-eligible tickets on base branch                        │  │
│  │ → Evicted? Re-enter with eviction context on next iteration       │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  Continue until: all landed OR all complete OR max passes                 │
└──────────────────────────────────────────────────────────────────────────┘
```

## What stays the same

- **Outer Ralph Loop**: Still handles dependency scheduling, merge queue, eviction recovery
- **Worktree isolation**: Each unit still works in its own git worktree
- **Research/Plan caching**: Still cached by input signature
- **Learnings extraction**: Still write-once per unit (now after review loop exit)
- **Merge Queue**: Unchanged — still rebases, lands, handles conflicts with eviction
- **Eviction recovery**: Unchanged — evicted units re-enter QualityPipeline with `evictionContext`

## Risk & mitigation

| Risk | Mitigation |
|------|------------|
| Infinite review loop (reviewer keeps finding issues) | `maxReviewPasses` safety cap (3-5), mark as failed if exhausted |
| Loss of audit trail without decisions.ts | ReviewLoop tracks iteration count and severity history in its output schema |
| Review Fix introduces regressions | Test re-runs after every Review Fix (inside the loop) |
| Losing the "substantive work" check | Structural guarantee: loop only exits after reviews pass, so work must have been done |

## Implementation order

### 11. Minor issues backlog — `docs/review-backlog/`

**Directory**: `docs/review-backlog/` (new)

When the ReviewLoop exits with severity = minor, those minor issues are **not fixed** (by design — they don't block merge). But they shouldn't be lost. The ReviewLoop persists them to disk so they can be triaged later.

**Format**: One markdown file per unit, written at ReviewLoop exit:
```
docs/review-backlog/{unitId}.md
```

**Content structure**:
```markdown
# Minor issues — {unit name}

**Unit**: {unitId}
**Branch**: {branchName}
**Review loop iterations**: {count}
**Date**: {timestamp}

## Code Review — minor issues

- [ ] {issue description} ({file}:{line})
- [ ] {issue description} ({file}:{line})

## PRD Review — minor issues

- [ ] {issue description} ({file}:{line})
```

Each issue is a checkbox so the team can track what's been addressed post-landing.

**Implementation**:
- At ReviewLoop exit, collect all issues with severity = minor from the final Code Review and PRD Review outputs
- Write them to `docs/review-backlog/{unitId}.md` via the agent (commit to the unit's branch)
- The file lands with the ticket when it goes through merge queue
- If a unit re-enters the loop (e.g. after eviction), the backlog file is overwritten with the latest minor issues

**Cleanup**: After a release or sprint, the team can delete resolved files or archive them.

## Implementation order

1. Create `ReviewLoop.tsx` component with exit condition logic
2. Update `QualityPipeline.tsx` to use `ReviewLoop` instead of linear stages
3. Update `contracts.ts` to remove `final-review` stage
4. Delete `decisions.ts` and `FinalReview.mdx`
5. Update `state.ts` merge eligibility logic
6. Update `schemas.ts` (remove final_review, add review_loop_result)
7. Update `preset.tsx` (remove finalReviewer agent)
8. Update `ScheduledWorkflow.tsx` outer loop logic
9. Update `index.ts` exports
10. Add minor issues backlog write step in ReviewLoop
11. Update tests (`decompose.test.ts`, `scheduler.test.ts`, any review-related tests)
