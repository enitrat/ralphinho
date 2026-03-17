# Research: event-bridge-snapshot-dedup

## Scope

Address IMP-0001 (shared row-mapping layer) and IMP-0006 (remove SnapshotCapableCtx type erasure) from the Improvinho review.

---

## Key Files

| File | Role | Lines of Interest |
|------|------|-------------------|
| `src/runtime/event-bridge.ts` | DB polling path — constructs `OutputSnapshot` from raw SQLite rows | L243-383 (row maps + snapshot construction) |
| `src/workflows/ralphinho/workflow/snapshot.ts` | SmithersCtx path — constructs `OutputSnapshot` from ctx accessors | L13-16 (SnapshotCapableCtx), L49-79 (buildSnapshot) |
| `src/workflows/ralphinho/workflow/state.ts` | Defines `OutputSnapshot`, `MergeQueueRow`, `TestRow`, `FinalReviewRow`, `ImplementRow`, `ReviewFixRow` | L8-68 (types + interface) |
| `src/workflows/ralphinho/workflow/contracts.ts` | `stageNodeId()`, `MERGE_QUEUE_NODE_ID`, `StageName` | L1-14, L25 |
| `src/workflows/ralphinho/schemas.ts` | Zod schemas for all output tables (`scheduledOutputSchemas`) | L21-207 |
| `src/workflows/ralphinho/components/QualityPipeline.tsx` | Defines `ScheduledOutputs = typeof scheduledOutputSchemas` | L34 |
| `src/workflows/ralphinho/components/ScheduledWorkflow.tsx` | Only consumer of `buildSnapshot()` | L43, L83 |
| `node_modules/smithers-orchestrator/src/SmithersCtx.ts` | `SmithersCtx<Schema>` interface with typed `outputs`, `latest`, `outputMaybe` | Full file |
| `node_modules/smithers-orchestrator/src/OutputAccessor.ts` | `OutputAccessor<Schema>` — typed function + property accessor | Full file |

---

## IMP-0001: Shared Row-Mapping Layer

### Problem

Both `event-bridge.ts` and `snapshot.ts` construct an `OutputSnapshot` with identical shape:
- `mergeQueueRows`, `latestTest`, `latestFinalReview`, `latestImplement`, `freshTest`
- `testHistory`, `finalReviewHistory`, `implementHistory`, `reviewFixHistory`, `isUnitLanded`

The event-bridge version (L243-383) builds Maps from raw SQL rows, then constructs accessors over those Maps. The snapshot version (L49-79) builds accessors from `ctx.outputs()` and `ctx.latest()`.

### Current Duplication

**event-bridge.ts** (DB polling):
1. Queries raw SQL rows from `final_review`, `implement`, `test`, `review_fix` tables
2. Parses/normalizes each row (snake_case → camelCase, Boolean coercion, JSON parsing)
3. Groups into `Map<unitId, Row[]>` per table
4. Builds `OutputSnapshot` from the Maps:
   - `latestTest: (id) => latestRow(testByUnit.get(id) ?? [])`
   - `testHistory: (id) => testByUnit.get(id) ?? []`
   - etc.

**snapshot.ts** (SmithersCtx):
1. Calls `ctx.outputs("test")` etc. to get all rows
2. Uses `rowsForNode()` helper to filter/sort by nodeId
3. Builds `OutputSnapshot` with:
   - `latestTest: (unitId) => ctx.latest("test", stageNodeId(unitId, "test")) as TestRow | null`
   - `testHistory: (unitId) => rowsForNode<TestRow>(testRows, stageNodeId(unitId, "test"))`
   - etc.

### Shared Layer Design

The shared function should accept pre-typed row collections:

```typescript
type SnapshotInput = {
  mergeQueueRows: MergeQueueRow[];
  testRows: TestRow[];         // or Map<string, TestRow[]>
  finalReviewRows: FinalReviewRow[];
  implementRows: ImplementRow[];
  reviewFixRows: ReviewFixRow[];
};

function buildOutputSnapshot(input: SnapshotInput): OutputSnapshot;
```

**Key design decision**: Should the shared layer accept flat arrays (and do the grouping internally) or pre-grouped Maps?

- **Flat arrays**: Simpler API. Both callers already have flat arrays. The grouping-by-unitId logic is simple enough to internalize.
- **Pre-grouped Maps**: More efficient for event-bridge which already groups by unitId during SQL parsing. But adds API complexity.

**Recommendation**: Accept flat arrays with `nodeId` fields. The shared layer groups by unitId using `parseNodeId()` or a simpler split. This keeps the API clean and both callers trivially provide this.

### What Each Caller Would Do

**event-bridge.ts** after refactor:
1. Query raw SQL rows (same as today)
2. Normalize to typed rows (same as today)
3. Call `buildOutputSnapshot({ mergeQueueRows, testRows, finalReviewRows, implementRows, reviewFixRows })`

**snapshot.ts** after refactor:
1. Call `ctx.outputs("test")` etc.
2. Call `buildOutputSnapshot({ mergeQueueRows, testRows, finalReviewRows, implementRows, reviewFixRows })`

### Where to Place the Shared Function

Best location: `src/workflows/ralphinho/workflow/state.ts` — it already owns the `OutputSnapshot` type and all row types. The function logically belongs next to the interface it constructs.

Alternative: A new `src/workflows/ralphinho/workflow/snapshot-builder.ts` to keep state.ts focused on types. But state.ts already has functions like `buildMergeTickets()` and `buildDepSummaries()`, so adding another builder is consistent.

### Concerns

- **`stageNodeId()` dependency**: The snapshot path uses `stageNodeId(unitId, "test")` to build nodeIds. The event-bridge path uses `parseNodeId()` to extract unitId from existing nodeIds. The shared layer needs to handle the `unitId → nodeId` mapping for `latestTest` etc. Since nodeIds follow `{unitId}:{stageName}` format, the shared layer can accept a `nodeIdResolver: (unitId: string, stage: StageName) => string` or just inline the `stageNodeId` import.

- **`freshTest` accessor**: In snapshot.ts this uses `ctx.outputMaybe()` which is a SmithersCtx-specific API. In event-bridge.ts it filters the testByUnit Map by iteration. The shared layer should use the Map-based approach since it works for both paths.

- **`mergeQueueRows` normalization**: event-bridge.ts has a complex `normalizeMergeQueueRow()` that parses from raw SQL JSON columns. snapshot.ts has its own `normalizeMergeQueueRow()` that handles untyped `ctx.outputs()` results. Both are doing the same thing but from different input shapes. The shared layer should accept already-normalized `MergeQueueRow[]`.

---

## IMP-0006: Remove SnapshotCapableCtx Type Erasure

### Problem

snapshot.ts defines:
```typescript
type SnapshotCapableCtx = SmithersCtx<ScheduledOutputs> & {
  outputs: (table: string) => unknown;
  outputMaybe: (table: string, where: { nodeId: string; iteration: number }) => unknown;
};
```

Then casts `ctx as SnapshotCapableCtx` on line 50, erasing the typed accessors. Every return value is then re-cast: `as TestRow | null`, `as FinalReviewRow | null`, etc.

### Root Cause Analysis

Looking at `SmithersCtx<Schema>` (from smithers-orchestrator):
- `outputs: OutputAccessor<Schema>` — typed as `<K extends keyof Schema & string>(table: K): Array<InferOutputEntry<Schema[K]>>`
- `latest<K extends keyof Schema & string>(table: K, nodeId: string): InferOutputEntry<Schema[K]> | undefined`
- `outputMaybe<K extends keyof Schema & string>(table: K, key: OutputKey): InferOutputEntry<Schema[K]> | undefined`

Where `Schema = ScheduledOutputs = typeof scheduledOutputSchemas`.

So `ctx.outputs("test")` should return `Array<z.infer<typeof scheduledOutputSchemas.test>>` which is:
```typescript
Array<{
  buildPassed: boolean;
  testsPassed: boolean;
  testsPassCount: number;
  testsFailCount: number;
  failingSummary: string | null;
  testOutput: string;
}>
```

**Key insight**: The Zod schema output type does NOT include `nodeId` or `iteration` — those are Smithers-internal fields added by the runtime but not part of the Zod schema. So `ctx.outputs("test")` returns arrays without `nodeId`/`iteration` in the type, even though they exist at runtime.

This is WHY the `SnapshotCapableCtx` cast exists — to access `ctx.outputs("test")` as `unknown` and then use the runtime `nodeId`/`iteration` fields that aren't in the typed schema.

### Solution Options

**Option A: Extend Zod schemas** — Add `nodeId: z.string()` and `iteration: z.number()` to each output schema. This is wrong because these are Smithers-managed fields, not agent outputs.

**Option B: Use Smithers-provided typed accessors** — Instead of calling `ctx.outputs("test")` and manually filtering by nodeId, use:
- `ctx.latest("test", nodeId)` — already returns the latest row for a nodeId (typed)
- `ctx.outputMaybe("test", { nodeId, iteration })` — returns a specific iteration (typed)

The history accessors (`testHistory`, etc.) currently use `rowsForNode()` which filters by nodeId. The question is whether Smithers provides a filtered-by-nodeId accessor. Looking at `OutputAccessor`, `ctx.outputs("test")` returns ALL test rows. There's no built-in filtered accessor.

**Option C: Use `ctx.outputs("test")` typed, accept nodeId as runtime extra** — The rows returned by `ctx.outputs()` DO have `nodeId` and `iteration` at runtime (Smithers adds them). We could extend the types at the consumer level:
```typescript
type WithSmithersFields<T> = T & { nodeId: string; iteration: number };
```
Then: `(ctx.outputs("test") as WithSmithersFields<z.infer<typeof scheduledOutputSchemas.test>>[])`.

**Option D (Recommended): After IMP-0001, snapshot.ts doesn't need raw row access** — If the shared `buildOutputSnapshot()` layer exists, snapshot.ts would pass typed arrays to it. The `ctx.outputs()` call can be typed via the schema, and the extra runtime fields can be handled with a minimal cast at the boundary:
```typescript
const testRows = ctx.outputs("test") as (z.infer<typeof scheduledOutputSchemas.test> & { nodeId: string; iteration: number })[];
```
This is ONE cast at the boundary instead of 10 casts throughout the function. Then `buildOutputSnapshot()` receives fully typed input.

### What `as TestRow | null` Casts Do

Lines 61-70 cast `ctx.latest()` returns. Since `ctx.latest("test", nodeId)` returns `InferOutputEntry<typeof scheduledOutputSchemas.test> | undefined`, the Zod-inferred type has `buildPassed`, `testsPassed`, `testsPassCount`, etc. but NOT `nodeId`/`iteration`. The `TestRow` type (state.ts L21-27) has `nodeId?: string; iteration?: number` plus the same fields.

The cast bridges the gap between the Zod schema type and the `TestRow` type which includes optional Smithers-managed fields.

### Recommended Approach for IMP-0006

1. **Remove `SnapshotCapableCtx`** entirely
2. **Keep `buildSnapshot` signature as `(ctx: SmithersCtx<ScheduledOutputs>)`**
3. **For `ctx.outputs()` calls**: Use `ctx.outputs("test")` directly (typed as Zod schema inferred). If `nodeId`/`iteration` fields are needed for grouping, apply a single boundary cast with a helper like `withRuntimeFields<T>(rows: T[]): (T & { nodeId: string; iteration: number })[]`
4. **For `ctx.latest()` calls**: The return type already matches the Zod schema. Since `TestRow` adds optional `nodeId`/`iteration`, either:
   - Align `TestRow` with the Zod-inferred type (remove the optional extra fields)
   - Or accept the minor type mismatch and use a mapped type

5. **Best combined with IMP-0001**: After extracting the shared builder, snapshot.ts becomes thin enough that the typing issue is minimal — just the boundary casts when collecting rows.

---

## Type Alignment Analysis

The row types in `state.ts` vs Zod schema types in `schemas.ts`:

| Row Type | state.ts extra fields | Zod schema extra fields |
|----------|----------------------|------------------------|
| `TestRow` | `nodeId?, iteration?` | `testsPassCount, testsFailCount, testOutput` |
| `FinalReviewRow` | `nodeId?, iteration?` | `remainingIssues` |
| `ImplementRow` | `nodeId?, iteration?, summary?` | `nextSteps` |
| `ReviewFixRow` | `nodeId?, iteration?` | `fixesMade, falsePositives` |
| `MergeQueueRow` | `nodeId` (required) | `ticketsSkipped, summary, nextActions` |

The row types in `state.ts` are a **subset** of the Zod schemas — they only contain the fields needed for decision logic. This is intentional: the snapshot doesn't need every field from the output, just the ones needed for state transitions and decision auditing.

**Implication for IMP-0006**: The casts from Zod-inferred types to row types are narrowing casts (dropping fields), which are safe. The concern is only the `nodeId`/`iteration` fields which exist at runtime but not in the Zod schema.

---

## Existing Tests

No existing test files found for:
- `snapshot.ts` — no `__tests__/snapshot.test.ts`
- `event-bridge.ts` — no `__tests__/event-bridge.test.ts`

Testing strategy should be considered when implementing.

---

## Implementation Order

1. **IMP-0001 first**: Extract `buildOutputSnapshot()` into `state.ts` (or new file)
2. **Refactor event-bridge.ts**: Replace L370-383 with call to `buildOutputSnapshot()`
3. **Refactor snapshot.ts**: Replace L58-78 with call to `buildOutputSnapshot()`
4. **IMP-0006**: With snapshot.ts simplified, remove `SnapshotCapableCtx`, use typed accessors + minimal boundary cast

---

## Consumers of OutputSnapshot

- `ScheduledWorkflow.tsx` (via `buildSnapshot()`)
- `event-bridge.ts` (direct construction)
- `state.ts` functions: `isUnitLanded`, `isUnitEvicted`, `getEvictionContext`, `getUnitState`, `buildDepSummaries`, `buildMergeTickets`
- `decisions.ts`: `getDecisionAudit`, `isMergeEligible`
