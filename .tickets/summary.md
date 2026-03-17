# Improvinho Review - 2026-03-17

## Critical (0)
No findings.

## High (3)
### IMP-0001 - event-bridge.ts duplicates the entire row-type system and parsing logic from workflow/state.ts and workflow/snapshot.ts to read the same underlying data from SQLite
- Kind: architecture
- Confidence: high
- Seen by: app-logic-architecture
- Scopes: src
- Support count: 1
- Files: src/runtime/event-bridge.ts, src/runtime/event-bridge.ts:332-410, src/runtime/event-bridge.ts:49-83, src/workflows/ralphinho/workflow/state.ts:8-55
- Evidence: event-bridge.ts (lines 49-83) defines its own Zod schemas for final_review, implement, test, and review_fix rows, then manually maps snake_case columns to camelCase types (lines 332-410). These produce exactly the same FinalReviewRow, ImplementRow, TestRow, ReviewFixRow types already defined in workflow/state.ts (lines 21-55). event-bridge then calls buildOutputSnapshot and getDecisionAudit from the workflow layer (lines 419-440), proving both modules need the same domain types. The difference is only the entry point: ctx.outputs() vs raw SQLite. A single 'fromSqliteRow' adapter per type in workflow/state.ts would let event-bridge reuse the canonical types without reimplementing Zod schemas and manual mapping for every table.
- Accept if: Confirm that event-bridge.ts and workflow/state.ts model the same domain rows, and that adding a fromSqliteRow factory per type in state.ts would eliminate the parallel schema definitions in event-bridge.ts.
- Dismiss if: The monitor's read-only polling has deliberately different validation tolerance (e.g. accepting partial rows) that would conflict with the workflow layer's strict requirements.

### IMP-0002 - snapshot.ts hand-rolls ~70 lines of row validators that duplicate Smithers' Zod write-path validation
- Kind: simplification
- Confidence: high
- Seen by: type-system-purist
- Scopes: src
- Support count: 1
- Files: src/workflows/ralphinho/workflow/snapshot.ts, src/workflows/ralphinho/schemas.ts:53-114, src/workflows/ralphinho/workflow/snapshot.ts:116-118, src/workflows/ralphinho/workflow/snapshot.ts:38-40, src/workflows/ralphinho/workflow/snapshot.ts:48-112
- Evidence: Smithers validates all output via Zod before writing to SQLite (smithers/src/db/output.ts:126-140, `validateOutput` calls `createInsertSchema(table).safeParse(payload)`). When `ctx.outputs(table)` is called, rows have already passed Zod validation. Yet snapshot.ts:48-112 builds `requireObject`, `requireBoolean`, `requireString`, `validateTestRow`, `validateFinalReviewRow`, `validateImplementRow`, `validateReviewFixRow` — all re-checking the same fields (e.g. `testsPassed` is boolean, `reasoning` is string) that the Zod schemas in `schemas.ts` already guarantee. The comment at line 120-122 says these guard against 'schema drift', but schema drift would require updating the Zod schemas in schemas.ts anyway — the validators can't catch a mismatch the Zod schemas don't encode. The `runtimeOutputs()` function at line 38-40 casts `ctx` to `unknown` to call `.outputs(table)` as untyped, then manually validates every row — directly distrusting the typed SmithersCtx<ScheduledOutputs> contract.
- Accept if: Smithers validates output via Zod on the write path and ctx.outputs() returns those same rows. The hand-rolled validators are provably redundant.
- Dismiss if: There is a known scenario where Smithers writes rows that bypass Zod validation, making the validators a genuine second line of defense.

```diff
- function runtimeOutputs(ctx: SmithersCtx<ScheduledOutputs>, table: string): unknown[] {
-   return (ctx as unknown as { outputs: (t: string) => unknown[] }).outputs(table);
- }
+ // Use ctx.outputs directly — Smithers validates on write.
+ // Cast the ctx.outputs call properly via the typed interface.

- const testRows = runtimeOutputs(ctx, "test").map(validateTestRow);
+ const testRows = ctx.outputs("test") as TestRow[];
  // (repeat for finalReview, implement, reviewFix)
  // Delete requireObject, requireBoolean, requireString, validate*Row (~65 lines)
```

### IMP-0003 - snapshot.ts contains ~65 lines of hand-rolled runtime validators that duplicate the Zod schema guarantees already enforced by Smithers at write time
- Kind: simplification
- Confidence: high
- Seen by: refactor-hunter, app-logic-architecture
- Scopes: src
- Support count: 2
- Files: src/workflows/ralphinho/workflow/snapshot.ts, src/workflows/ralphinho/schemas.ts:43-113, src/workflows/ralphinho/schemas.ts:43-114, src/workflows/ralphinho/workflow/snapshot.ts:13-112, src/workflows/ralphinho/workflow/snapshot.ts:48-112
- Evidence: The Zod schemas in schemas.ts (lines 43-114) define `implement` with `believesComplete: z.boolean()`, `whatWasDone: z.string()`, etc. Smithers validates these schemas when tasks write output. Yet snapshot.ts (lines 48-112) re-validates the same fields with `requireBoolean(r, 'believesComplete', 'implement')`, `requireString(r, 'whatWasDone', 'implement')`, etc. The `normalizeMergeQueueRow` (lines 13-31) similarly re-checks what the merge_queue Zod schema already enforces. This is 65+ lines of defensive code protecting against states that the framework prevents.
- Accept if: Smithers validates output against the Zod schema before persisting rows, which it does (createSmithers auto-generates tables from schemas and validates on write).
- Dismiss if: There is a concrete runtime path where rows bypass Zod validation (e.g. manual DB inserts or schema migration gaps).

```diff
Replace the validate* functions and normalizeMergeQueueRow with simple casts:

- function validateTestRow(row: unknown): TestRow { ... }
+ // Smithers validates via Zod at write time; cast is safe here.
+ const testRows = runtimeOutputs(ctx, 'test') as TestRow[];

Same pattern for finalReviewRows, implementRows, reviewFixRows, mergeQueueRows.
```

## Medium (7)
### IMP-0004 - event-bridge.ts manually typeof-checks every field of parsed merge_queue JSON instead of reusing existing Zod schemas
- Kind: simplification
- Confidence: high
- Seen by: type-system-purist
- Scopes: src
- Support count: 1
- Files: src/runtime/event-bridge.ts, src/runtime/event-bridge.ts:270-326, src/runtime/event-bridge.ts:97-126, src/workflows/ralphinho/schemas.ts:187-206
- Evidence: In event-bridge.ts:270-326, after Zod-validating merge_queue rows (line 263-268), the inner JSON strings (tickets_landed, tickets_evicted, tickets_skipped) are parsed via `parseObjectArray` and then each object's fields are individually typeof-checked: `typeof item.ticketId === 'string'` (line 275), `typeof item.mergeCommit === 'string'` (line 278), `typeof item.summary === 'string'` (line 279), `typeof item.decisionIteration === 'number'` (line 280), etc. The merge_queue Zod schema in schemas.ts:187-206 already defines the exact shapes of these inner objects (ticketsLanded, ticketsEvicted, ticketsSkipped). The event-bridge could parse the inner JSON with `.parse()` on the existing schema instead of ~50 lines of manual typeof guards with fallback defaults that silently convert invalid data.
- Accept if: The merge_queue Zod schema in schemas.ts accurately describes the shape of the inner JSON objects. Using z.array(ticketLandedSchema).safeParse() would replace ~50 lines of manual typeof checks.
- Dismiss if: The inner JSON format in SQLite intentionally diverges from the Zod schema (e.g., different field names or types), making reuse impossible.

### IMP-0005 - Near-duplicate markdown table builders in AgenticMergeQueue and PushAndCreatePR
- Kind: simplification
- Confidence: high
- Seen by: refactor-hunter
- Scopes: src
- Support count: 1
- Files: src/workflows/ralphinho/components/AgenticMergeQueue.tsx, src/workflows/ralphinho/components/AgenticMergeQueue.tsx:54-70, src/workflows/ralphinho/components/PushAndCreatePR.tsx:41-53
- Evidence: AgenticMergeQueue.tsx `buildQueueStatusTable` (lines 54-70) and PushAndCreatePR.tsx `buildTicketTable` (lines 41-53) both: (1) build a markdown table header with | # | Ticket ID | Title | ... |, (2) iterate tickets mapping to table rows, (3) compute a fileSummary by spreading filesModified + filesCreated and slicing to 5 entries with a (+N more) suffix. The only difference is AgenticMergeQueue adds Category/Priority columns and sorts by priority. This is textbook copy-paste-modify.
- Accept if: Both functions will continue to evolve together (same ticket concept).
- Dismiss if: The two prompt formats are expected to diverge significantly.

```diff
Extract a shared `buildTicketMarkdownTable` into a shared utility (e.g. `components/runtimeNames.ts` or a new `components/prompt-utils.ts`) that accepts a column definition and ticket array. Both components call it with their specific columns.
```

### IMP-0006 - ScheduledWorkflow component inlines ~50 lines of failure-reason computation that belongs in the workflow domain layer
- Kind: architecture
- Confidence: high
- Seen by: app-logic-architecture
- Scopes: src
- Support count: 1
- Files: src/workflows/ralphinho/components/ScheduledWorkflow.tsx, src/workflows/ralphinho/components/ScheduledWorkflow.tsx:109-156, src/workflows/ralphinho/workflow/state.ts:185-227
- Evidence: ScheduledWorkflow.tsx lines 109-156 build a failedUnits array with complex logic: iterating all stages in reverse to find the last completed stage, computing eviction context, checking test status, checking decision audit status, and handling edge cases like 'landed without semantic completion'. This is pure domain logic with no JSX involvement — it doesn't reference React, components, or rendering. The workflow/ directory already has the right abstractions: decisions.ts has getDecisionAudit, state.ts has getUnitState/getEvictionContext. This failure-reason computation should be a function like buildFailedUnitReport(snapshot, units, ctx, maxPasses) in state.ts or a new workflow/reports.ts, consistent with how buildMergeTickets already lives in state.ts.
- Accept if: The failure-reason computation (lines 109-156) uses no React or JSX APIs and could be extracted to the workflow/ layer without changing the component's behavior.

### IMP-0007 - getFinalDecision and isSemanticallyComplete are exported but never called from production code — dead exports
- Kind: simplification
- Confidence: high
- Seen by: refactor-hunter
- Scopes: src
- Support count: 1
- Files: src/workflows/ralphinho/workflow/decisions.ts, src/workflows/ralphinho/workflow/decisions.ts:161-171
- Evidence: grep for `getFinalDecision(` across src/ returns only the definition at decisions.ts:161. grep for `isSemanticallyComplete(` returns the definition at decisions.ts:169 and a test at state.test.ts:430. Neither function is imported or called by any production module (ScheduledWorkflow.tsx, state.ts, etc.). The ScheduledWorkflow computes `isSemanticComplete` inline via `unitAudit(unitId).semanticallyComplete` (line 95), bypassing `isSemanticallyComplete`. Similarly, `getFinalDecision` is unused — callers use `getDecisionAudit` directly.
- Accept if: No external consumers import these functions (check package exports).
- Dismiss if: These are part of a public API consumed by downstream packages.

```diff
Delete `getFinalDecision` (lines 161-163) and `isSemanticallyComplete` (lines 169-171). Update the test that calls `isSemanticallyComplete` to call `getDecisionAudit(...).semanticallyComplete` directly.
```

### IMP-0008 - isMergeEligible and isSemanticallyComplete are convenience wrappers that recompute the full decision audit, causing redundant work when callers already have or could share the audit
- Kind: simplification
- Confidence: high
- Seen by: app-logic-architecture
- Scopes: src
- Support count: 1
- Files: src/workflows/ralphinho/workflow/decisions.ts, src/workflows/ralphinho/components/ScheduledWorkflow.tsx:91-93, src/workflows/ralphinho/workflow/decisions.ts:161-171, src/workflows/ralphinho/workflow/state.ts:195-209
- Evidence: In buildMergeTickets (state.ts:209), getDecisionAudit is called for every unit to build eligibilityProof. But the caller ScheduledWorkflow.tsx:91-93 already builds an auditMap with getDecisionAudit for every unit. And buildMergeTickets also calls isMergeEligible (state.ts:195) which calls getDecisionAudit again internally (decisions.ts:165-166). So for each merge-eligible unit, the full audit derivation (deriveDurableDecisionHistory, history scanning) runs 2-3 times per render. decisions.ts exports isMergeEligible/isSemanticallyComplete/getFinalDecision (lines 161-171) as standalone functions that each independently call getDecisionAudit — they are convenience wrappers that encourage callers to recompute rather than share the audit object.
- Accept if: getDecisionAudit is called multiple times per unit per render cycle via both direct calls and the convenience wrappers.
- Dismiss if: The audit computation is trivially cheap (few rows per unit) and the codebase intentionally favors readability of standalone functions over performance.

```diff
Either (a) make buildMergeTickets accept the pre-computed auditMap, or (b) replace the standalone wrappers with methods on DecisionAudit so callers naturally reuse the already-computed object: audit.mergeEligible (already a field) instead of isMergeEligible(snapshot, unitId).
```

### IMP-0009 - isUnitLanded in state.ts is a pure pass-through that adds no logic over snapshot.isUnitLanded
- Kind: simplification
- Confidence: high
- Seen by: refactor-hunter
- Scopes: src
- Support count: 1
- Files: src/workflows/ralphinho/workflow/state.ts, src/workflows/ralphinho/workflow/state.ts:83-85
- Evidence: state.ts lines 83-85:
```
export function isUnitLanded(snapshot: OutputSnapshot, unitId: string): boolean {
  return snapshot.isUnitLanded(unitId);
}
```
This wrapper adds zero logic — it just forwards to the snapshot method. All 6 call sites (state.ts:88, 94, 104, 108, 193 and ScheduledWorkflow.tsx:86) could call `snapshot.isUnitLanded(unitId)` directly. The wrapper creates indirection without benefit.
- Accept if: No downstream consumers rely on the two-arg signature as a public API.
- Dismiss if: The function is intentionally an API boundary for testability (snapshot is hard to mock but plain functions aren't).

```diff
Delete the `isUnitLanded` function export. Replace internal call sites with `snapshot.isUnitLanded(unitId)`. For ScheduledWorkflow.tsx, change `isUnitLanded(snapshot, unitId)` to `snapshot.isUnitLanded(unitId)` — the lambda on line 86 already captures `snapshot`.
```

### IMP-0010 - Row types declare nodeId/iteration as optional despite Smithers always providing them, causing pervasive `?? 0` silent fallbacks
- Kind: simplification
- Confidence: high
- Seen by: type-system-purist
- Scopes: src
- Support count: 1
- Files: src/workflows/ralphinho/workflow/state.ts, src/workflows/ralphinho/workflow/decisions.ts:36, src/workflows/ralphinho/workflow/decisions.ts:41, src/workflows/ralphinho/workflow/decisions.ts:54, src/workflows/ralphinho/workflow/decisions.ts:58, src/workflows/ralphinho/workflow/decisions.ts:75, src/workflows/ralphinho/workflow/state.ts:21-55
- Evidence: state.ts:21-55 declares `nodeId?: string` and `iteration?: number` on TestRow, FinalReviewRow, ImplementRow, ReviewFixRow. But Smithers' context.ts:65-68 and 94-103 always attaches nodeId and iteration to every row (it's how `latest()` and `resolveRow()` filter). In decisions.ts, every use of iteration does `row.iteration ?? 0`: lines 36, 41, 54, 58, 75. These fallbacks silently produce wrong iteration=0 values instead of failing if the invariant ever breaks. The types should reflect the runtime guarantee (required fields), not distrust it. The optional typing propagates distrust through the entire decision audit pipeline.
- Accept if: Smithers always provides nodeId and iteration on every output row (verified in smithers/src/context.ts:65-67 and 94-96). Making these required is correct.
- Dismiss if: There is a code path where these rows are constructed without Smithers (e.g., in tests or the event-bridge) that legitimately omits nodeId/iteration.

```diff
- export type TestRow = {
-   nodeId?: string;
-   iteration?: number;
+ export type TestRow = {
+   nodeId: string;
+   iteration: number;
    testsPassed: boolean;
    buildPassed: boolean;
    failingSummary?: string | null;
  };
  // (same change for FinalReviewRow, ImplementRow, ReviewFixRow)
  // Then remove all `?? 0` fallbacks in decisions.ts
```

## Low (2)
### IMP-0011 - buildResearchInputSignature and buildPlanInputSignature are trivial JSON.stringify wrappers that add no logic beyond type-constraining the argument
- Kind: simplification
- Confidence: high
- Seen by: refactor-hunter
- Scopes: src
- Support count: 1
- Files: src/workflows/ralphinho/workflow/contracts.ts, src/workflows/ralphinho/workflow/contracts.ts:91-119
- Evidence: contracts.ts lines 113-118:
```
export function buildResearchInputSignature(input: ResearchSignatureInput): string {
  return JSON.stringify(input);
}
export function buildPlanInputSignature(input: PlanSignatureInput): string {
  return JSON.stringify(input);
}
```
Both functions are `JSON.stringify` with a typed parameter. The types `ResearchSignatureInput` and `PlanSignatureInput` (lines 91-111) are only used here and never referenced elsewhere. The type constraint could be achieved inline at the call site with a `satisfies` expression or just by passing the correct literal object.
- Accept if: You want to reduce indirection and the signature format never needs to change from JSON.stringify.
- Dismiss if: You plan to switch to a hash-based signature (like improvinho uses sha1) and want a single place to change it.

### IMP-0012 - Ten individually named retry policy exports could collapse into a single STAGE_RETRY_POLICIES map
- Kind: simplification
- Confidence: medium
- Seen by: refactor-hunter
- Scopes: src
- Support count: 1
- Files: src/workflows/ralphinho/workflow/contracts.ts, src/workflows/ralphinho/workflow/contracts.ts:68-89
- Evidence: contracts.ts lines 80-89 exports 10 constants: RESEARCH_RETRY_POLICY, PLAN_RETRY_POLICY, IMPLEMENT_RETRY_POLICY, TEST_RETRY_POLICY, REVIEW_RETRY_POLICY, REVIEW_FIX_RETRY_POLICY, FINAL_REVIEW_RETRY_POLICY, LEARNINGS_RETRY_POLICY, MERGE_QUEUE_RETRY_POLICY, PR_CREATION_RETRY_POLICY. Each is assigned either FAIL_FAST_RETRY_POLICY or BACKOFF_RETRY_POLICY. A single `Record<StageName | 'merge-queue' | 'pr-creation', StageRetryPolicy>` map would remove 10 export lines and make the mapping explicit.
- Accept if: You want to reduce the export surface and make the stage→policy mapping scannable in one place.
- Dismiss if: Individual exports are preferred for tree-shaking or for import clarity at call sites.

