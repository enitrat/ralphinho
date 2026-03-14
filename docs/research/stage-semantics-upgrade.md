# Research: Stage-Semantics Upgrade

**Unit:** `stage-semantics-upgrade`
**Phase:** Phase 3 — Upgrade Per-Stage Retry, Cache, and Dependency Semantics
**Category:** large

---

## Summary

This unit refactors `QualityPipeline.tsx` to replace the single uniform `retries={retries}` prop
(threaded in from `ScheduledWorkflow`) with stage-specific retry policies. Research and plan
tasks get up to 3 attempts with exponential backoff semantics; implement tasks fail fast (1–2
attempts); test tasks retry for transient failures; merge queue tasks have explicit
retry/backoff for transient VCS/push failures. A cache policy is added to the research and
plan stages. Where the Smithers API permits it, explicit `dependsOn` declarations are added to
make execution relationships visible in code. Node IDs are imported from `contracts.ts` rather
than assembled inline.

---

## Files Analyzed

### `src/components/QualityPipeline.tsx` — PRIMARY TARGET

**Current state (✓ VERIFIED):**

```tsx
// Every Task in the pipeline receives the same `retries` prop, threaded from ScheduledWorkflow
<Task id={stageNodeId(uid, "research")} retries={retries} ...>
<Task id={stageNodeId(uid, "plan")}     retries={retries} ...>
<Task id={stageNodeId(uid, "implement")} retries={retries} ...>
<Task id={stageNodeId(uid, "test")}     retries={retries} ...>
...etc
```

**What needs to change:**
1. Replace `retries={retries}` on every Task with stage-specific values derived from named policy
   constants.
2. Add `meta` prop with `dependsOn` array to each Task to document logical dependencies
   (Smithers does NOT support runtime `dependsOn` natively — see Smithers API Constraints).
3. Add a `cache` policy annotation where the Smithers API permits it.
4. `stageNodeId` is already imported from `../workflow/contracts` — no change needed there.

**Current imports (✓ VERIFIED):**
```tsx
import { stageNodeId, TIER_STAGES } from "../workflow/contracts";
```
All node IDs are already constructed via `stageNodeId(uid, "...")`. The `MERGE_QUEUE_NODE_ID`,
`PASS_TRACKER_NODE_ID`, and `COMPLETION_REPORT_NODE_ID` constants exist in `contracts.ts` but
are not yet used in `QualityPipeline.tsx` (the merge queue is in `ScheduledWorkflow.tsx`).

**`QualityPipelineProps` interface (✓ VERIFIED):**
```tsx
export type QualityPipelineProps = {
  ...
  retries?: number;   // ← currently uniform; to be replaced by stage-specific policies
  ...
};
```
The `retries` prop comes from `ScheduledWorkflow.tsx` which defaults it to `1`.

---

### `src/components/AgenticMergeQueue.tsx` — SECONDARY TARGET

**Current state (✓ VERIFIED):**
```tsx
<Task id={nodeId} output={output} agent={agent} fallbackAgent={fallbackAgent} retries={2}>
```
The merge queue task has a hardcoded `retries={2}`. This should be replaced with a named
`MERGE_QUEUE_RETRY_POLICY` constant (same value, but named for clarity and to match the
refactor's intent).

---

### `src/workflow/contracts.ts` — REFERENCE / EXTENSION TARGET

**Current exports (✓ VERIFIED):**
- `StageName` (type union of all stage names)
- `StageTableName` (type union of snake_case table names)
- `stageNodeId(unitId, stage): string`
- `MERGE_QUEUE_NODE_ID = "merge-queue"`
- `PASS_TRACKER_NODE_ID = "pass-tracker"`
- `COMPLETION_REPORT_NODE_ID = "completion-report"`
- `TIER_STAGES: Record<ScheduledTier, readonly StageName[]>`
- `DISPLAY_STAGES` array

**What to add:** Stage-specific retry policy constants should be added here (or in a new
`src/workflow/retryPolicies.ts` sibling file). Keeping them in `contracts.ts` is preferred as
it co-locates them with the stage name constants they map to.

---

### `src/components/ScheduledWorkflow.tsx` — CONSUMER (no direct change)

**Current state (✓ VERIFIED):**
```tsx
<QualityPipeline
  ...
  retries={retries}   // ← uniform, propagated from ScheduledWorkflow props (default: 1)
  ...
/>
```
Once `QualityPipeline` ignores the uniform `retries` prop and uses stage-specific constants,
`ScheduledWorkflow` continues to pass `retries` for backward compatibility or the prop is
removed. The `retries` default in `ScheduledWorkflow.tsx` is `1`.

---

### Smithers `TaskProps` (`node_modules/smithers-orchestrator/src/components/Task.ts`) — VERIFIED

```typescript
export type TaskProps<Row> = {
  id: string;
  output: ZodObject<any>;
  agent?: AgentLike | AgentLike[];
  fallbackAgent?: AgentLike;
  skipIf?: boolean;
  needsApproval?: boolean;
  timeoutMs?: number;
  retries?: number;           // ← simple integer, no policy object
  continueOnFail?: boolean;
  label?: string;
  meta?: Record<string, unknown>;  // ← usable for dependsOn documentation
  children: ...;
};
```

---

## Smithers API Constraints (✓ VERIFIED)

| Feature | Smithers Support | Implementation Path |
|---------|-----------------|---------------------|
| `retries` | ✓ `retries?: number` on `TaskProps` | Use named constants per stage |
| Retry backoff | ✗ Not supported (attempts run without delay) | Document the "intent" via constant names; actual backoff not enforceable at Smithers level |
| Per-task cache | ✗ Not supported. Cache is **Workflow-level** only (`<Workflow cache={true}>`) | Cannot add per-task cache. Must use `skipIf` semantics or Workflow-level override. See open questions. |
| `dependsOn` | ✗ Not in `TaskProps` or `TaskDescriptor` | Use `meta={{ dependsOn: [...] }}` for documentation/visualization only |
| Agent fallback | ✓ `agent={[primary, fallback]}` or `fallbackAgent` prop | Already used |

### Cache Evidence

From `SmithersWorkflowOptions.ts`:
```typescript
export type SmithersWorkflowOptions = {
  cache?: boolean;
};
```
From `components/Workflow.ts`:
```typescript
export type WorkflowProps = {
  name: string;
  cache?: boolean;
};
```
From engine (`index.ts`):
```typescript
const cacheEnabled = workflow.opts.cache ?? (xml.props.cache === "true" || xml.props.cache === "1"),
```
Cache is evaluated **per workflow**, not per task. Individual `TaskDescriptor` has no `cache`
field. This means "cache disabled for implement, test, review-fix, final-review" cannot be
expressed at the `<Task>` level with the current Smithers API.

### `dependsOn` Evidence

Grepped entire `node_modules/smithers-orchestrator/src` for `dependsOn` and `depends_on`:
**zero matches**. Smithers has no native `dependsOn` mechanism. The `<Sequence>` primitive
already enforces ordering. `dependsOn` can be communicated via `meta` for visualization/tooling
purposes only.

---

## Implementation Plan

### 1. Define retry policy constants in `src/workflow/contracts.ts`

```typescript
/**
 * Per-stage retry policies.
 * Smithers only supports `retries: number` (no backoff); the policy names
 * communicate intent even though Smithers runs retries back-to-back.
 */

/** Research/Plan: up to 3 attempts. Context gathering rarely has transient failures;
 *  extra retries protect against agent timeouts or malformed JSON output. */
export const RESEARCH_RETRIES = 2;  // retries=2 means 3 total attempts
export const PLAN_RETRIES = 2;

/** Implement: fail fast. Re-running an implement stage on a partial worktree state
 *  can corrupt context. 1 retry gives one safety net for agent timeouts. */
export const IMPLEMENT_RETRIES = 1;

/** Test: allow retries for transient failures (flaky CI, network). */
export const TEST_RETRIES = 2;

/** Reviews: 1 retry is usually enough. Reviews are idempotent. */
export const REVIEW_RETRIES = 1;

/** Review-fix, final-review: stateful; keep retries low. */
export const REVIEW_FIX_RETRIES = 1;
export const FINAL_REVIEW_RETRIES = 1;

/** Merge queue: 2 retries for transient VCS/push failures (already hardcoded in
 *  AgenticMergeQueue.tsx; this constant formalizes it). */
export const MERGE_QUEUE_RETRIES = 2;
```

### 2. Update `src/components/QualityPipeline.tsx`

- Import the new constants from `../workflow/contracts`
- Replace every `retries={retries}` with the corresponding stage constant
- Remove or deprecate the `retries?: number` prop from `QualityPipelineProps`
  (or keep it as an escape hatch but don't use it by default)
- Add `meta={{ dependsOn: [stageNodeId(uid, "research")] }}` to the plan Task
- Add `meta={{ dependsOn: [stageNodeId(uid, "plan")] }}` to the implement Task
- Add `meta={{ dependsOn: [stageNodeId(uid, "implement")] }}` to the test Task
- etc. (full dependency chain documented via `meta`)

### 3. Update `src/components/AgenticMergeQueue.tsx`

- Import `MERGE_QUEUE_RETRIES` from the correct contracts path
- Replace `retries={2}` with `retries={MERGE_QUEUE_RETRIES}`

### 4. Cache policy (Smithers limitation)

Since Smithers does not support per-task cache, the implementation options are:

**Option A (recommended):** Add a code comment on the research/plan Task nodes explaining that
cache semantics are enforced by `skipIf={!!research}` and `skipIf={!!plan}` (already present).
The `skipIf` guards already prevent re-execution when output exists, which is the functional
equivalent of cache-hit for idempotent stages.

**Option B:** Document that per-task cache requires a Smithers API extension (add to open
questions / future work). Deferred.

**Option C:** Wrap only research+plan in a sub-`<Workflow cache={true}>`. This would require
splitting the pipeline into two Workflow trees, which is architecturally complex and not
recommended.

→ **Option A is the correct implementation path.** The `skipIf` guards on research and plan
tasks (already in the code) are the idiomatic Smithers equivalent of "cache this stage's
output."

---

## Key Insights

1. **The uniform `retries={retries}` pattern** (threading a single value from `ScheduledWorkflow`
   down to every Task) is the core problem. All stages behave identically on failure, which is
   incorrect: failing fast on implement (to avoid polluting the worktree) has different
   consequences than retrying a flaky test 3 times.

2. **Smithers `retries` semantics** (`retries=N` means N+1 total attempts, via `Failed attempts
   >= retries + 1 → failed` in the scheduler). Document this in constant comments.

3. **`dependsOn` via `meta`** is the only available mechanism in current Smithers. The `<Sequence>`
   structure already provides execution ordering, but `meta.dependsOn` makes the logical
   relationship explicit for monitoring tools and future Smithers extensions.

4. **Cache per-task is not possible** with current Smithers. The `skipIf={!!research}` and
   `skipIf={!!plan}` guards on the research and plan Tasks are the existing functional
   equivalent. Adding explicit `cache`-related constants or comments clarifies this intent.

5. **`AgenticMergeQueue.tsx` is a secondary target**: its hardcoded `retries={2}` should be
   replaced with the named `MERGE_QUEUE_RETRIES` constant for consistency.

6. **`contracts.ts` is the right place** for retry constants because they are stage-level
   contracts, co-located with `StageName`, `TIER_STAGES`, and the node ID builders.

7. **The `retries` prop on `QualityPipelineProps`** can either be removed (preferred for clean
   API) or kept as an override escape hatch. If kept, it should only be used for emergency
   overrides, not for normal operation.

---

## Open Questions

1. **Per-task cache in Smithers**: Is a `<Task cache={false}>` prop planned for a future
   Smithers release? If yes, should this unit stub it out as `meta={{ cache: false }}`? Or
   should it wait for native support?

2. **Actual backoff**: Smithers runs retries back-to-back with no delay. If exponential backoff
   is truly required (e.g., for VCS push failures in the merge queue), should a `timeoutMs`
   heuristic be used, or should the merge queue agent handle its own sleep logic?

3. **Remove or keep `retries?: number` on `QualityPipelineProps`**: Removing it creates a clean
   API break; keeping it allows emergency overrides. Which is preferred?

4. **`ScheduledWorkflow.tsx` `retries` prop**: Should `ScheduledWorkflowProps.retries` be
   removed once `QualityPipeline` uses stage-specific constants? It currently threads down to
   `QualityPipeline` and also to the merge queue default (`AgenticMergeQueue`).

---

## References Read

- `src/components/QualityPipeline.tsx` — Primary implementation target
- `src/components/AgenticMergeQueue.tsx` — Secondary target (hardcoded `retries={2}`)
- `src/components/ScheduledWorkflow.tsx` — Consumer of `QualityPipeline`
- `src/workflow/contracts.ts` — Node ID constants, stage names, TIER_STAGES
- `node_modules/smithers-orchestrator/src/components/Task.ts` — `TaskProps` interface
- `node_modules/smithers-orchestrator/src/TaskDescriptor.ts` — Internal task descriptor
- `node_modules/smithers-orchestrator/src/SmithersWorkflowOptions.ts` — Workflow-level cache
- `node_modules/smithers-orchestrator/src/engine/index.ts` — Cache implementation (workflow-level)
- `.skills/smithers-workflows/references/architecture.md` — Engine internals, retry semantics
- `.skills/smithers-workflows/references/anti-patterns.md` — Known pitfalls
- `.skills/smithers-workflows/references/project-patterns.md` — Project conventions
- `CONCEPTS.md` — Smithers primitives, quality pipeline overview
- `ARCHITECTURE.md` — Document index
- `docs/research/workflow-state-contracts.md` — Precedent research format
