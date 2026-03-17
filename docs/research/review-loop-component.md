# Research: review-loop-component

**Unit**: review-loop-component
**Title**: Create ReviewLoop Component and Refactor QualityPipeline
**Category**: large
**Date**: 2026-03-17

---

## Summary

This unit creates `ReviewLoop.tsx` — an inner review loop component — and refactors `QualityPipeline.tsx` to use it instead of the current linear Test → PRD Review ‖ Code Review → Review Fix sequence. The loop iterates until both reviews report severity ≤ minor or `maxReviewPasses` is exhausted.

---

## RFC Reference

**File**: `/Users/msaug/zama/super-ralph-lite/docs/plans/review-loop-refactor.md`

### Key sections used:
- **§1 Create ReviewLoop component** — component location, props, exit condition logic
- **§2 Modify QualityPipeline.tsx** — stage replacement pattern
- **§7 Remove FinalReview.mdx prompt** — delete `src/workflows/ralphinho/prompts/FinalReview.mdx`
- **§11 Minor issues backlog** — `docs/review-backlog/{unitId}.md` write-on-exit format

---

## Files Read

| File | Purpose |
|------|---------|
| `src/workflows/ralphinho/components/QualityPipeline.tsx` | Current pipeline to refactor |
| `src/workflows/ralphinho/components/__tests__/QualityPipeline.test.tsx` | Tests to update |
| `src/workflows/ralphinho/components/ScheduledWorkflow.tsx` | Ralph loop nesting pattern |
| `src/workflows/ralphinho/workflow/contracts.ts` | StageName union, TIER_STAGES, retry policies |
| `src/workflows/ralphinho/schemas.ts` | Output schemas (review_loop_result already present) |
| `src/workflows/ralphinho/workflow/decisions.ts` | DecisionAudit, mergeEligible logic |
| `src/workflows/ralphinho/workflow/state.ts` | OutputSnapshot, row types, buildMergeTickets |
| `src/workflows/ralphinho/workflow/snapshot.ts` | buildSnapshot uses final_review table |
| `src/workflows/ralphinho/preset.tsx` | Agent configuration |
| `src/workflows/ralphinho/types.ts` | WorkUnit, WorkPlan schemas |
| `src/workflows/ralphinho/prompts/FinalReview.mdx` | File to delete |
| `src/types/smithers-orchestrator.d.ts` | Ralph, Sequence, Task, Parallel type signatures |
| `src/workflows/improvinho/components/ReviewSlicePipeline.tsx` | Sequence+Parallel pattern reference |

---

## Key Findings

### 1. Smithers Orchestrator Primitives (✓ VERIFIED)

From `src/types/smithers-orchestrator.d.ts`:

```typescript
export function Ralph(props: {
  children?: React.ReactNode;
  until: boolean;
  maxIterations: number;
  onMaxReached?: string;
}): React.ReactElement | null;

export function Sequence(props: { children?: React.ReactNode }): React.ReactElement | null;
export function Parallel(props: { children?: React.ReactNode; maxConcurrency?: number }): React.ReactElement | null;
```

**Critical constraint**: Per RFC §2 and confirmed in `ScheduledWorkflow.tsx` lines 122-128, `<Ralph>` MUST be nested inside `<Sequence>`:

```tsx
// ScheduledWorkflow.tsx pattern (lines 122-212):
<Sequence>
  <Ralph until={done} maxIterations={maxPasses * units.length * 20} onMaxReached="return-last">
    <Sequence>  {/* ← inner Sequence required by Smithers */}
      ...
    </Sequence>
  </Ralph>
  ...
</Sequence>
```

### 2. review_loop_result Schema (✓ VERIFIED — already in schemas.ts)

`src/workflows/ralphinho/schemas.ts` lines 99-107 already defines:

```typescript
review_loop_result: z.object({
  iterationCount: z.number(),
  codeSeverity: z.enum(["critical", "major", "minor", "none"]),
  prdSeverity: z.enum(["critical", "major", "minor", "none"]),
  passed: z.boolean(),
  exhausted: z.boolean(),
}),
```

No schema changes needed for the core loop result.

### 3. Current QualityPipeline Structure (✓ VERIFIED)

**File**: `src/workflows/ralphinho/components/QualityPipeline.tsx`

Current sequence (post-Implement):
- `Test` task (line 266-289)
- `Parallel` block with `prd-review` and `code-review` (lines 291-361)
- `review-fix` task with `skipIf={bothApproved}` (lines 363-396)
- `learnings` task depending on `stageNodeId(uid, "review-fix")` (lines 398-434)

**No `finalReviewer` agent in `QualityPipelineAgents` type** (lines 34-42) — it was already removed.

**No `final-review` in contracts.ts `StageName`** (lines 1-9) — already absent.

### 4. Pass Counter Pattern (✓ VERIFIED from ScheduledWorkflow.tsx)

The ScheduledWorkflow uses a compute Task (no agent) to track iteration count:

```typescript
// Read counter
const passTracker = ctx.latest("pass_tracker", PASS_TRACKER_NODE_ID);
const currentPass = passTracker?.totalIterations ?? 0;
const done = currentPass >= maxPasses || allDone;

// Inside loop: increment counter
<Task id={PASS_TRACKER_NODE_ID} output={outputs.pass_tracker}>
  {{ totalIterations: currentPass + 1, ... }}
</Task>
```

ReviewLoop should use `review_loop_result` as its per-pass counter with the node ID `${uid}:review-loop`.

### 5. Exit Condition Logic (from RFC §1)

```typescript
const exitCondition = (codeReview, prdReview?) => {
  const codeSeverity = codeReview?.severity ?? "none";
  const prdSeverity = prdReview?.severity ?? "none";
  return codeSeverity !== "critical" && codeSeverity !== "major"
      && prdSeverity !== "critical" && prdSeverity !== "major";
};
```

**Small tier**: PRD review is absent → `prdSeverity` defaults to `"none"`.

### 6. ReviewFix skipIf Pattern (✓ VERIFIED from QualityPipeline.tsx)

```typescript
// Current: skip if both reviews approved
const bothApproved = (prdReview?.approved ?? !tierHasStep(tier, "prd-review"))
                  && (codeReview?.approved ?? false);
skipIf={bothApproved}
```

For ReviewLoop, `skipIf` on ReviewFix should use the exit condition (severity ≤ minor), consistent with loop exit.

### 7. Learnings Dependency Change

**Current**: `learnings` task `dependsOn: [stageNodeId(uid, "review-fix")]`
**After refactor**: `learnings` task should depend on the ReviewLoop result node ID: `${uid}:review-loop`

### 8. Backlog File Write (RFC §11)

At ReviewLoop exit (when `passed: true`), write minor issues to `docs/review-backlog/{unitId}.md`:

```markdown
# Minor issues — {unit name}

**Unit**: {unitId}
**Branch**: {branchName}
**Review loop iterations**: {count}
**Date**: {timestamp}

## Code Review — minor issues
- [ ] {issue} ({file}:{line})

## PRD Review — minor issues
- [ ] {issue}
```

Implementation approach: This requires a file write, so it should use an **agent Task**. The agent is given the minor issues from final code_review and prd_review outputs and instructed to write the backlog markdown. An alternative is a compute task using the async callback form `() => Promise<Row>` which can use Node.js `fs.writeFile`. The RFC says "via the agent (commit to the unit's branch)" — this implies an agent Task, likely using the `reviewFixer` or a dedicated agent.

### 9. Contracts.ts — No final-review present (✓ VERIFIED)

`src/workflows/ralphinho/workflow/contracts.ts` current `StageName`:
```typescript
| "research" | "plan" | "implement" | "test"
| "prd-review" | "code-review" | "review-fix" | "learnings"
```

`final-review` is already absent. No change needed to `StageName` union for this unit.

**However**: adding `"review-loop"` as a meta-stage may be useful for display/tracking. The RFC says "Consider adding 'review-loop' as a meta-stage or keep individual stages tracked separately within the loop."

### 10. ScheduledWorkflow.tsx — decisions.ts dependency (⚠️ NOT this unit's scope)

`ScheduledWorkflow.tsx` currently calls `getDecisionAudit()` and `buildMergeTickets()` which use `decisions.ts`. This unit's scope (per the task description) is **only ReviewLoop.tsx + QualityPipeline.tsx + QualityPipeline.test.tsx + delete FinalReview.mdx**. The `decisions.ts` removal and `state.ts` / `ScheduledWorkflow.tsx` updates are separate units per RFC §3-10.

### 11. `buildIssueList` Helper (✓ VERIFIED — reusable from QualityPipeline.tsx)

```typescript
function buildIssueList(issues: Issue[] | null | undefined): string[] {
  if (!issues) return [];
  return issues.map((issue) => {
    const sev = issue.severity ? `[${issue.severity}] ` : "";
    const desc = issue.description ?? "Unspecified issue";
    const file = issue.file ? ` (${issue.file})` : "";
    return `${sev}${desc}${file}`;
  });
}
```

This helper is used in ReviewFix props and can be moved to ReviewLoop.tsx or imported.

---

## New File: ReviewLoop.tsx

**Path**: `src/workflows/ralphinho/components/ReviewLoop.tsx`

### Props

```typescript
export type ReviewLoopProps = {
  unit: WorkUnit;
  ctx: SmithersCtx<ScheduledOutputs>;
  outputs: ScheduledOutputs;
  agents: Pick<QualityPipelineAgents, "tester" | "prdReviewer" | "codeReviewer" | "reviewFixer">;
  fallbacks?: Partial<Pick<QualityPipelineFallbacks, "tester" | "prdReviewer" | "codeReviewer" | "reviewFixer">>;
  workPlan: WorkPlan;
  implOutput: /* implement output type */ any;
  maxReviewPasses?: number;    // default: 3
  branchPrefix?: string;
  verifyCommands: string[];
  testSuites: Array<{ name: string; command: string; description: string }>;
};
```

### Structure

```tsx
export function ReviewLoop({ unit, ctx, outputs, agents, fallbacks, workPlan,
  implOutput, maxReviewPasses = 3, branchPrefix = "unit/", verifyCommands, testSuites
}: ReviewLoopProps) {
  const uid = unit.id;
  const tier = unit.tier;

  // Read current state
  const reviewLoopResult = ctx.latest("review_loop_result", `${uid}:review-loop`);
  const iterationCount = reviewLoopResult?.iterationCount ?? 0;
  const codeReview = ctx.latest("code_review", stageNodeId(uid, "code-review"));
  const prdReview = ctx.latest("prd_review", stageNodeId(uid, "prd-review"));
  const reviewFix = ctx.latest("review_fix", stageNodeId(uid, "review-fix"));
  const test = ctx.latest("test", stageNodeId(uid, "test"));

  // Exit condition
  const codeSeverity = codeReview?.severity ?? "none";
  const prdSeverity = prdReview?.severity ?? "none";
  const exitConditionMet = codeSeverity !== "critical" && codeSeverity !== "major"
    && prdSeverity !== "critical" && prdSeverity !== "major"
    && codeReview != null;  // Only exit if reviews have actually run
  const exhausted = iterationCount >= maxReviewPasses;
  const done = exitConditionMet || exhausted;

  return (
    <Sequence>
      <Ralph until={done} maxIterations={maxReviewPasses * 10} onMaxReached="return-last">
        <Sequence>
          {/* Step 1: Test */}
          <Task id={stageNodeId(uid, "test")} output={outputs.test} agent={agents.tester} ...>
            <TestPrompt ... />
          </Task>

          {/* Step 2: Reviews in parallel */}
          <Parallel>
            {tierHasStep(tier, "prd-review") && <Task id={stageNodeId(uid, "prd-review")} ... />}
            <Task id={stageNodeId(uid, "code-review")} ... />
          </Parallel>

          {/* Step 3: ReviewFix — skip if exit condition met */}
          <Task id={stageNodeId(uid, "review-fix")} skipIf={exitConditionMet} ... />

          {/* Step 4: Update iteration counter */}
          <Task id={`${uid}:review-loop`} output={outputs.review_loop_result}>
            {{
              iterationCount: iterationCount + 1,
              codeSeverity: codeReview?.severity ?? "none",
              prdSeverity: prdReview?.severity ?? "none",
              passed: exitConditionMet,
              exhausted: false,
            }}
          </Task>
        </Sequence>
      </Ralph>

      {/* After loop: write minor issues backlog if passed */}
      {/* Agent task that writes docs/review-backlog/{unitId}.md */}
      ...
    </Sequence>
  );
}
```

---

## QualityPipeline.tsx Changes

Remove from QualityPipeline:
1. `TestPrompt` import
2. `PrdReviewPrompt` import
3. `CodeReviewPrompt` import
4. `ReviewFixPrompt` import
5. The Test `<Task>` block (lines 266-289)
6. The `<Parallel>` reviews block (lines 291-361)
7. The ReviewFix `<Task>` block (lines 363-396)
8. `bothApproved` computed variable
9. `prdReview`, `codeReview`, `reviewFix`, `test` `ctx.latest()` calls (or move into ReviewLoop)
10. `combinedReviewFeedback` (used by Implement prompt — keep but source from ReviewLoop if needed)

Add:
1. `import { ReviewLoop } from "./ReviewLoop"`
2. `<ReviewLoop>` component after `Implement` task
3. Update `learnings` task `dependsOn` to use `${uid}:review-loop`

**Note**: `combinedReviewFeedback` is currently used by the `Implement` task. After refactor, Implement is still before ReviewLoop, so this feedback would come from the PREVIOUS outer loop iteration, not the inner loop. This is correct behavior.

---

## QualityPipeline.test.tsx Changes

Current tests:
1. `"learnings depends on review-fix and final-review stage is absent"` — needs update since Learnings now depends on `review-loop` result
2. `"applies retry policy semantics..."` — tests for review/test stages may need update since they move to ReviewLoop
3. `"does not include a plan dependency for small-tier implement stage"` — unchanged

New tests needed:
1. ReviewLoop is rendered after Implement
2. ReviewLoop receives correct props (tier, maxReviewPasses, etc.)
3. Learnings depends on `${uid}:review-loop` node
4. No individual Test/PRD Review/Code Review/Review Fix tasks in QualityPipeline (they live in ReviewLoop)

---

## Implementation Constraints

1. **`<Ralph>` inside `<Sequence>`**: The Smithers constraint requires `<Ralph>` wrapped in `<Sequence>` — confirmed in ScheduledWorkflow.tsx lines 122-128
2. **`review_loop_result` schema exists**: No schema changes needed
3. **No `final-review` in contracts.ts**: Already absent — no change to StageName
4. **`FinalReview.mdx` to delete**: `src/workflows/ralphinho/prompts/FinalReview.mdx`
5. **ReviewLoop scope is ONLY this unit**: decisions.ts, state.ts, ScheduledWorkflow.tsx changes are separate units
6. **Learnings depends on ReviewLoop result**: Update `dependsOn` from `review-fix` to `${uid}:review-loop`

---

## File Paths Summary

| Action | Path |
|--------|------|
| CREATE | `src/workflows/ralphinho/components/ReviewLoop.tsx` |
| MODIFY | `src/workflows/ralphinho/components/QualityPipeline.tsx` |
| MODIFY | `src/workflows/ralphinho/components/__tests__/QualityPipeline.test.tsx` |
| DELETE | `src/workflows/ralphinho/prompts/FinalReview.mdx` |
| CREATE | `docs/review-backlog/` directory (created by ReviewLoop at runtime) |
