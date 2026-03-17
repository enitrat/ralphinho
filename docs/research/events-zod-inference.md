# Research: Replace Hand-Written Event Interfaces with z.infer<> Types in events.ts

**Unit:** events-zod-inference
**Date:** 2026-03-17
**Implements:** IMP-0003, IMP-0011

---

## Summary

`src/runtime/events.ts` currently maintains two parallel definitions for each of 12 event types:

1. A **Zod schema** (e.g. `nodeStartedSchema`) — used at runtime for parsing/validation
2. A **hand-written TypeScript interface** (e.g. `NodeStartedEvent`) — used only for static typing

The goal is to delete all 12 hand-written interfaces and derive them from `z.infer<>`, making the Zod schemas the single source of truth. This also eliminates the `as SmithersEvent` cast in `parseEvent`.

---

## File Structure (events.ts)

| Lines | Content |
|-------|---------|
| 1–6 | Imports (`readFile`, `zod`, `StageName`, `DecisionStatus`) |
| 8–27 | Shared enum schemas: `stageNameSchema`, `decisionStatusSchema`, `stringArrayFilterSchema` |
| 29–159 | 12 per-variant Zod schemas |
| 144–159 | `smithersEventSchema` — discriminated union of all 12 schemas |
| 161–175 | `SmithersEvent` union type (hand-written, referencing the 12 interfaces) |
| 177–286 | 12 hand-written `export interface` declarations ← **DELETE THESE** |
| 288–300 | `parseEvent()` with `as SmithersEvent` cast ← **REMOVE CAST** |
| 302–330 | `readEventLog()` — uses `SmithersEvent[]` |

---

## The 12 Schema/Interface Pairs

| Zod Schema | Hand-written Interface | Event `type` literal |
|-----------|----------------------|---------------------|
| `nodeStartedSchema` | `NodeStartedEvent` | `"node-started"` |
| `nodeCompletedSchema` | `NodeCompletedEvent` | `"node-completed"` |
| `nodeFailedSchema` | `NodeFailedEvent` | `"node-failed"` |
| `jobScheduledSchema` | `JobScheduledEvent` | `"job-scheduled"` |
| `jobCompletedSchema` | `JobCompletedEvent` | `"job-completed"` |
| `mergeQueueLandedSchema` | `MergeQueueLandedEvent` | `"merge-queue-landed"` |
| `mergeQueueEvictedSchema` | `MergeQueueEvictedEvent` | `"merge-queue-evicted"` |
| `mergeQueueSkippedSchema` | `MergeQueueSkippedEvent` | `"merge-queue-skipped"` |
| `passTrackerUpdateSchema` | `PassTrackerUpdateEvent` | `"pass-tracker-update"` |
| `workPlanLoadedSchema` | `WorkPlanLoadedEvent` | `"work-plan-loaded"` |
| `finalReviewDecisionSchema` | `FinalReviewDecisionEvent` | `"final-review-decision"` |
| `semanticCompletionUpdateSchema` | `SemanticCompletionUpdateEvent` | `"semantic-completion-update"` |

---

## Type Compatibility Analysis

### stageNameSchema → StageName

- `stageNameSchema = z.enum(["research", "plan", "implement", ...])` — 9 values
- `StageName` (contracts.ts:1) = `"research" | "plan" | "implement" | ...` — same 9 values
- **✓ VERIFIED**: `z.infer<typeof stageNameSchema>` produces an identical string literal union. Structurally compatible with `StageName`.

### decisionStatusSchema → DecisionStatus

- `decisionStatusSchema = z.enum(["pending", "rejected", "approved", "invalidated"])`
- `DecisionStatus` (decisions.ts:9) = `"pending" | "rejected" | "approved" | "invalidated"`
- **✓ VERIFIED**: Structurally identical. No cast needed.

### stringArrayFilterSchema → string[]

- `stringArrayFilterSchema = z.array(z.unknown()).transform(arr => arr.filter(...) as string[])`
- `z.infer<typeof stringArrayFilterSchema>` = `string[]` (Zod infers the **output** type of transforms)
- Hand-written `SemanticCompletionUpdateEvent.unitsLanded: string[]`
- **✓ VERIFIED**: Compatible. The transform's output type is `string[]`.

### nullable fields

- `ticketId: z.string().nullable()` → infers as `string | null` ✓
- `mergeCommit: z.string().nullable()` → infers as `string | null` ✓
- `error: z.string().optional()` → infers as `string | undefined` ✓

### Why the cast exists now

The comment at lines 293–295 says Zod 4's discriminatedUnion inference doesn't exactly match hand-written interfaces. With the interfaces gone and `SmithersEvent = z.infer<typeof smithersEventSchema>`, there is no mismatch to paper over — `result.data` will already be typed as `SmithersEvent`, making the cast unnecessary.

---

## Imports at Top of events.ts

After the refactor, the `import type { StageName }` and `import type { DecisionStatus }` imports at lines 5–6 **can be removed** since they are only used by the hand-written interfaces. The Zod schemas define their own enum literals and do not reference these types.

---

## Consumer Import Sites

Only `SmithersEvent`, `parseEvent`, and `readEventLog` are imported from events.ts elsewhere. **No file imports individual event interface names** (NodeStartedEvent, etc.).

| File | Imported symbols |
|------|----------------|
| `src/advanced-monitor-ui.ts:18` | `readEventLog` |
| `src/runtime/projections.ts:3` | `type SmithersEvent` |
| `src/runtime/event-bridge.ts:8` | `type SmithersEvent` |
| `src/runtime/__tests__/projections.test.ts:5` | `type SmithersEvent` |
| `src/runtime/__tests__/events.test.ts:4` | `parseEvent`, `readEventLog` |

**✓ VERIFIED**: No import site will need updating. The type alias `SmithersEvent` keeps the same name and structurally identical shape.

---

## Implementation Plan

### Step 1 — Replace SmithersEvent union type (line 163–175)

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

### Step 2 — Replace all 12 hand-written interfaces (lines 177–286)

For each:
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

Repeat for all 12.

### Step 3 — Remove the cast in parseEvent (line 299)

```diff
-  return result.success ? (result.data as SmithersEvent) : null;
+  return result.success ? result.data : null;
```

Also remove the now-obsolete comment at lines 291–296.

### Step 4 — Clean up unused imports

```diff
-import type { StageName } from "../workflows/ralphinho/workflow/contracts";
-import type { DecisionStatus } from "../workflows/ralphinho/workflow/decisions";
```

These are only needed by the hand-written interfaces. After removing those interfaces, these imports become unused. (Verify no schema references them explicitly — confirmed they don't; schemas use `z.enum()` literals directly.)

---

## Potential Risks

1. **Zod 4 discriminatedUnion inference quirk**: The existing comment says Zod 4's inference "doesn't exactly match" hand-written interfaces. Once all interfaces are replaced with `z.infer<>`, `SmithersEvent` will equal `z.infer<typeof smithersEventSchema>` exactly. The cast becomes unnecessary because there's nothing to mismatch against. If Zod 4 does produce an unusual union type, it will manifest as a type error elsewhere (surfaced at compile time) rather than being silently papered over.

2. **`stringArrayFilterSchema` transform output**: Verified — Zod infers the output type of `.transform()`, which is `string[]`. This matches the hand-written interface field type. No issue.

3. **Optional vs. undefined**: `error?: string` in the hand-written interface matches `z.string().optional()` which infers as `string | undefined` — same as TypeScript optional fields.

---

## Related Files

- `src/runtime/events.ts` — primary target
- `src/runtime/__tests__/events.test.ts` — test coverage (no changes needed)
- `src/runtime/projections.ts` — imports `SmithersEvent` (no changes needed)
- `src/runtime/event-bridge.ts` — imports `SmithersEvent` (no changes needed)
- `src/workflows/ralphinho/workflow/contracts.ts` — exports `StageName` (no changes needed)
- `src/workflows/ralphinho/workflow/decisions.ts` — exports `DecisionStatus` (no changes needed)

---

## References

- RFC: `.tickets/summary.md` — IMP-0003 (lines 49–73), IMP-0011 (lines 192–205)
- Source: `src/runtime/events.ts` (full file, 331 lines)
- Tests: `src/runtime/__tests__/events.test.ts` (289 lines)
