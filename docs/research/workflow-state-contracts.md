# Research: Workflow State Contracts

**Unit:** `workflow-state-contracts`
**Phase:** Phase 2 — Extract Workflow State Contracts from ScheduledWorkflow

---

## Summary

This unit extracts inline state-selector logic from `ScheduledWorkflow.tsx` into two new modules:

- **`src/workflow/state.ts`** — Pure, typed selector functions operating on typed output snapshots
- **`src/workflow/contracts.ts`** — Centralized node ID assembly, stage name constants, and per-tier stage lists

The goal is to make these functions testable without Smithers, eliminate duplicated `TIER_STAGES` constants, and replace all inline `ctx.outputs()` scanning in `ScheduledWorkflow.tsx`.

---

## Files Analyzed

### `src/components/ScheduledWorkflow.tsx`
The main orchestrator. Contains all inline state selectors as closures that close over `ctx` (SmithersCtx). These need to be extracted as pure functions.

**Functions to extract:**

| Current name | Proposed exported name | Description |
|---|---|---|
| `unitLanded(unitId)` | (internal helper, replaced by `isUnitLanded`) | Checks latest merge_queue output only |
| `unitLandedAcrossIterations(unitId)` | `isUnitLanded(outputs, unitId)` | Scans ALL merge_queue rows |
| `unitEvicted(unitId)` | `isUnitEvicted(outputs, unitId)` | Scans ALL merge_queue rows for eviction |
| `getEvictionContext(unitId)` | `getEvictionContext(outputs, unitId)` | Returns latest eviction details string |
| `getUnitState(unitId)` | `getUnitState(outputs, units, unitId)` | Returns "done" / "not-ready" / "active" |
| `tierComplete(ctx, _units, unitId)` | `isTierComplete(outputs, unitId)` | Checks test+final_review outputs |
| `buildDepSummaries(unit)` | `buildDepSummaries(outputs, unit)` | Builds DepSummary[] from implement outputs |
| `buildMergeTickets()` | `buildMergeTickets(outputs, units, ctx)` | Builds AgenticMergeQueueTicket[] |

**Key pattern:** All functions currently close over `ctx: SmithersCtx<ScheduledOutputs>`. The refactor changes them to accept typed output snapshots directly, removing the Smithers dependency.

**Node ID patterns found in ScheduledWorkflow.tsx:**
- `${unitId}:research` — research stage
- `${unitId}:plan` — plan stage
- `${unitId}:implement` — implement stage
- `${unitId}:test` — test stage
- `${unitId}:prd-review` — PRD review stage
- `${unitId}:code-review` — code review stage
- `${unitId}:review-fix` — review fix stage
- `${unitId}:final-review` — final review stage
- `"merge-queue"` — singleton merge queue node
- `"pass-tracker"` — singleton pass tracker node

---

### `src/scheduled/types.ts`
Defines `SCHEDULED_TIERS` constant:

```typescript
export const SCHEDULED_TIERS = {
  small: ["implement", "test", "code-review", "review-fix", "final-review"] as const,
  large: ["research", "plan", "implement", "test", "prd-review", "code-review", "review-fix", "final-review"] as const,
} as const;

export type ScheduledTier = keyof typeof SCHEDULED_TIERS;
```

Also defines `WorkUnit` (id, name, rfcSections, description, deps, acceptance, tier) and `WorkPlan` (source, generatedAt, repo, units).

---

### `src/advanced-monitor-ui.ts`
Contains a **duplicate** of `TIER_STAGES` at line 31–34:

```typescript
const TIER_STAGES: Record<string, readonly string[]> = {
  small:   ["implement", "test", "code-review", "review-fix", "final-review"],
  large:   ["research", "plan", "implement", "test", "prd-review", "code-review", "review-fix", "final-review"],
};
```

Also defines `DISPLAY_STAGES` (mapping stage keys to table names, nodeId suffixes, abbreviations). This should be replaced with an import from `contracts.ts`.

---

### `src/scheduled/schemas.ts`
Defines Zod schemas for all output tables:

| Schema key | Key fields |
|---|---|
| `research` | `contextFilePath`, `findings`, `referencesRead`, `openQuestions`, `notes` |
| `plan` | `planFilePath`, `implementationSteps`, `filesToCreate`, `filesToModify`, `complexity` |
| `implement` | `summary`, `filesCreated`, `filesModified`, `whatWasDone`, `nextSteps`, `believesComplete` |
| `test` | `buildPassed`, `testsPassed`, `testsPassCount`, `testsFailCount`, `failingSummary`, `testOutput` |
| `prd_review` | `severity`, `approved`, `feedback`, `issues` |
| `code_review` | `severity`, `approved`, `feedback`, `issues` |
| `review_fix` | `summary`, `fixesMade`, `falsePositives`, `allIssuesResolved`, `buildPassed`, `testsPassed` |
| `final_review` | `readyToMoveOn`, `reasoning`, `approved`, `qualityScore`, `remainingIssues` |
| `pass_tracker` | `totalIterations`, `unitsRun`, `unitsComplete`, `summary` |
| `completion_report` | `totalUnits`, `unitsLanded`, `unitsFailed`, `passesUsed`, `summary`, `nextSteps` |
| `merge_queue` | `ticketsLanded`, `ticketsEvicted`, `ticketsSkipped`, `summary`, `nextActions` |

The `merge_queue` schema is the key one for state selectors:
- `ticketsLanded: Array<{ ticketId, mergeCommit, summary }>`
- `ticketsEvicted: Array<{ ticketId, reason, details }>`

---

### `src/components/QualityPipeline.tsx`
Uses `SCHEDULED_TIERS` via `tierHasStep(tier, step)` helper. Confirms node ID pattern: `${uid}:research`, `${uid}:plan`, etc. Exports `ScheduledOutputs = typeof scheduledOutputSchemas`.

---

### `src/components/AgenticMergeQueue.tsx`
Defines `AgenticMergeQueueTicket` type:
```typescript
type AgenticMergeQueueTicket = {
  ticketId: string; ticketTitle: string; ticketCategory: string;
  priority: "critical" | "high" | "medium" | "low";
  reportComplete: boolean; landed: boolean;
  filesModified: string[]; filesCreated: string[];
  worktreePath: string;
}
```

---

### `src/components/runtimeNames.ts`
Exports `buildUnitWorktreePath(runId, unitId)` and `buildUnitBranchPrefix(runId, basePrefix)`. Used by `buildMergeTickets()`.

---

## Implementation Plan

### `src/workflow/state.ts`

This file should:

1. **Define `MergeQueueRow` type** — typed snapshot of a single merge_queue output row
   ```typescript
   type MergeQueueRow = {
     nodeId: string;
     ticketsLanded: Array<{ ticketId: string; mergeCommit: string | null; summary: string }>;
     ticketsEvicted: Array<{ ticketId: string; reason: string; details: string }>;
   };
   ```

2. **Define `OutputSnapshot` type** — the typed data structure passed to selectors instead of `ctx`
   ```typescript
   type OutputSnapshot = {
     mergeQueueRows: MergeQueueRow[];
     latestTest: (unitId: string) => { testsPassed: boolean; buildPassed: boolean; failingSummary?: string | null } | null;
     latestFinalReview: (unitId: string) => { readyToMoveOn: boolean } | null;
     latestImplement: (unitId: string) => { whatWasDone: string; filesCreated: string[] | null; filesModified: string[] | null; believesComplete: boolean } | null;
     freshTest?: (unitId: string, iteration: number) => { testsPassed: boolean; buildPassed: boolean } | null;
   };
   ```

3. **Extract pure selectors:**
   - `isUnitLanded(snapshot, unitId): boolean`
   - `isUnitEvicted(snapshot, unitId): boolean`
   - `getEvictionContext(snapshot, unitId): string | null`
   - `getUnitState(snapshot, units, unitId): UnitState`
   - `isTierComplete(snapshot, unitId): boolean`
   - `buildDepSummaries(snapshot, unit): DepSummary[]`
   - `buildMergeTickets(snapshot, units, runId, iteration): AgenticMergeQueueTicket[]`

4. **Export `UnitState` type:** `"done" | "not-ready" | "active"`

### `src/workflow/contracts.ts`

This file should:

1. **Node ID builders:**
   ```typescript
   export const stageNodeId = (unitId: string, stage: StageName) => `${unitId}:${stage}`;
   export const MERGE_QUEUE_NODE_ID = "merge-queue";
   export const PASS_TRACKER_NODE_ID = "pass-tracker";
   ```

2. **Stage name constants** (typed union):
   ```typescript
   export type StageName = "research" | "plan" | "implement" | "test" | "prd-review" | "code-review" | "review-fix" | "final-review";
   export const STAGE_NAMES: readonly StageName[] = [...] as const;
   ```

3. **Re-export/re-use `SCHEDULED_TIERS`** from `scheduled/types.ts` (don't duplicate):
   ```typescript
   export { SCHEDULED_TIERS } from "../scheduled/types";
   ```
   Or add a `getTierStages(tier: string): readonly StageName[]` helper.

4. **`DISPLAY_STAGES` constant** (moved from monitor, with typed fields):
   ```typescript
   export const DISPLAY_STAGES = [
     { key: "research", abbr: "R", table: "research", nodeId: "research" },
     ...
   ] as const;
   ```

### Refactor `ScheduledWorkflow.tsx`

Replace all inline closure functions with calls to the extracted selectors. Pass an `OutputSnapshot` constructed from `ctx` at the top of the component.

### Replace `TIER_STAGES` in `advanced-monitor-ui.ts`

Import from `src/workflow/contracts.ts` instead of maintaining a duplicate.

### `<Ralph>` vs `<Loop>` consideration

The ticket asks to consider replacing `<Ralph>` with `<Loop>` if the Smithers API shape makes the stop condition cleaner. Current code:
```tsx
<Ralph
  until={done}
  maxIterations={maxPasses * units.length * 20}
  onMaxReached="return-last"
>
```

Need to check the Smithers `<Loop>` API shape. The `CONCEPTS.md` only mentions `<Ralph>`. If `<Loop>` accepts `until` + `maxIterations` more cleanly, it may be a drop-in replacement. **This is an open question** — need to check smithers-orchestrator types.

---

## Test Strategy

Unit tests for `src/workflow/state.ts` using **synthetic output arrays**:

| Test scenario | Setup | Expected |
|---|---|---|
| Unit landed | `mergeQueueRows` has `ticketsLanded: [{ticketId: "foo"}]` | `isUnitLanded` returns true |
| Unit evicted | `mergeQueueRows` has `ticketsEvicted: [{ticketId: "foo"}]`, no landed entry | `isUnitEvicted` returns true |
| Unit landed overrides evicted | Both landed and evicted rows present | `isUnitEvicted` returns false |
| Unit not started | Empty rows | `isUnitLanded` → false, `isUnitEvicted` → false |
| `getUnitState` - done | Unit landed | returns "done" |
| `getUnitState` - not-ready | Dep not landed | returns "not-ready" |
| `getUnitState` - active | No deps, not landed | returns "active" |
| `isTierComplete` | test.testsPassed=true, final_review.readyToMoveOn=true | returns true |
| `isTierComplete` | test.testsPassed=true, buildPassed=false, no fr override | returns false |
| `buildDepSummaries` | implement output present for dep | returns DepSummary |
| `buildMergeTickets` | quality complete, not landed, not evicted | includes ticket |
| `buildMergeTickets` - evicted | evicted, no fresh test | excludes ticket |

Tests can be written with plain Bun test (`bun:test`) without importing Smithers.

---

## Key Insights

1. **The `ctx.outputs("merge_queue")` scanning pattern** is the crux of the refactor — it's scattered across 3 closures (`unitLandedAcrossIterations`, `unitEvicted`, `getEvictionContext`). All three scan the same array with different predicates. An `OutputSnapshot.mergeQueueRows` pre-computed from `ctx.outputs()` unifies them.

2. **`TIER_STAGES` duplication** exists between `src/scheduled/types.ts` (SCHEDULED_TIERS) and `src/advanced-monitor-ui.ts` (TIER_STAGES). `contracts.ts` should be the single source of truth, re-exporting from `scheduled/types.ts`.

3. **The `tierComplete` function** already takes `ctx` and `_units` (unused) — the `_units` parameter was vestigial. The refactored `isTierComplete` only needs the snapshot and `unitId`.

4. **`buildMergeTickets` calls `ctx.outputMaybe`** with an `{nodeId, iteration}` selector for fresh test results. The `OutputSnapshot` needs to support this via a `freshTest(unitId, iteration)` function.

5. **No existing tests** in the codebase — this unit will create the first test file. Suggest placing at `src/workflow/__tests__/state.test.ts`.

6. **UPDATE_PLAN.md** was not found at the specified path `/Users/msaug/zama/super-ralph-lite/UPDATE_PLAN.md`. Research was conducted by reading the source files directly.
