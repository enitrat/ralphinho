# Plan: Create ReviewLoop Component and Refactor QualityPipeline

**Unit**: review-loop-component
**Category**: large
**Date**: 2026-03-17

---

## Work Type Assessment

**TDD applies.** This unit adds a new component (`ReviewLoop.tsx`) with observable behavior (loop exit conditions, backlog file writing, exhaustion handling) and changes the QualityPipeline's rendered structure. Tests should be written first to lock down the expected component tree shape and behavior.

---

## Approach Overview

1. Create `ReviewLoop.tsx` — a Smithers component that wraps Test → Reviews ‖ → ReviewFix in a `<Ralph>` loop
2. Refactor `QualityPipeline.tsx` — replace the 4 individual stage invocations with a single `<ReviewLoop>` between Implement and Learnings
3. Update `QualityPipeline.test.tsx` — rewrite tests for the new structure
4. Delete `prompts/FinalReview.mdx`

The `<Ralph>` loop must be nested inside a `<Sequence>` per the Smithers constraint (verified in ScheduledWorkflow.tsx lines 122-128).

---

## Step-by-Step Implementation

### Step 1: Update QualityPipeline.test.tsx (TDD — tests first)

**File**: `src/workflows/ralphinho/components/__tests__/QualityPipeline.test.tsx`

Update existing tests and add new ones:

1. **Update** `"learnings depends on review-fix and final-review stage is absent"`:
   - Rename to `"learnings depends on review-loop result"`
   - Change expected `dependsOn` from `[stageNodeId(uid, "review-fix")]` to `["${uid}:review-loop"]`
   - Keep `final-review` absence assertion

2. **Add** `"QualityPipeline renders ReviewLoop between Implement and Learnings"`:
   - Render a large-tier pipeline
   - Walk the element tree to confirm `ReviewLoop` component is present
   - Confirm no direct Test, PRD Review, Code Review, or ReviewFix tasks exist at the QualityPipeline level
   - Confirm Implement task still exists

3. **Update** `"applies retry policy semantics..."`:
   - Remove assertions for `testTask` from QualityPipeline level (Test now lives inside ReviewLoop)
   - Keep Research, Plan, Implement assertions unchanged

4. **Add** `"small-tier QualityPipeline has no direct review stage tasks"`:
   - Render small-tier pipeline
   - Confirm no test/code-review/review-fix tasks at QualityPipeline level

### Step 2: Create ReviewLoop.tsx

**File**: `src/workflows/ralphinho/components/ReviewLoop.tsx`

#### Props

```typescript
export type ReviewLoopProps = {
  unit: WorkUnit;
  ctx: SmithersCtx<ScheduledOutputs>;
  outputs: ScheduledOutputs;
  agents: Pick<QualityPipelineAgents, "tester" | "prdReviewer" | "codeReviewer" | "reviewFixer">;
  fallbacks?: Partial<Pick<QualityPipelineFallbacks, "tester" | "prdReviewer" | "codeReviewer" | "reviewFixer">>;
  implOutput: { whatWasDone: string; filesCreated: string[]; filesModified: string[] } | null;
  testSuites: Array<{ name: string; command: string; description: string }>;
  verifyCommands: string[];
  branchPrefix?: string;
  maxReviewPasses?: number; // default: 3
};
```

#### Structure

```tsx
export function ReviewLoop({ unit, ctx, outputs, agents, fallbacks, implOutput,
  testSuites, verifyCommands, branchPrefix = "unit/", maxReviewPasses = 3,
}: ReviewLoopProps) {
  const uid = unit.id;
  const tier = unit.tier;

  // Read current loop state
  const reviewLoopResult = ctx.latest("review_loop_result", `${uid}:review-loop`);
  const iterationCount = reviewLoopResult?.iterationCount ?? 0;

  // Read review outputs from prior iteration
  const codeReview = ctx.latest("code_review", stageNodeId(uid, "code-review"));
  const prdReview = ctx.latest("prd_review", stageNodeId(uid, "prd-review"));
  const test = ctx.latest("test", stageNodeId(uid, "test"));

  // Exit condition: both reviews have severity ∈ {none, minor}
  const codeSeverity = codeReview?.severity ?? "none";
  const prdSeverity = prdReview?.severity ?? "none";
  const reviewsRanAtLeastOnce = codeReview != null;
  const exitConditionMet = reviewsRanAtLeastOnce
    && codeSeverity !== "critical" && codeSeverity !== "major"
    && prdSeverity !== "critical" && prdSeverity !== "major";
  const exhausted = iterationCount >= maxReviewPasses && !exitConditionMet;
  const done = exitConditionMet || exhausted;

  return (
    <Sequence>
      <Ralph until={done} maxIterations={maxReviewPasses * 10} onMaxReached="return-last">
        <Sequence>
          {/* Step 1: Test */}
          <Task id={stageNodeId(uid, "test")} output={outputs.test} agent={agents.tester} ...>
            <TestPrompt ... />
          </Task>

          {/* Step 2: Code Review ‖ PRD Review */}
          <Parallel>
            {tierHasStep(tier, "code-review") && <Task id={stageNodeId(uid, "code-review")} .../>}
            {tierHasStep(tier, "prd-review") && <Task id={stageNodeId(uid, "prd-review")} .../>}
          </Parallel>

          {/* Step 3: Review Fix — skip when exit condition met */}
          {tierHasStep(tier, "review-fix") && (
            <Task id={stageNodeId(uid, "review-fix")} skipIf={exitConditionMet} .../>
          )}

          {/* Step 4: Update loop counter */}
          <Task id={`${uid}:review-loop`} output={outputs.review_loop_result}>
            {{
              iterationCount: iterationCount + 1,
              codeSeverity,
              prdSeverity,
              passed: exitConditionMet,
              exhausted: iterationCount + 1 >= maxReviewPasses && !exitConditionMet,
            }}
          </Task>
        </Sequence>
      </Ralph>

      {/* After loop: write minor issues backlog if passed */}
      <Task
        id={`${uid}:review-backlog`}
        output={outputs.review_loop_result}
        agent={agents.reviewFixer}
        skipIf={!exitConditionMet || (codeSeverity === "none" && prdSeverity === "none")}
      >
        {/* Write docs/review-backlog/{uid}.md with minor issues as checkboxes */}
      </Task>
    </Sequence>
  );
}
```

Key details:
- `<Ralph>` is nested inside `<Sequence>` (Smithers constraint)
- Inner `<Sequence>` wraps the loop body
- Pass counter uses compute Task with `review_loop_result` schema (no agent needed)
- Backlog write task uses `reviewFixer` agent after loop exit
- `exitConditionMet` requires `codeReview != null` to prevent exiting before first review run

#### Helper functions to move from QualityPipeline.tsx

- `buildIssueList` — move to ReviewLoop.tsx (or a shared utils file)
- `tierHasStep` — already importable via contracts or recreate locally

### Step 3: Refactor QualityPipeline.tsx

**File**: `src/workflows/ralphinho/components/QualityPipeline.tsx`

#### Remove
1. Imports: `TestPrompt`, `PrdReviewPrompt`, `CodeReviewPrompt`, `ReviewFixPrompt`
2. `ctx.latest()` calls for: `test`, `prdReview`, `codeReview`, `reviewFix` (move to ReviewLoop)
3. `bothApproved` computed variable
4. The Test `<Task>` block (lines 266-289)
5. The `<Parallel>` reviews block (lines 291-361)
6. The ReviewFix `<Task>` block (lines 363-396)

#### Add
1. Import: `import { ReviewLoop } from "./ReviewLoop"`
2. After the Implement `<Task>` (line 264), insert:

```tsx
<ReviewLoop
  unit={unit}
  ctx={ctx}
  outputs={outputs}
  agents={{
    tester: agents.tester,
    prdReviewer: agents.prdReviewer,
    codeReviewer: agents.codeReviewer,
    reviewFixer: agents.reviewFixer,
  }}
  fallbacks={fallbacks ? {
    tester: fallbacks.tester,
    prdReviewer: fallbacks.prdReviewer,
    codeReviewer: fallbacks.codeReviewer,
    reviewFixer: fallbacks.reviewFixer,
  } : undefined}
  implOutput={impl}
  testSuites={testSuites}
  verifyCommands={verifyCommands}
  branchPrefix={branchPrefix}
/>
```

#### Update
1. Learnings `meta.dependsOn`: change from `[stageNodeId(uid, "review-fix")]` to `["${uid}:review-loop"]`
2. Learnings props: `codeReview` and `prdReview` references need to be read from `ctx.latest()` locally (keep those two calls for Learnings use), OR pass ReviewLoop result to Learnings

**Note on `combinedReviewFeedback`**: Currently used by Implement prompt for re-implementation on outer-loop passes. The `ctx.latest()` for `prdReview`/`codeReview` in QualityPipeline can still work because ReviewLoop writes to the same node IDs (`stageNodeId(uid, "code-review")` etc.). Keep `prdReview`/`codeReview` ctx.latest reads in QualityPipeline for `combinedReviewFeedback` and Learnings.

### Step 4: Delete FinalReview.mdx

**File**: `src/workflows/ralphinho/prompts/FinalReview.mdx` — DELETE

### Step 5: Verify

1. `bun run typecheck` — must pass with no errors
2. `bun test src/workflows/ralphinho/components/__tests__/QualityPipeline.test.tsx` — must pass

---

## Files Summary

| Action | Path |
|--------|------|
| CREATE | `src/workflows/ralphinho/components/ReviewLoop.tsx` |
| MODIFY | `src/workflows/ralphinho/components/QualityPipeline.tsx` |
| MODIFY | `src/workflows/ralphinho/components/__tests__/QualityPipeline.test.tsx` |
| DELETE | `src/workflows/ralphinho/prompts/FinalReview.mdx` |

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| **Smithers Ralph nesting**: If `<Ralph>` isn't in `<Sequence>`, runtime fails silently | Verified pattern from ScheduledWorkflow.tsx; tests will catch tree shape |
| **Node ID conflicts**: ReviewLoop reuses same stage node IDs (test, code-review, etc.) — outer-loop ctx.latest reads them | This is intentional — same IDs allow ScheduledWorkflow pass_tracker to track progress |
| **Backlog file write**: Agent Task for writing `docs/review-backlog/{uid}.md` may fail | Use `continueOnFail` on backlog task — it's non-critical |
| **Learnings props**: Learnings task reads review data that now lives inside ReviewLoop | Keep `ctx.latest` calls for prdReview/codeReview in QualityPipeline since they read from same node IDs |
| **Exhaustion semantics**: Exhausted loop must return failed result, not passed | Counter task computes `exhausted` flag; test will verify |

---

## Acceptance Criteria Verification

| # | Criterion | How Verified |
|---|-----------|-------------|
| 1 | ReviewLoop.tsx exists at correct path | File creation |
| 2 | Exits when both severities ≤ minor | Unit test: mock ctx with minor severities, verify `done=true` |
| 3 | Exits failed when maxReviewPasses exhausted | Unit test: mock ctx with major severity after N passes |
| 4 | Writes docs/review-backlog/{unitId}.md | Agent task with backlog write prompt; verify task renders with correct props |
| 5 | QualityPipeline has no direct Test/Review stages | Unit test: collectTasks on pipeline, assert absence |
| 6 | QualityPipeline renders ReviewLoop between Implement and Learnings | Unit test: walk tree, verify order |
| 7 | Ralph wrapped in Sequence | Code inspection + tree walk test |
| 8 | FinalReview.mdx deleted | `rm` + glob check |
| 9 | `bun run typecheck` passes | Run typecheck |
| 10 | QualityPipeline.test.tsx passes | Run bun test |
