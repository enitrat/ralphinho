# Improvinho Review - 2026-03-17

## Critical (0)
No findings.

## High (3)
### IMP-0001 - event-bridge.ts repeats an identical DB-poll → parseNodeId → Boolean-coerce → push-into-array pattern 5 times across 150+ lines
- Kind: simplification
- Confidence: high
- Seen by: refactor-hunter
- Scopes: src
- Support count: 1
- Files: src/runtime/event-bridge.ts, src/runtime/event-bridge.ts:166-237, src/runtime/event-bridge.ts:244-346
- Evidence: Lines 244-346 contain five try/catch blocks querying final_review, implement, test, review_fix tables. Each block: (1) db.query with run_id filter, (2) iterate rows, (3) call parseNodeId to filter, (4) Boolean-coerce fields, (5) push into a typed array. The only variance is column names and field mappings. This is a textbook extract-and-parameterize target. Similarly, lines 166-237 repeat the parseObjectArray → filter → map → events.push pattern 3 times for ticketsLanded/ticketsEvicted/ticketsSkipped.
- Accept if: Each of the 5 DB polling blocks follows the same structural pattern with only column-name and type differences.
- Dismiss if: The blocks have meaningfully different error-handling or recovery logic beyond the generic try/catch swallow.

```diff
Extract a generic helper:

```ts
function queryRows<T>(db: Database, sql: string, runId: string, mapper: (row: any) => T | null): T[] {
  try {
    return db.query(sql).all(runId)
      .map(mapper)
      .filter((r): r is T => r !== null);
  } catch { return []; }
}
```

Then each table becomes a one-liner mapper call instead of a 20-line try/catch block.
```

### IMP-0002 - 10+ database query results cast via `as Array<T>` with no runtime validation—if the DB schema drifts, data silently mismatches the typed shape
- Kind: bug
- Confidence: high
- Seen by: type-system-purist
- Scopes: src
- Support count: 1
- Files: src/runtime/event-bridge.ts, event-bridge.ts:124, event-bridge.ts:146, event-bridge.ts:170, event-bridge.ts:247, event-bridge.ts:273, event-bridge.ts:301, event-bridge.ts:92
- Evidence: event-bridge.ts:92 `.all(runId) as Array<{ node_id: string; state: string; ... }>`, line 124 `.all() as Array<{ job_type: string; ... }>`, line 146 `.all(runId) as Array<{ node_id: string; ... }>`, lines 170, 247, 273, 301 all repeat the pattern. bun:sqlite's `.all()` returns `unknown[]`, so the cast silently asserts schema correctness.
- Accept if: Database schema is not contractually locked and may evolve independently of TypeScript types
- Dismiss if: Schema is auto-generated from a single source of truth that guarantees alignment with the TS types

```diff
Introduce a thin row-validation helper (e.g., Zod schema or manual check) and replace `as Array<T>` with `schema.parse(rows)`. Alternatively, use a type-safe query builder.
```

### IMP-0003 - events.ts defines 12 Zod schemas AND 12 hand-written TypeScript interfaces that duplicate the exact same shape — ~140 lines of pure duplication
- Kind: simplification
- Confidence: high
- Seen by: refactor-hunter
- Scopes: src
- Support count: 1
- Files: src/runtime/events.ts, src/runtime/events.ts:10-159, src/runtime/events.ts:163-286
- Evidence: Each Zod variant (e.g., `nodeStartedSchema`) has an exactly matching interface (e.g., `NodeStartedEvent`). The interfaces add zero information beyond what `z.infer<typeof nodeStartedSchema>` provides. The file even acknowledges the mismatch in its `parseEvent` comment: "Zod 4's discriminatedUnion type inference ... doesn't exactly match our hand-written interfaces." This is a symptom, not a justification — fix the inference gap instead of maintaining two parallel definitions. The Zod schemas are the source of truth at runtime; the interfaces only exist to paper over a type-level wrinkle.
- Accept if: The hand-written interfaces exist solely to duplicate Zod schema shapes and provide no additional type narrowing or documentation beyond what z.infer would give.
- Dismiss if: There is a concrete Zod 4 type-level bug that makes z.infer produce incorrect types for nullable/transform fields AND fixing that bug is blocked.

```diff
Replace all hand-written interfaces with `z.infer<>` types:

```diff
-export interface NodeStartedEvent {
-  type: "node-started";
-  timestamp: number;
-  ...
-}
+export type NodeStartedEvent = z.infer<typeof nodeStartedSchema>;
```

Repeat for all 12 variants. If Zod 4's discriminatedUnion inference is the issue, add a single `as SmithersEvent` cast in `parseEvent` or use a mapped type over the schema array.
```

## Medium (6)
### IMP-0004 - Redundant `String(unit.id)` after `typeof unit?.id === 'string'` filter already narrowed the type
- Kind: simplification
- Confidence: high
- Seen by: type-system-purist
- Scopes: src
- Support count: 1
- Files: src/runtime/event-bridge.ts, event-bridge.ts:70-72
- Evidence: event-bridge.ts:70-72: `.filter((unit) => typeof unit?.id === "string").map((unit) => ({ id: String(unit.id), ...`. The filter guarantees `unit.id` is a string, making `String()` a no-op coercion that distrusts the preceding type narrowing.
- Accept if: The filter and map operate on the same narrowed type without intermediate mutation
- Dismiss if: The array element type is `Record<string, unknown>` so TS doesn't carry the narrowing into `.map()`

```diff
Replace `String(unit.id)` with `unit.id` since the filter already proved it's a string. Same for `String(item.ticketId)` at line 184.
```

### IMP-0005 - `Boolean()` coercions on fields already typed as `boolean` in the `as Array<T>` cast duplicate the type assertion
- Kind: simplification
- Confidence: high
- Seen by: type-system-purist
- Scopes: src
- Support count: 1
- Files: src/runtime/event-bridge.ts, event-bridge.ts:260, event-bridge.ts:261, event-bridge.ts:290, event-bridge.ts:313, event-bridge.ts:314
- Evidence: event-bridge.ts:260 `readyToMoveOn: Boolean(row.ready_to_move_on)`, line 261 `approved: Boolean(row.approved)`, line 290 `believesComplete: Boolean(row.believes_complete)`, lines 313-314 `testsPassed: Boolean(row.tests_passed)`, `buildPassed: Boolean(row.build_passed)`. The cast at lines 247-254 already declares these fields as `boolean`.
- Accept if: SQLite returns 0/1 integers for booleans, so the cast lies and `Boolean()` is the real coercion—in that case fix the cast type to `number` instead
- Dismiss if: The ORM or driver genuinely returns JS booleans for these columns

```diff
Either remove `Boolean()` wrappers (trust the cast) or remove the `boolean` type from the cast and keep `Boolean()` as the single source of truth. Don't do both.
```

### IMP-0006 - The two preset files (ralphinho/preset.tsx and improvinho/preset.tsx) duplicate createClaude, buildSystemPrompt, WORKSPACE_POLICY, and EXECUTION_POLICY with only minor parameter differences
- Kind: simplification
- Confidence: high
- Seen by: refactor-hunter
- Scopes: src
- Support count: 1
- Files: src/workflows/ralphinho/preset.tsx, src/workflows/improvinho/preset.tsx:22-63, src/workflows/ralphinho/preset.tsx:24-60
- Evidence: ralphinho/preset.tsx:24-48 defines WORKSPACE_POLICY, EXECUTION_POLICY, buildSystemPrompt, createClaude. improvinho/preset.tsx:22-47 defines the same four symbols with near-identical implementations. The only differences: (1) WORKSPACE_POLICY text differs, (2) idleTimeoutMs is 10min vs 15min, (3) improvinho's createCodex accepts an optional reasoningEffort. The core pattern — build system prompt from role + policies, construct ClaudeCodeAgent/CodexAgent with standard options — is duplicated wholesale. The upstream Smithers library doesn't provide this factory; it's this project's own boilerplate.
- Accept if: The two preset files share the same agent construction pattern and the differences (policy text, timeout) are parameterizable.
- Dismiss if: The presets are intentionally decoupled to allow independent evolution and the duplication is a deliberate trade-off.

```diff
Extract a shared `createAgentFactory(options: { workspacePolicy: string; executionPolicy: string; repoRoot: string; idleTimeoutMs: number })` that returns `{ createClaude, createCodex, buildSystemPrompt }`. Each preset calls it with its specific policies.
```

### IMP-0007 - 6 of 8 retry policy constants in contracts.ts are byte-identical objects ({ kind: 'fail-fast', retries: 1 }), and the other 2 are also identical to each other
- Kind: simplification
- Confidence: high
- Seen by: refactor-hunter
- Scopes: src
- Support count: 1
- Files: src/workflows/ralphinho/workflow/contracts.ts, src/workflows/ralphinho/workflow/contracts.ts:68-115
- Evidence: IMPLEMENT_RETRY_POLICY, TEST_RETRY_POLICY, REVIEW_RETRY_POLICY, REVIEW_FIX_RETRY_POLICY, FINAL_REVIEW_RETRY_POLICY, LEARNINGS_RETRY_POLICY all equal `{ kind: 'fail-fast', retries: 1 }`. RESEARCH_RETRY_POLICY, PLAN_RETRY_POLICY, MERGE_QUEUE_RETRY_POLICY, PR_CREATION_RETRY_POLICY all equal `{ kind: 'backoff', retries: 2, initialDelayMs: 1_000, maxDelayMs: 8_000 }`. That's 10 named constants for 2 distinct values. Each consumer references its own constant (e.g., `IMPLEMENT_RETRY_POLICY.retries`), making it look like there's per-stage tuning when there isn't.
- Accept if: All 6 fail-fast policies and all 4 backoff policies are meant to share the same values and the per-stage naming is only for future divergence.
- Dismiss if: Per-stage tuning is planned and the identical values are a temporary coincidence.

```diff
Replace with two shared constants and per-stage aliases if naming matters:

```diff
-export const IMPLEMENT_RETRY_POLICY: StageRetryPolicy = { kind: 'fail-fast', retries: 1 };
-export const TEST_RETRY_POLICY: StageRetryPolicy = { kind: 'fail-fast', retries: 1 };
-...
+const FAIL_FAST: StageRetryPolicy = { kind: 'fail-fast', retries: 1 };
+const BACKOFF: StageRetryPolicy = { kind: 'backoff', retries: 2, initialDelayMs: 1_000, maxDelayMs: 8_000 };
+export const IMPLEMENT_RETRY_POLICY = FAIL_FAST;
+export const TEST_RETRY_POLICY = FAIL_FAST;
```
```

### IMP-0008 - `as unknown as X` double-cast bypasses Smithers generic type resolution; boundary cast is isolated but untestable
- Kind: architecture
- Confidence: high
- Seen by: type-system-purist
- Scopes: src
- Support count: 1
- Files: src/workflows/ralphinho/workflow/snapshot.ts, snapshot.ts:39, snapshot.ts:50-53
- Evidence: snapshot.ts:39 `(ctx as unknown as { outputs: (t: string) => unknown[] }).outputs(table)` — documented workaround for Smithers' complex generics. Lines 50-53 then cast the `unknown[]` results directly to typed row arrays (`as TestRow[]`, `as FinalReviewRow[]`, etc.) without validation.
- Accept if: Smithers generic types are genuinely unresolvable and there's no upstream fix available
- Dismiss if: Smithers types can be fixed upstream to expose `outputs()` in a resolvable way

```diff
Add runtime validation after the boundary cast: validate rows with Zod schemas or a lightweight assertion before assigning to typed arrays. Keep the single `as unknown as X` but don't chain it with further unvalidated casts.
```

### IMP-0009 - isUnitLanded exists as both a standalone function and an OutputSnapshot method with divergent implementations that do the same thing
- Kind: simplification
- Confidence: high
- Seen by: refactor-hunter
- Scopes: src
- Support count: 1
- Files: src/workflows/ralphinho/workflow/state.ts, src/workflows/ralphinho/workflow/state.ts:151-155, src/workflows/ralphinho/workflow/state.ts:76-79
- Evidence: state.ts:76 defines `export function isUnitLanded(snapshot, unitId)` which calls `mergeQueueRows(snapshot)` (a local helper that filters by MERGE_QUEUE_NODE_ID). state.ts:151 defines `snapshot.isUnitLanded = (id) => input.mergeQueueRows.some(row => row.nodeId === MERGE_QUEUE_NODE_ID && ...)`. These are two implementations of the same logic. The standalone function is used in ScheduledWorkflow.tsx:86 and throughout state.ts. The snapshot method is used in decisions.ts:157. Having both creates a risk of behavioral divergence and forces readers to verify they're equivalent.
- Accept if: Both implementations produce identical results for all inputs and no caller needs the standalone signature for a reason beyond historical accident.
- Dismiss if: The standalone function is needed in contexts where an OutputSnapshot hasn't been built yet.

```diff
Remove the standalone function and have callers use `snapshot.isUnitLanded(unitId)` directly, or implement the standalone as `return snapshot.isUnitLanded(unitId)` — a one-liner delegating to the canonical implementation.
```

## Low (2)
### IMP-0010 - `as any` cast to assign `captureWrite` to `process.stdout.write` bypasses function signature checking
- Kind: simplification
- Confidence: high
- Seen by: type-system-purist
- Scopes: src
- Support count: 1
- Files: src/advanced-monitor-ui.ts, advanced-monitor-ui.ts:269, advanced-monitor-ui.ts:270
- Evidence: advanced-monitor-ui.ts:269-270: `process.stdout.write = captureWrite as any; process.stderr.write = captureWrite as any;` — `captureWrite` returns `true` but the actual `write` signature has multiple overloads. The `as any` silently drops the overload contract.
- Accept if: The function genuinely doesn't satisfy all overloads and the mismatch would cause a type error
- Dismiss if: The function handles all overloads correctly and just needs the right type annotation

```diff
Type `captureWrite` to match `typeof process.stdout.write` using the correct Node.js overload signature, or use a typed wrapper that satisfies the contract.
```

### IMP-0011 - Zod `safeParse` result cast `as SmithersEvent` distrusts Zod's own type inference
- Kind: simplification
- Confidence: high
- Seen by: type-system-purist
- Scopes: src
- Support count: 1
- Files: src/runtime/events.ts, events.ts:293-299
- Evidence: events.ts:299 `return result.success ? (result.data as SmithersEvent) : null;` — comment at lines 293-295 explains Zod 4's discriminatedUnion inference doesn't match hand-written interfaces. The cast papers over a type-system gap between two sources of truth.
- Accept if: The hand-written interface and Zod schema have structurally diverged and unifying them is non-trivial
- Dismiss if: The cast is a temporary workaround until Zod 4 fixes discriminatedUnion inference

```diff
Derive `SmithersEvent` from Zod's `z.infer<typeof smithersEventSchema>` instead of hand-writing the interface. This makes Zod the single source of truth and eliminates the cast.
```

