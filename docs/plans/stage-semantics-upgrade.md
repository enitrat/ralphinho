# Plan: Upgrade Per-Stage Retry, Cache, and Dependency Semantics

**Unit:** `stage-semantics-upgrade`
**Category:** large
**Work type:** Mechanical refactoring (no new behavior)

---

## TDD Applicability

**TDD does NOT apply.** Justification:

1. All changes replace one constant value with another on the same `retries` prop — no new code paths
2. Adding `meta` props is documentation-only (Smithers ignores unknown meta keys at runtime)
3. Cache semantics are already enforced by existing `skipIf` guards — we're adding comments, not code
4. The TypeScript compiler enforces correctness (`retries` accepts `number`, constants are `number`)
5. No existing tests for `QualityPipeline` rendering exist to break or extend

**Verification:** `bun run typecheck` + manual review of constants.

---

## Overview

Replace the uniform `retries={retries}` prop threaded from `ScheduledWorkflow` through `QualityPipeline` with stage-specific named constants from `contracts.ts`. Add `meta.dependsOn` annotations for logical dependency documentation. Clarify cache semantics via code comments on `skipIf` guards.

### Smithers API Constraints (verified)

| Feature | Support | Our approach |
|---------|---------|--------------|
| `retries: number` | Yes | Named constants per stage |
| Retry backoff | No | Document intent via constant names/comments |
| Per-task cache | No (workflow-level only) | Document `skipIf` as functional cache equivalent |
| `dependsOn` | No (not in TaskProps) | Use `meta={{ dependsOn: [...] }}` for documentation |

---

## Step-by-Step Changes

### Step 1: Add retry constants to `contracts.ts`

**File:** `src/workflow/contracts.ts`

Add after the existing `DISPLAY_STAGES` export:

```typescript
// ── Per-Stage Retry Constants ─────────────────────────────────────
// Smithers semantics: retries=N means N+1 total attempts.
// Backoff is not supported by the Smithers scheduler; constant names
// communicate intent for future engine upgrades.

/** Research/Plan: 3 total attempts. Protects against agent timeouts
 *  and malformed JSON on context-gathering stages. */
export const RESEARCH_RETRIES = 2;
export const PLAN_RETRIES = 2;

/** Implement: fail fast. Re-running on a partially mutated worktree
 *  can corrupt context. 1 retry = 2 total attempts max. */
export const IMPLEMENT_RETRIES = 1;

/** Test: 3 total attempts. Retries protect against flaky CI,
 *  transient network failures, and intermittent test infra issues. */
export const TEST_RETRIES = 2;

/** Reviews: idempotent read-only stages. 1 retry is sufficient. */
export const REVIEW_RETRIES = 1;

/** Review-fix: stateful (commits changes). Keep retries low. */
export const REVIEW_FIX_RETRIES = 1;

/** Final review: read-only gate. 1 retry. */
export const FINAL_REVIEW_RETRIES = 1;

/** Merge queue: 3 total attempts for transient VCS/push failures. */
export const MERGE_QUEUE_RETRIES = 2;
```

### Step 2: Update `QualityPipeline.tsx` — imports

**File:** `src/components/QualityPipeline.tsx`

Update the `contracts` import to include new constants:

```typescript
import {
  stageNodeId,
  TIER_STAGES,
  RESEARCH_RETRIES,
  PLAN_RETRIES,
  IMPLEMENT_RETRIES,
  TEST_RETRIES,
  REVIEW_RETRIES,
  REVIEW_FIX_RETRIES,
  FINAL_REVIEW_RETRIES,
} from "../workflow/contracts";
```

### Step 3: Update `QualityPipeline.tsx` — replace uniform retries

Replace each `retries={retries}` with the stage-specific constant:

| Task | Old | New |
|------|-----|-----|
| research | `retries={retries}` | `retries={RESEARCH_RETRIES}` |
| plan | `retries={retries}` | `retries={PLAN_RETRIES}` |
| implement | `retries={retries}` | `retries={IMPLEMENT_RETRIES}` |
| test | `retries={retries}` | `retries={TEST_RETRIES}` |
| prd-review | `retries={retries}` | `retries={REVIEW_RETRIES}` |
| code-review | `retries={retries}` | `retries={REVIEW_RETRIES}` |
| review-fix | `retries={retries}` | `retries={REVIEW_FIX_RETRIES}` |
| final-review | `retries={retries}` | `retries={FINAL_REVIEW_RETRIES}` |

### Step 4: Update `QualityPipeline.tsx` — add `meta.dependsOn` annotations

Add `meta` prop to each Task documenting its logical dependencies:

- `research`: no `meta.dependsOn` (entry point)
- `plan`: `meta={{ dependsOn: [stageNodeId(uid, "research")] }}`
- `implement`: `meta={{ dependsOn: [stageNodeId(uid, "plan")] }}`
- `test`: `meta={{ dependsOn: [stageNodeId(uid, "implement")] }}`
- `prd-review`: `meta={{ dependsOn: [stageNodeId(uid, "implement")] }}`
- `code-review`: `meta={{ dependsOn: [stageNodeId(uid, "implement")] }}`
- `review-fix`: `meta={{ dependsOn: [stageNodeId(uid, "prd-review"), stageNodeId(uid, "code-review")] }}`
- `final-review`: `meta={{ dependsOn: [stageNodeId(uid, "review-fix")] }}`

### Step 5: Update `QualityPipeline.tsx` — cache comments on skipIf

Add clarifying comments on the `skipIf` props for research and plan:

```tsx
// Cache semantics: skipIf acts as a per-task cache — if prior output
// exists (from a previous pass or resumed run), skip re-execution.
skipIf={!!research}
```

And on implement/test/review stages, add a comment noting cache is intentionally disabled:

```tsx
// No cache: implement must always re-run to incorporate review feedback
```

### Step 6: Remove `retries` prop from `QualityPipelineProps`

**File:** `src/components/QualityPipeline.tsx`

Remove `retries?: number` from the `QualityPipelineProps` type and from the function destructuring. This is now dead code since each Task uses its own constant.

### Step 7: Remove `retries` threading from `ScheduledWorkflow.tsx`

**File:** `src/components/ScheduledWorkflow.tsx`

Remove the `retries={retries}` prop from the `<QualityPipeline>` JSX element. Keep the `retries` prop on `ScheduledWorkflowProps` for now (it's still used by other potential consumers; removal can be a follow-up).

### Step 8: Update `AgenticMergeQueue.tsx` — use named constant

**File:** `src/components/AgenticMergeQueue.tsx`

Import `MERGE_QUEUE_RETRIES` from contracts and replace `retries={2}` with `retries={MERGE_QUEUE_RETRIES}`.

### Step 9: Verify

Run `bun run typecheck` to confirm no type errors.

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/workflow/contracts.ts` | Add 8 retry constant exports |
| `src/components/QualityPipeline.tsx` | Replace uniform retries, add meta.dependsOn, add cache comments, remove retries prop |
| `src/components/AgenticMergeQueue.tsx` | Import and use `MERGE_QUEUE_RETRIES` |
| `src/components/ScheduledWorkflow.tsx` | Remove `retries={retries}` from QualityPipeline JSX |

## Files to Create

None.

---

## Acceptance Criteria Verification

| # | Criterion | How Verified |
|---|-----------|--------------|
| 1 | No Task uses bare `retries` prop | Grep for `retries={retries}` in QualityPipeline returns 0 matches |
| 2 | Research/plan have cache config | `skipIf` guards present with clarifying cache-semantics comments |
| 3 | Implement/test/review/merge have cache disabled | No `skipIf` on those stages + explicit "no cache" comments |
| 4 | Implement/test retryPolicy differs from research/plan | `IMPLEMENT_RETRIES=1` vs `RESEARCH_RETRIES=2` (verified by constant values) |
| 5 | Node IDs use builders from contracts.ts | Already true (`stageNodeId` imported from contracts); no inline template literals |
| 6 | `bun run typecheck` passes | Run after all changes |

---

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Removing `retries` prop breaks other consumers of `QualityPipeline` | Low — only `ScheduledWorkflow` consumes it | Grep for all `<QualityPipeline` usages before removing |
| Wrong retry count causes stage to fail too eagerly | Low — values match research recommendations | Constants are easily adjustable; document Smithers semantics |
| `meta` prop causes unexpected Smithers behavior | Very low — `meta` is `Record<string, unknown>`, passed through without interpretation | Verified in Smithers source: meta is stored but not acted on |

---

## Node ID Acceptance Note

Acceptance criterion 5 requires node IDs use builders from `contracts.ts`. This is **already satisfied** — `stageNodeId()` is imported and used for every Task ID. No inline template literals like `` `${unitId}:research` `` exist in the current code. No change needed for this criterion.
