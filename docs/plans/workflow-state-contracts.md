# Plan: Extract Workflow State Contracts from ScheduledWorkflow

## Work Type Assessment

**This is a mixed refactoring + new code unit.** The extraction of closures into pure functions is mechanical refactoring (no behavior change), but the new pure functions expose a new testable API surface that didn't exist before. The tests validate behavior of these new public functions.

**TDD applies** for the state selectors in `src/workflow/state.ts` — these are new exported pure functions with defined input/output contracts. Tests should be written first to lock down the expected behavior before the extraction.

**TDD does not apply** for `src/workflow/contracts.ts` (string constants, re-exports) or the refactoring of `ScheduledWorkflow.tsx` (mechanical replacement, compiler enforces correctness).

---

## Overview

1. Create `src/workflow/contracts.ts` — centralized node ID assembly, stage constants, re-export `SCHEDULED_TIERS`
2. Create `src/workflow/state.ts` — pure state selector functions accepting typed output snapshots
3. Write tests for state selectors (`src/workflow/__tests__/state.test.ts`)
4. Refactor `ScheduledWorkflow.tsx` to delegate all `ctx.outputs()` scanning to state.ts helpers
5. Refactor `advanced-monitor-ui.ts` to import `SCHEDULED_TIERS` and `DISPLAY_STAGES` from contracts.ts
6. Skip `<Ralph>` → `<Loop>` replacement — `<Loop>` does not exist in smithers-orchestrator exports

---

## Step-by-Step Plan

### Step 1: Create `src/workflow/contracts.ts`

Define node ID builders, stage name constants, and re-export SCHEDULED_TIERS.

```typescript
// src/workflow/contracts.ts

import { SCHEDULED_TIERS } from "../scheduled/types";
export { SCHEDULED_TIERS };
export type { ScheduledTier } from "../scheduled/types";

// ── Stage Names ──────────────────────────────────────────────────────

export type StageName =
  | "research" | "plan" | "implement" | "test"
  | "prd-review" | "code-review" | "review-fix" | "final-review";

/** Schema table key corresponding to each stage (hyphen → underscore) */
export type StageTableKey =
  | "research" | "plan" | "implement" | "test"
  | "prd_review" | "code_review" | "review_fix" | "final_review";

export const STAGE_NAMES: readonly StageName[] = [
  "research", "plan", "implement", "test",
  "prd-review", "code-review", "review-fix", "final-review",
] as const;

// ── Node ID Builders ─────────────────────────────────────────────────

export function stageNodeId(unitId: string, stage: StageName): string {
  return `${unitId}:${stage}`;
}

export const MERGE_QUEUE_NODE_ID = "merge-queue" as const;
export const PASS_TRACKER_NODE_ID = "pass-tracker" as const;
export const COMPLETION_REPORT_NODE_ID = "completion-report" as const;

// ── Display Stages (for monitor UI) ─────────────────────────────────

export const DISPLAY_STAGES = [
  { key: "research",     abbr: "R", table: "research"     as StageTableKey, nodeId: "research"     as StageName },
  { key: "plan",         abbr: "P", table: "plan"         as StageTableKey, nodeId: "plan"         as StageName },
  { key: "implement",    abbr: "I", table: "implement"    as StageTableKey, nodeId: "implement"    as StageName },
  { key: "test",         abbr: "T", table: "test"         as StageTableKey, nodeId: "test"         as StageName },
  { key: "prd-review",   abbr: "D", table: "prd_review"   as StageTableKey, nodeId: "prd-review"   as StageName },
  { key: "code-review",  abbr: "V", table: "code_review"  as StageTableKey, nodeId: "code-review"  as StageName },
  { key: "review-fix",   abbr: "F", table: "review_fix"   as StageTableKey, nodeId: "review-fix"   as StageName },
  { key: "final-review", abbr: "G", table: "final_review" as StageTableKey, nodeId: "final-review" as StageName },
] as const;
```

**Files:** Create `src/workflow/contracts.ts`

---

### Step 2: Create `src/workflow/state.ts` — Type definitions + function signatures

Define the `OutputSnapshot` type and pure selector function signatures. The snapshot is a plain object that can be constructed from `ctx` in the workflow or from synthetic data in tests.

```typescript
// src/workflow/state.ts

import type { WorkUnit } from "../scheduled/types";
import type { DepSummary } from "../components/QualityPipeline";
import type { AgenticMergeQueueTicket } from "../components/AgenticMergeQueue";
import { stageNodeId, MERGE_QUEUE_NODE_ID } from "./contracts";

// ── Output Snapshot Types ────────────────────────────────────────────

export type MergeQueueRow = {
  nodeId: string;
  ticketsLanded: Array<{ ticketId: string; mergeCommit: string | null; summary: string }>;
  ticketsEvicted: Array<{ ticketId: string; reason: string; details: string }>;
};

export type TestRow = {
  nodeId: string;
  iteration?: number;
  testsPassed: boolean;
  buildPassed: boolean;
  failingSummary?: string | null;
};

export type FinalReviewRow = {
  nodeId: string;
  iteration?: number;
  readyToMoveOn: boolean;
};

export type ImplementRow = {
  nodeId: string;
  iteration?: number;
  whatWasDone: string;
  filesCreated: string[] | null;
  filesModified: string[] | null;
  believesComplete: boolean;
  summary?: string;
};

/**
 * A snapshot of all workflow outputs needed by state selectors.
 * Constructed from SmithersCtx in the workflow; from synthetic data in tests.
 */
export type OutputSnapshot = {
  mergeQueueRows: MergeQueueRow[];
  latestTest: (unitId: string) => TestRow | null;
  latestFinalReview: (unitId: string) => FinalReviewRow | null;
  latestImplement: (unitId: string) => ImplementRow | null;
  freshTest: (unitId: string, iteration: number) => TestRow | null;
};

export type UnitState = "done" | "not-ready" | "active";

// ── Pure Selectors ───────────────────────────────────────────────────

export function isUnitLanded(snapshot: OutputSnapshot, unitId: string): boolean;
export function isUnitEvicted(snapshot: OutputSnapshot, unitId: string): boolean;
export function getEvictionContext(snapshot: OutputSnapshot, unitId: string): string | null;
export function getUnitState(snapshot: OutputSnapshot, units: WorkUnit[], unitId: string): UnitState;
export function isTierComplete(snapshot: OutputSnapshot, unitId: string): boolean;
export function buildDepSummaries(snapshot: OutputSnapshot, unit: WorkUnit): DepSummary[];
export function buildMergeTickets(
  snapshot: OutputSnapshot,
  units: WorkUnit[],
  runId: string,
  iteration: number,
): AgenticMergeQueueTicket[];

// ── Snapshot Builder (bridges SmithersCtx → OutputSnapshot) ──────────

export function buildSnapshot(ctx: SmithersCtx<any>): OutputSnapshot;
```

**Key design decisions:**
- `OutputSnapshot` uses accessor functions (`latestTest`, `latestFinalReview`, etc.) rather than raw arrays because the workflow uses `ctx.latest()` (find newest by nodeId) and `ctx.outputMaybe()` (find by nodeId+iteration). These semantics must be preserved.
- `mergeQueueRows` is the only raw array because `isUnitLanded`/`isUnitEvicted`/`getEvictionContext` all scan the full array with different predicates.
- `buildSnapshot()` bridges `SmithersCtx` → `OutputSnapshot` so `ScheduledWorkflow.tsx` only needs one call.

**Files:** Create `src/workflow/state.ts`

---

### Step 3: Write tests FIRST (`src/workflow/__tests__/state.test.ts`)

Tests use `bun:test` with synthetic `OutputSnapshot` objects. No Smithers dependency.

**Test cases:**

```typescript
import { describe, test, expect } from "bun:test";
import {
  isUnitLanded, isUnitEvicted, getEvictionContext,
  getUnitState, isTierComplete, buildDepSummaries,
  type OutputSnapshot, type MergeQueueRow,
} from "../state";

// Helper to build minimal snapshots
function emptySnapshot(overrides?: Partial<OutputSnapshot>): OutputSnapshot {
  return {
    mergeQueueRows: [],
    latestTest: () => null,
    latestFinalReview: () => null,
    latestImplement: () => null,
    freshTest: () => null,
    ...overrides,
  };
}
```

**Test groups:**

1. **isUnitLanded**
   - Returns `true` when `ticketsLanded` contains the unitId
   - Returns `false` when empty
   - Returns `true` when landed across multiple merge queue rows

2. **isUnitEvicted**
   - Returns `true` when evicted and NOT landed
   - Returns `false` when both landed and evicted (landed takes priority)
   - Returns `false` when neither

3. **getEvictionContext**
   - Returns details string for evicted unit
   - Returns `null` for landed unit (even if also evicted)
   - Returns `null` when no eviction

4. **getUnitState** (AC #5)
   - Returns `"done"` for a unit with a landed entry
   - Returns `"not-ready"` when a dep lacks a landed entry
   - Returns `"active"` when deps are satisfied and not landed

5. **isTierComplete** (AC #6)
   - Returns `false` when `testsPassed` is `false`
   - Returns `false` when `testsPassed` is `true` but `buildPassed` is `false` and `readyToMoveOn` is `false`
   - Returns `true` when `testsPassed` is `true` AND `readyToMoveOn` is `true`
   - Returns `true` when `testsPassed` is `true`, `buildPassed` is `false`, but `readyToMoveOn` is `true` (override)

6. **buildDepSummaries**
   - Returns summaries for deps with implement output
   - Skips deps without implement output
   - Returns empty for unit with no deps

**Files:** Create `src/workflow/__tests__/state.test.ts`

---

### Step 4: Implement state selectors (`src/workflow/state.ts`)

Implement all function bodies. Logic is lifted directly from `ScheduledWorkflow.tsx` closures with `ctx` replaced by `snapshot`:

- `isUnitLanded`: scan `snapshot.mergeQueueRows` for any row where `ticketsLanded` contains `unitId`
- `isUnitEvicted`: if `isUnitLanded` → false; else scan for `ticketsEvicted` containing `unitId`
- `getEvictionContext`: if `isUnitLanded` → null; reverse-scan for latest eviction details
- `getUnitState`: `isUnitLanded` → "done"; deps not all landed → "not-ready"; else → "active"
- `isTierComplete`: check `snapshot.latestTest(unitId)?.testsPassed`, `buildPassed`, and `snapshot.latestFinalReview(unitId)?.readyToMoveOn`
- `buildDepSummaries`: for each dep, call `snapshot.latestImplement(depId)` and build `DepSummary`
- `buildMergeTickets`: filter units by active + tierComplete + not landed, handle eviction re-test logic via `snapshot.freshTest()`

Also implement `buildSnapshot(ctx)`:
```typescript
export function buildSnapshot(ctx: SmithersCtx<any>): OutputSnapshot {
  const allMqRows = ctx.outputs("merge_queue") ?? [];
  const mqRows: MergeQueueRow[] = Array.isArray(allMqRows)
    ? allMqRows.filter((r: any) => r?.nodeId === MERGE_QUEUE_NODE_ID)
    : [];

  return {
    mergeQueueRows: mqRows,
    latestTest: (unitId) => ctx.latest("test", stageNodeId(unitId, "test")) ?? null,
    latestFinalReview: (unitId) => ctx.latest("final_review", stageNodeId(unitId, "final-review")) ?? null,
    latestImplement: (unitId) => ctx.latest("implement", stageNodeId(unitId, "implement")) ?? null,
    freshTest: (unitId, iteration) =>
      ctx.outputMaybe("test", { nodeId: stageNodeId(unitId, "test"), iteration }) ?? null,
  };
}
```

**Files:** Modify `src/workflow/state.ts`

---

### Step 5: Run tests — verify green

```bash
bun test src/workflow/__tests__/state.test.ts
```

All tests from Step 3 should pass.

---

### Step 6: Refactor `ScheduledWorkflow.tsx`

Replace all inline closures with imports from `state.ts` and `contracts.ts`.

**Changes:**
1. Add imports: `import { buildSnapshot, isUnitLanded, isUnitEvicted, getEvictionContext, getUnitState, isTierComplete, buildDepSummaries, buildMergeTickets } from "../workflow/state";`
2. Add imports: `import { stageNodeId, MERGE_QUEUE_NODE_ID, PASS_TRACKER_NODE_ID } from "../workflow/contracts";`
3. At top of component body: `const snapshot = buildSnapshot(ctx);`
4. Remove all inline closures: `unitLanded`, `unitLandedAcrossIterations`, `unitEvicted`, `getEvictionContext`, `getUnitState`, `buildDepSummaries`, `buildMergeTickets`
5. Remove standalone `tierComplete` function
6. Replace all call sites:
   - `unitLandedAcrossIterations(id)` → `isUnitLanded(snapshot, id)`
   - `unitEvicted(id)` → `isUnitEvicted(snapshot, id)`
   - `getEvictionContext(id)` → `getEvictionContext(snapshot, id)` (imported)
   - `getUnitState(id)` → `getUnitState(snapshot, units, id)`
   - `tierComplete(ctx, units, id)` → `isTierComplete(snapshot, id)`
   - `buildDepSummaries(unit)` → `buildDepSummaries(snapshot, unit)`
   - `buildMergeTickets()` → `buildMergeTickets(snapshot, units, ctx.runId, ctx.iteration)`
7. Replace inline node ID template literals in the completion report section:
   - `\`${u.id}:final-review\`` → `stageNodeId(u.id, "final-review")`
   - etc. for all 8 stages
8. The completion report's `stages` array and `ctx.latest()` calls for failure detection still need `ctx` — this is acceptable since those calls use `ctx.latest()` (read-only, not scanning).

**Files:** Modify `src/components/ScheduledWorkflow.tsx`

---

### Step 7: Refactor `advanced-monitor-ui.ts`

1. Add import: `import { SCHEDULED_TIERS, DISPLAY_STAGES } from "../workflow/contracts";`
2. Remove the local `TIER_STAGES` constant (lines 31-34)
3. Remove the local `DISPLAY_STAGES` constant (lines 20-29)
4. Update references: `TIER_STAGES[tier]` → `SCHEDULED_TIERS[tier as ScheduledTier]` (or add a helper)
5. The monitor builds node IDs via `\`${t.id}:${sd.nodeId}\`` — replace with `stageNodeId(t.id, sd.nodeId)`

**Note:** `TIER_STAGES` in the monitor used `Record<string, readonly string[]>` which accepted any string key. `SCHEDULED_TIERS` is typed as `{ small: ..., large: ... }`. The monitor should add a fallback: `SCHEDULED_TIERS[tier as ScheduledTier] ?? SCHEDULED_TIERS.large`.

**Files:** Modify `src/advanced-monitor-ui.ts`

---

### Step 8: Typecheck

```bash
bun run typecheck
```

Must pass with no new errors (AC #7).

---

### Step 9: Re-run tests

```bash
bun test src/workflow/__tests__/state.test.ts
```

Confirm all tests still green after full refactoring.

---

## Files Summary

### Create
| File | Purpose |
|------|---------|
| `src/workflow/contracts.ts` | Node ID builders, stage constants, re-export SCHEDULED_TIERS, DISPLAY_STAGES |
| `src/workflow/state.ts` | Pure state selector functions + OutputSnapshot type + buildSnapshot bridge |
| `src/workflow/__tests__/state.test.ts` | Unit tests for all state selectors |

### Modify
| File | Change |
|------|--------|
| `src/components/ScheduledWorkflow.tsx` | Remove all inline closures, delegate to state.ts via buildSnapshot |
| `src/advanced-monitor-ui.ts` | Remove duplicate TIER_STAGES and DISPLAY_STAGES, import from contracts.ts |

---

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| `ctx.outputs("merge_queue")` returns rows with extra fields (nodeId, iteration) that raw Zod types don't include | `MergeQueueRow` type includes `nodeId`; `buildSnapshot` filters by nodeId |
| Completion report section still uses `ctx.latest()` directly for failure reason detection | Acceptable — these are read-only lookups, not scanning. Could extract later if needed. |
| `advanced-monitor-ui.ts` uses `TIER_STAGES` with any-string key | Add fallback: `SCHEDULED_TIERS[tier as ScheduledTier] ?? SCHEDULED_TIERS.large` |
| `buildMergeTickets` uses `ctx.runId` and `ctx.iteration` for worktree path and fresh test | Pass these as explicit parameters to the pure function |
| `<Ralph>` → `<Loop>` replacement requested but `<Loop>` doesn't exist in smithers-orchestrator | Skip — noted in plan. `<Ralph>` works correctly. |

---

## Acceptance Criteria Verification

| AC | How Verified |
|----|-------------|
| 1. No inline `ctx.outputs()` calls in ScheduledWorkflow.tsx | Grep for `ctx.outputs(` in the file — should return 0 matches |
| 2. state.ts exports pure functions with no SmithersCtx dependency | Check imports — no `SmithersCtx` import (except in `buildSnapshot` which is the bridge) |
| 3. contracts.ts exports node ID builders; no other file uses template literals for node IDs | Grep for `` `${.*}:` `` pattern in ScheduledWorkflow.tsx and monitor — should return 0 matches |
| 4. TIER_STAGES defined once in contracts.ts | Grep for `TIER_STAGES` or `SCHEDULED_TIERS` — only in contracts.ts and scheduled/types.ts |
| 5. getUnitState test coverage | Tests: done/not-ready/active scenarios |
| 6. isTierComplete test coverage | Tests: testsPassed false/true, buildPassed override, readyToMoveOn |
| 7. `bun run typecheck` passes | Run typecheck as final verification step |
