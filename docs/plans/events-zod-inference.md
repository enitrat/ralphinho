# Plan: Replace Hand-Written Event Interfaces with z.infer<> Types in events.ts

**Unit:** events-zod-inference
**Implements:** IMP-0003, IMP-0011
**Date:** 2026-03-17
**Category:** large

---

## Overview

`src/runtime/events.ts` currently maintains two parallel definitions for each of 12 event types: a Zod schema used for runtime validation, and a hand-written TypeScript `interface` used for static typing. These are structurally identical duplicates. This plan eliminates the interfaces by deriving all types from `z.infer<>`, making the Zod schemas the single source of truth.

A secondary win: the `as SmithersEvent` cast in `parseEvent()` exists solely because of the mismatch between the hand-written interfaces and Zod's inferred types. Once `SmithersEvent = z.infer<typeof smithersEventSchema>`, the cast becomes unnecessary.

---

## Work Type Assessment

**This is mechanical refactoring — TDD does not apply.**

Justification:
- No observable behavior changes: the 12 `z.infer<>` type aliases are structurally identical to the 12 hand-written interfaces they replace
- No new code paths, APIs, or features introduced
- The compiler enforces correctness: if any inferred type diverges from the previous interface, `bun run typecheck` will catch it at every consumer call site
- `SmithersEvent` keeps the same name and shape; all 5 import sites continue to work unchanged
- The `as SmithersEvent` cast removal is safe by construction — once `SmithersEvent` is defined as `z.infer<typeof smithersEventSchema>`, `result.data` already has that type

Existing tests in `src/runtime/__tests__/events.test.ts` already cover the behavior of `parseEvent` and `readEventLog`. No new tests are needed.

---

## Step-by-Step Changes

All changes are confined to `src/runtime/events.ts`. No other files need modification.

### Step 1 — Remove unused imports (lines 5–6)

Remove the two type-only imports that are only referenced by the hand-written interfaces:

```diff
-import type { StageName } from "../workflows/ralphinho/workflow/contracts";
-import type { DecisionStatus } from "../workflows/ralphinho/workflow/decisions";
```

These imports are not referenced by any Zod schema (schemas use `z.enum()` literals directly). Removing them first ensures a clean diff and avoids TypeScript "unused import" warnings after the interfaces are deleted.

### Step 2 — Replace `SmithersEvent` union type (lines 163–175)

Replace the hand-written union that enumerates all 12 interface names with a single `z.infer<>` derivation:

```diff
-export type SmithersEvent =
-  | NodeStartedEvent
-  | NodeCompletedEvent
-  | NodeFailedEvent
-  | JobScheduledEvent
-  | JobCompletedEvent
-  | MergeQueueLandedEvent
-  | MergeQueueEvictedEvent
-  | MergeQueueSkippedEvent
-  | PassTrackerUpdateEvent
-  | WorkPlanLoadedEvent
-  | FinalReviewDecisionEvent
-  | SemanticCompletionUpdateEvent;
+export type SmithersEvent = z.infer<typeof smithersEventSchema>;
```

### Step 3 — Replace all 12 hand-written interfaces (lines 177–286)

Delete every `export interface *Event { ... }` block and replace each with a one-line `export type` alias:

```diff
-export interface NodeStartedEvent {
-  type: "node-started";
-  timestamp: number;
-  runId: string;
-  nodeId: string;
-  unitId: string;
-  stageName: StageName;
-}
+export type NodeStartedEvent = z.infer<typeof nodeStartedSchema>;
```

Apply the same pattern for all 12 schemas/interfaces:

| Old Interface | New Type Alias |
|---|---|
| `export interface NodeStartedEvent { ... }` | `export type NodeStartedEvent = z.infer<typeof nodeStartedSchema>;` |
| `export interface NodeCompletedEvent { ... }` | `export type NodeCompletedEvent = z.infer<typeof nodeCompletedSchema>;` |
| `export interface NodeFailedEvent { ... }` | `export type NodeFailedEvent = z.infer<typeof nodeFailedSchema>;` |
| `export interface JobScheduledEvent { ... }` | `export type JobScheduledEvent = z.infer<typeof jobScheduledSchema>;` |
| `export interface JobCompletedEvent { ... }` | `export type JobCompletedEvent = z.infer<typeof jobCompletedSchema>;` |
| `export interface MergeQueueLandedEvent { ... }` | `export type MergeQueueLandedEvent = z.infer<typeof mergeQueueLandedSchema>;` |
| `export interface MergeQueueEvictedEvent { ... }` | `export type MergeQueueEvictedEvent = z.infer<typeof mergeQueueEvictedSchema>;` |
| `export interface MergeQueueSkippedEvent { ... }` | `export type MergeQueueSkippedEvent = z.infer<typeof mergeQueueSkippedSchema>;` |
| `export interface PassTrackerUpdateEvent { ... }` | `export type PassTrackerUpdateEvent = z.infer<typeof passTrackerUpdateSchema>;` |
| `export interface WorkPlanLoadedEvent { ... }` | `export type WorkPlanLoadedEvent = z.infer<typeof workPlanLoadedSchema>;` |
| `export interface FinalReviewDecisionEvent { ... }` | `export type FinalReviewDecisionEvent = z.infer<typeof finalReviewDecisionSchema>;` |
| `export interface SemanticCompletionUpdateEvent { ... }` | `export type SemanticCompletionUpdateEvent = z.infer<typeof semanticCompletionUpdateSchema>;` |

### Step 4 — Remove the cast and obsolete comment in `parseEvent` (lines 290–299)

Remove the now-unnecessary JSDoc comment explaining the cast, and remove the cast itself:

```diff
-/**
- * Parse an unknown value into a SmithersEvent, returning null on failure.
- *
- * Note: We cast `result.data` because Zod 4's `discriminatedUnion` type
- * inference for `.nullable()` / `.transform()` fields doesn't exactly match
- * our hand-written interfaces. Behavioral correctness is verified by tests.
- */
 export function parseEvent(value: unknown): SmithersEvent | null {
   const result = smithersEventSchema.safeParse(value);
-  return result.success ? (result.data as SmithersEvent) : null;
+  return result.success ? result.data : null;
 }
```

Replace the JSDoc with a clean single-line description:

```typescript
/** Parse an unknown value into a SmithersEvent, returning null on failure. */
export function parseEvent(value: unknown): SmithersEvent | null {
  const result = smithersEventSchema.safeParse(value);
  return result.success ? result.data : null;
}
```

---

## Files to Create

None.

---

## Files to Modify

| File | Change |
|------|--------|
| `src/runtime/events.ts` | Remove unused imports, replace 12 interfaces with `z.infer<>` type aliases, replace `SmithersEvent` union, remove cast in `parseEvent` |

---

## Tests

TDD does not apply here (see Work Type Assessment). The existing test suite is sufficient:

- `src/runtime/__tests__/events.test.ts` — covers `parseEvent` (all 12 variants, null for invalid input) and `readEventLog` (NDJSON parsing, skipping invalid lines)
- `src/runtime/__tests__/projections.test.ts` — exercises `SmithersEvent` indirectly via projection logic
- All tests run via `bun test`

---

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Zod 4 `discriminatedUnion` produces a type that doesn't match the old union at some consumer | Low | Verified via `bun run typecheck`; if it fails, the error message will pinpoint the exact mismatch |
| `stringArrayFilterSchema` `.transform()` output type differs from `string[]` | Very low | Research confirmed: Zod infers **output** type of transforms; `string[]` matches the old field type |
| `z.number().finite()` infers as `number` not `number & Finite` | Not a risk | TypeScript has no `Finite` branded type; `z.number().finite()` infers as plain `number`, same as the old interfaces |
| Nullable fields (`z.string().nullable()`) infer differently | Very low | Infers as `string | null`, identical to the hand-written `string | null` |
| Optional fields (`z.string().optional()`) infer differently | Very low | Infers as `string | undefined`, structurally identical to TypeScript optional `error?: string` |

---

## Verification Against Acceptance Criteria

| Criterion | How Verified |
|-----------|-------------|
| No `interface *Event` declarations remain | Visual diff confirms only `type` aliases remain |
| `SmithersEvent` is `z.infer<...>` not hand-written | Confirmed in Step 2 |
| `as SmithersEvent` cast removed | Confirmed in Step 4 |
| All import sites compile unchanged | `bun run typecheck` — no changes to the 5 consumer files needed |
| `bun run typecheck` passes with no new errors | Run after all changes |
| Unit tests pass | `bun test src/runtime/__tests__/events.test.ts` |
