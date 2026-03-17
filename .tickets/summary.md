# Improvinho Review - 2026-03-17

## Critical (0)
No findings.

## High (6)
### IMP-0001 - event-bridge.ts (445 lines) manually queries 6 SQLite tables, parses rows with hand-rolled normalization, and constructs an OutputSnapshot — duplicating the exact same data shape that workflow/snapshot.ts already provides via buildSnapshot(). The event-bridge exists because the monitor reads from the DB directly (no SmithersCtx), but the OutputSnapshot interface was designed to be the single source of truth for unit state. The duplication means any schema change to merge_queue, test, final_review, implement, or review_fix must be updated in two places.
- Kind: architecture
- Confidence: high
- Seen by: app-logic-architecture
- Scopes: src
- Support count: 1
- Files: src/runtime/event-bridge.ts, src/runtime/event-bridge.ts:243-383, src/workflows/ralphinho/workflow/snapshot.ts:49-79
- Evidence: event-bridge.ts lines 243-383 construct maps for finalReviewByUnit, implementByUnit, testByUnit, reviewFixByUnit and then build an OutputSnapshot with latestTest, latestFinalReview, latestImplement, freshTest, testHistory, finalReviewHistory, implementHistory, reviewFixHistory, isUnitLanded — identical interface to workflow/snapshot.ts:buildSnapshot() (lines 49-79). Both use the same MergeQueueRow, TestRow, FinalReviewRow, ImplementRow, ReviewFixRow types from workflow/state.ts. The event-bridge version parses from raw SQL; the snapshot version reads from SmithersCtx. The OutputSnapshot interface could be constructed from a shared row-mapping layer rather than two separate implementations.
- Accept if: Both files construct the same OutputSnapshot interface shape with the same row types, and changes to one require mirroring in the other.
- Dismiss if: The monitor's polling path has fundamentally different performance requirements that justify a separate implementation (e.g., it must avoid loading SmithersCtx).

### IMP-0002 - src/runtime/events.ts has ~230 lines of hand-rolled type-narrowing guards (isRecord, isString, isNumber, isNullableString, isStageName, isDecisionStatus) and a massive switch-based parseEvent function that manually reconstructs each event variant field-by-field. The codebase already depends on Zod everywhere (schemas.ts, types.ts, config/types.ts). A Zod discriminated union with .safeParse() would replace the entire parseEvent function and all six guard helpers with ~60 lines of schema declarations, getting compile-time type inference for free.
- Kind: simplification
- Confidence: high
- Seen by: app-logic-architecture
- Scopes: src
- Support count: 1
- Files: src/runtime/events.ts, src/runtime/events.ts:135-157, src/runtime/events.ts:159-361
- Evidence: Lines 135-157 define 6 manual narrowing guards. Lines 159-361 define parseEvent with 12 switch cases, each manually checking fields and reconstructing the event object. Compare with src/config/types.ts which uses `z.discriminatedUnion('mode', [...])` for the same pattern (structured union parsing) in 6 lines. Smithers upstream (SmithersEvent.ts) uses a TypeScript discriminated union type — the parsing concern is a consumer-side need, and Zod is the tool this codebase already chose for that.
- Accept if: The codebase already uses Zod for every other structured parsing boundary (config, schemas, types). Replacing the manual guards with Zod schemas is a strict simplification.
- Dismiss if: There is a measured performance reason to avoid Zod .safeParse() in this hot path (e.g., parsing millions of events per second in the monitor).

### IMP-0003 - normalizePart, confidenceRank, and priorityRank are copy-pasted between projection.ts and ReviewSlicePipeline.tsx
- Kind: simplification
- Confidence: high
- Seen by: refactor-hunter
- Scopes: src
- Support count: 1
- Files: src/workflows/improvinho/components/ReviewSlicePipeline.tsx, src/workflows/improvinho/components/ReviewSlicePipeline.tsx:63-86, src/workflows/improvinho/projection.ts:39-62
- Evidence: projection.ts:39-62 defines normalizePart, priorityRank, confidenceRank. ReviewSlicePipeline.tsx:63-86 defines the exact same three functions with identical logic. Both are used in the improvinho workflow — projection.ts for merge-time dedup, ReviewSlicePipeline.tsx for discovery-time dedup. The implementations are character-for-character identical (normalizePart: trim→lowercase→replace non-alnum→strip dashes→fallback "module"; priorityRank: critical=4,high=3,medium=2,low=1; confidenceRank: high=3,medium=2,low=1).
- Accept if: Both call sites use identical signatures and return types

```diff
--- a/src/workflows/improvinho/components/ReviewSlicePipeline.tsx
+++ b/src/workflows/improvinho/components/ReviewSlicePipeline.tsx
-function normalizePart(value: string | null | undefined): string { ... }
-function confidenceRank(confidence: ReviewConfidence): number { ... }
-function priorityRank(priority: ReviewPriority): number { ... }
+import { normalizePart, confidenceRank, priorityRank } from "../projection";
```

### IMP-0004 - AgenticMergeQueue and PushAndCreatePR props use `any` for 5+ typed fields, abandoning the schema-driven type safety the rest of the codebase relies on
- Kind: simplification
- Confidence: high
- Seen by: type-system-purist
- Scopes: src
- Support count: 1
- Files: src/workflows/ralphinho/components/AgenticMergeQueue.tsx, src/workflows/ralphinho/components/AgenticMergeQueue.tsx:48-64, src/workflows/ralphinho/components/PushAndCreatePR.tsx:39-49
- Evidence: AgenticMergeQueueProps (lines 48-64) declares `ctx: SmithersCtx<any>`, `outputs: any`, `agent: any`, `fallbackAgent?: any`, `output: any`. PushAndCreatePRProps (lines 39-49) does the same. The codebase has `ScheduledOutputs` (QualityPipeline.tsx:40) and `AgentLike` (smithers-orchestrator types) that should be used here. The parent ScheduledWorkflow already uses the proper typed `SmithersCtx<ScheduledOutputs>` and `ScheduledOutputs` — these components just throw it away at the boundary.
- Accept if: The component is always called from typed parents (ScheduledWorkflow) that already have the correct types available.
- Dismiss if: These components are intentionally generic and used from multiple workflow types with different schema shapes.

```diff
Replace `ctx: SmithersCtx<any>` with `ctx: SmithersCtx<ScheduledOutputs>`, `outputs: any` with `outputs: ScheduledOutputs`, `agent: any` with `agent: AgentLike | AgentLike[]`, `output: any` with the specific Zod schema type. Same for PushAndCreatePRProps.
```

### IMP-0005 - SCHEDULED_TIERS in types.ts and TIER_STAGES in contracts.ts define the same stage lists for small/large tiers
- Kind: simplification
- Confidence: high
- Seen by: refactor-hunter
- Scopes: src
- Support count: 1
- Files: src/workflows/ralphinho/workflow/contracts.ts, src/workflows/ralphinho/types.ts:59-79, src/workflows/ralphinho/workflow/contracts.ts:43-63
- Evidence: types.ts:59-79 defines SCHEDULED_TIERS = { small: ["implement","test","code-review","review-fix","final-review","learnings"], large: ["research","plan",...] }. contracts.ts:43-63 defines TIER_STAGES with identical values but typed as Record<ScheduledTier, readonly StageName[]>. Both are imported by consumers: TIER_STAGES is used in QualityPipeline.tsx, ScheduledWorkflow.tsx, projections.ts, advanced-monitor-ui.ts. SCHEDULED_TIERS is re-exported from index.ts but only consumed via TIER_STAGES downstream. contracts.ts even imports ScheduledTier from types.ts, creating a circular dependency of concepts.
- Accept if: No consumer needs SCHEDULED_TIERS that couldn't use TIER_STAGES instead
- Dismiss if: SCHEDULED_TIERS is part of an external API contract that must stay in types.ts

```diff
Remove SCHEDULED_TIERS from types.ts. Keep TIER_STAGES in contracts.ts as the single source. Re-export ScheduledTier from contracts.ts.
```

### IMP-0006 - snapshot.ts erases SmithersCtx types with an `as` cast to work around output accessor typing, then re-casts every return value
- Kind: simplification
- Confidence: high
- Seen by: type-system-purist
- Scopes: src
- Support count: 1
- Files: src/workflows/ralphinho/workflow/snapshot.ts, src/workflows/ralphinho/workflow/snapshot.ts:13-16, src/workflows/ralphinho/workflow/snapshot.ts:50, src/workflows/ralphinho/workflow/snapshot.ts:61-70
- Evidence: Line 13-16 defines `SnapshotCapableCtx` with `outputs: (table: string) => unknown` and `outputMaybe: (table: string, where: ...) => unknown`, deliberately loosening the typed `SmithersCtx<ScheduledOutputs>`. Line 50 casts `ctx as SnapshotCapableCtx`. Then lines 61-70 cast every accessor result: `as TestRow | null`, `as FinalReviewRow | null`, `as ImplementRow | null`. This is a round-trip through type erasure: the data is typed by Zod schemas at the boundary, gets erased to `unknown`, then manually re-annotated. The Smithers ctx already provides typed `ctx.latest()` and `ctx.outputs()` — the cast indicates the declared types don't match the runtime access pattern, which should be fixed at the type declaration level, not worked around with casts.
- Accept if: SmithersCtx generic parameter properly types the outputs accessor methods and the casts can be removed.
- Dismiss if: The Smithers runtime actually returns untyped data from ctx.outputs() and the casts are the only way to recover types.

## Medium (8)
### IMP-0007 - ~200 lines of hand-rolled event parsing in events.ts reimplements what Zod discriminatedUnion would do in ~20 lines
- Kind: simplification
- Confidence: high
- Seen by: refactor-hunter, type-system-purist
- Scopes: src
- Support count: 2
- Files: src/runtime/events.ts, src/runtime/events.ts:135-157, src/runtime/events.ts:135-361, src/runtime/events.ts:159-361
- Evidence: runtime/events.ts:135-361 defines 6 type-guard functions (isRecord, isString, isNumber, isNullableString, isStageName, isDecisionStatus) and a 200-line switch statement in parseEvent() that manually validates every field of 11 event types. The codebase already uses Zod everywhere else (schemas.ts, config/types.ts, types.ts). A Zod discriminated union on the `type` field would replace the entire parseEvent function with z.discriminatedUnion('type', [...]).safeParse(value), getting the same validation with automatic error messages and no hand-maintained guard functions.
- Accept if: The event types are stable enough that switching to Zod won't break NDJSON parsing performance requirements
- Dismiss if: Performance profiling shows parseEvent is on a hot path where Zod overhead matters

### IMP-0008 - mergeQueueResultSchema and prCreationResultSchema are defined in both component files and schemas.ts
- Kind: simplification
- Confidence: high
- Seen by: refactor-hunter
- Scopes: src
- Support count: 1
- Files: src/workflows/ralphinho/components/AgenticMergeQueue.tsx, src/workflows/ralphinho/components/AgenticMergeQueue.tsx:7-27, src/workflows/ralphinho/components/PushAndCreatePR.tsx:9-22, src/workflows/ralphinho/schemas.ts:166-179, src/workflows/ralphinho/schemas.ts:184-204
- Evidence: AgenticMergeQueue.tsx:7-27 exports mergeQueueResultSchema. schemas.ts:184-204 defines scheduledOutputSchemas.merge_queue with the exact same Zod shape. PushAndCreatePR.tsx:9-22 exports prCreationResultSchema. schemas.ts:166-179 defines scheduledOutputSchemas.pr_creation with the same shape. The component-local schemas are used only for the exported type (MergeQueueResult, PrCreationResult) while schemas.ts schemas are used by createSmithers for DB table generation. This means the schemas could drift silently — a field added in one place but not the other would cause runtime mismatches.
- Accept if: The component-local schemas add no fields beyond what schemas.ts defines
- Dismiss if: Components are intended to be independently publishable and cannot depend on schemas.ts

```diff
Delete the local schema definitions in AgenticMergeQueue.tsx and PushAndCreatePR.tsx. Import and derive types from schemas.ts: `export type MergeQueueResult = z.infer<typeof scheduledOutputSchemas.merge_queue>`.
```

### IMP-0009 - `buildIssueList` takes `unknown` and manually shapes it, ignoring that the Zod `issueSchema` already validates review issues at the Smithers output boundary
- Kind: simplification
- Confidence: high
- Seen by: type-system-purist
- Scopes: src
- Support count: 1
- Files: src/workflows/ralphinho/components/QualityPipeline.tsx, src/workflows/ralphinho/components/QualityPipeline.tsx:96-109
- Evidence: QualityPipeline.tsx lines 96-109: `function buildIssueList(issues: unknown): string[]` does `Array.isArray(issues)` then casts each element as `{ severity?: string; description?: string; file?: string | null }`. But the callers pass `prdReview?.issues` and `codeReview?.issues`, which come from `ctx.latest('prd_review', ...)` — data validated by the `prd_review` Zod schema (schemas.ts:61-66) that defines `issues: z.array(issueSchema).nullable()` where `issueSchema` has typed `severity`, `description`, and `file` fields. The runtime guard is redundant if the Smithers runtime validates outputs against schemas.
- Accept if: Smithers validates task outputs against the Zod schema before storing them, so ctx.latest() returns typed data.
- Dismiss if: ctx.latest() returns untyped data and the runtime check is genuinely needed.

```diff
```diff
-function buildIssueList(issues: unknown): string[] {
-  if (!Array.isArray(issues)) return [];
-  return issues.map((issue) => {
-    const entry = issue as {
-      severity?: string;
-      description?: string;
-      file?: string | null;
-    };
+type Issue = z.infer<typeof issueSchema>;
+function buildIssueList(issues: Issue[] | null | undefined): string[] {
+  if (!issues) return [];
+  return issues.map((entry) => {
     const sev = entry.severity ? `[${entry.severity}] ` : "";
-    const desc = entry.description ?? "Unspecified issue";
+    const desc = entry.description;
     const file = entry.file ? ` (${entry.file})` : "";
     return `${sev}${desc}${file}`;
   });
 }
```
```

### IMP-0010 - `tierHasStep` uses stringly-typed arguments where `ScheduledTier` and `StageName` types already exist and should drive the branch
- Kind: simplification
- Confidence: high
- Seen by: type-system-purist
- Scopes: src
- Support count: 1
- Files: src/workflows/ralphinho/components/QualityPipeline.tsx, src/workflows/ralphinho/components/QualityPipeline.tsx:81-86
- Evidence: QualityPipeline.tsx line 81-86: `function tierHasStep(tier: string, step: string): boolean` takes raw strings, casts `tier as keyof typeof TIER_STAGES`, and falls back to `TIER_STAGES.large` for unknown tiers. The caller always passes `unit.tier` (typed as `ScheduledTier = 'small' | 'large'`) and string literals like `'research'`, `'plan'` etc. that are `StageName`. Using the proper types eliminates the runtime fallback branch entirely: `function tierHasStep(tier: ScheduledTier, step: StageName): boolean { return TIER_STAGES[tier].includes(step); }`
- Accept if: All callers pass values whose types are already ScheduledTier and StageName.

```diff
```diff
-function tierHasStep(tier: string, step: string): boolean {
-  const stages = TIER_STAGES[tier as keyof typeof TIER_STAGES];
-  return stages
-    ? (stages as readonly string[]).includes(step)
-    : (TIER_STAGES.large as readonly string[]).includes(step);
-}
+function tierHasStep(tier: ScheduledTier, step: StageName): boolean {
+  return (TIER_STAGES[tier] as readonly string[]).includes(step);
+}
```
```

### IMP-0011 - decompose.ts mixes CLI presentation (spinner) and raw HTTP calls into a domain module, bypassing the Smithers agent abstraction
- Kind: architecture
- Confidence: high
- Seen by: refactor-hunter
- Scopes: src
- Support count: 1
- Files: src/workflows/ralphinho/decompose.ts, src/workflows/ralphinho/decompose.ts:157-218, src/workflows/ralphinho/decompose.ts:91-97
- Evidence: decompose.ts:91-97 implements a terminal spinner with setInterval + process.stdout.write inside the domain function decomposeRFC(). Lines 161-184 make a raw fetch() to api.anthropic.com with hardcoded model name, and lines 192-207 fall back to Bun.spawn("claude", ...). This is the only AI call in the codebase that bypasses the Smithers agent pattern (AnthropicAgent, etc.). The spinner is pure CLI presentation leaked into the domain layer — callers like the CLI (init-scheduled.ts) should own presentation. The raw HTTP call creates a maintenance burden separate from the agent configuration used everywhere else.
- Accept if: The decomposition step should use the same agent abstraction as the rest of the workflow
- Dismiss if: decompose.ts is intentionally a standalone pre-workflow CLI tool that should not depend on the Smithers runtime

### IMP-0012 - contracts.ts exports 10 `X_RETRIES` constants that are pure aliases for `X_RETRY_POLICY.retries` defined 2 lines above. Every consumer (QualityPipeline, AgenticMergeQueue, PushAndCreatePR) already imports both the policy and the alias. The aliases add no abstraction — they're just `.retries` property access with an extra name. The test file (contracts.test.ts) then tests that the alias equals the policy's retries field, which is a tautology.
- Kind: simplification
- Confidence: high
- Seen by: app-logic-architecture
- Scopes: src
- Support count: 1
- Files: src/workflows/ralphinho/workflow/contracts.ts, src/workflows/ralphinho/components/QualityPipeline.tsx:20-35, src/workflows/ralphinho/workflow/contracts.ts:127-136
- Evidence: contracts.ts lines 127-136: `export const RESEARCH_RETRIES = RESEARCH_RETRY_POLICY.retries;` repeated for all 10 stages. QualityPipeline.tsx imports both: `RESEARCH_RETRIES` (line 28) and `RESEARCH_RETRY_POLICY` (line 29), then uses both separately — `retries={RESEARCH_RETRIES}` and `meta={{ retryPolicy: RESEARCH_RETRY_POLICY }}`. The consumer could just use `retries={RESEARCH_RETRY_POLICY.retries}`. contracts.test.ts lines 26-34 test `expect(RESEARCH_RETRY_POLICY.retries).toBe(RESEARCH_RETRIES)` — testing the alias identity, not behavior.
- Accept if: Every consumer already imports the policy object alongside the alias constant.
- Dismiss if: There is a plan to decouple the retry count from the policy object (e.g., allowing runtime override of just the count).

```diff
Delete lines 127-136 from contracts.ts. In each consumer, replace `retries={X_RETRIES}` with `retries={X_RETRY_POLICY.retries}`. Remove the tautological tests from contracts.test.ts.
```

### IMP-0013 - 10 *_RETRIES constants are trivial aliases for *_RETRY_POLICY.retries — they add indirection without value
- Kind: simplification
- Confidence: high
- Seen by: refactor-hunter
- Scopes: src
- Support count: 1
- Files: src/workflows/ralphinho/workflow/contracts.ts, src/workflows/ralphinho/workflow/__tests__/contracts.test.ts:26-34, src/workflows/ralphinho/workflow/contracts.ts:127-136
- Evidence: contracts.ts:127-136 exports RESEARCH_RETRIES = RESEARCH_RETRY_POLICY.retries, PLAN_RETRIES = PLAN_RETRY_POLICY.retries, etc. (10 total). Every consumer (QualityPipeline.tsx, AgenticMergeQueue.tsx, PushAndCreatePR.tsx) already imports the corresponding *_RETRY_POLICY for the `meta` prop. So they import both the policy AND the alias: e.g. `import { MERGE_QUEUE_RETRIES, MERGE_QUEUE_RETRY_POLICY }` then use `retries={MERGE_QUEUE_RETRIES}` and `meta={{ retryPolicy: MERGE_QUEUE_RETRY_POLICY }}`. Callers could just write `retries={MERGE_QUEUE_RETRY_POLICY.retries}`. The test in contracts.test.ts that asserts `RESEARCH_RETRY_POLICY.retries === RESEARCH_RETRIES` confirms these are tautological.
- Accept if: No consumer benefits from the indirection (all already import the policy object)

```diff
Delete lines 127-136 in contracts.ts. Replace all `retries={FOO_RETRIES}` with `retries={FOO_RETRY_POLICY.retries}` in QualityPipeline.tsx, AgenticMergeQueue.tsx, PushAndCreatePR.tsx. Delete the tautological test assertions.
```

### IMP-0014 - StageTableName type is unused as a constraint — only appears in `as` casts within DISPLAY_STAGES
- Kind: simplification
- Confidence: high
- Seen by: refactor-hunter
- Scopes: src
- Support count: 1
- Files: src/workflows/ralphinho/workflow/contracts.ts, src/workflows/ralphinho/workflow/contracts.ts:14-23, src/workflows/ralphinho/workflow/contracts.ts:66-74
- Evidence: contracts.ts:14-23 defines StageTableName as a union of 9 string literals. Grep shows it is only referenced 9 times, all on lines 66-74 as `as StageTableName` casts within the DISPLAY_STAGES const. No function parameter, return type, or variable annotation uses StageTableName as a constraint. The `as` casts are also unnecessary because the const assertion (`as const`) already narrows the literal types. The type adds 10 lines that serve no type-safety purpose.
- Accept if: No consumer imports or references StageTableName

```diff
Delete StageTableName (lines 14-23). Remove `as StageTableName` casts from DISPLAY_STAGES entries. If a table-name type is needed, derive it: `type StageTableName = typeof DISPLAY_STAGES[number]['table']`.
```

## Low (3)
### IMP-0015 - sanitizeSegment in runtimeNames.ts is a near-duplicate of normalizePart in projection.ts — both normalize strings to kebab-case slugs
- Kind: simplification
- Confidence: high
- Seen by: refactor-hunter
- Scopes: src
- Support count: 1
- Files: src/workflows/ralphinho/components/runtimeNames.ts, src/workflows/improvinho/projection.ts:39-45, src/workflows/ralphinho/components/runtimeNames.ts:1-7
- Evidence: runtimeNames.ts:1-7 defines sanitizeSegment: toLowerCase → replace non-alnum (plus dots/dashes) → collapse dashes → strip leading/trailing dashes → fallback "run". projection.ts:39-45 defines normalizePart: trim → toLowerCase → replace non-alnum → strip leading/trailing dashes → fallback "module". The only differences: (1) sanitizeSegment preserves dots, (2) different fallback strings. Both serve the same purpose: producing URL/path-safe slugs. A shared normalizeSlug(value, { fallback, allowDots? }) would unify them.
- Accept if: Both can accept a shared implementation with parameterized allowed characters and fallback
- Dismiss if: The dot-preservation in sanitizeSegment is critical and makes sharing impractical

### IMP-0016 - contracts.ts exports 10 redundant `*_RETRIES` constants that are just `.retries` property accesses of the already-exported policy objects
- Kind: simplification
- Confidence: high
- Seen by: type-system-purist
- Scopes: src
- Support count: 1
- Files: src/workflows/ralphinho/workflow/contracts.ts, src/workflows/ralphinho/workflow/contracts.ts:127-136
- Evidence: Lines 127-136 define `RESEARCH_RETRIES = RESEARCH_RETRY_POLICY.retries`, `PLAN_RETRIES = PLAN_RETRY_POLICY.retries`, etc. for all 10 stages. QualityPipeline.tsx imports BOTH the policy and the retries constant (lines 20-37), using the retries constant for `retries={RESEARCH_RETRIES}` and the policy for `meta={{ retryPolicy: RESEARCH_RETRY_POLICY }}`. The retries constants add no value — callers can use `RESEARCH_RETRY_POLICY.retries` directly, or better, the Smithers Task component could derive retries from the policy object if it already accepts a retryPolicy.
- Accept if: No consumer uses the retries constant independently of its parent policy object.
- Dismiss if: Some consumers import only the retries constant without the policy.

```diff
Delete lines 127-136. Replace all `RESEARCH_RETRIES` usages with `RESEARCH_RETRY_POLICY.retries` (or better, have the Task component extract retries from the policy).
```

### IMP-0017 - isTierComplete in state.ts is a single-line forwarding function that just calls isMergeEligible with the same arguments. It adds an indirection layer with no additional logic, validation, or semantic distinction. Its only consumer is ScheduledWorkflow.tsx.
- Kind: simplification
- Confidence: high
- Seen by: app-logic-architecture
- Scopes: src
- Support count: 1
- Files: src/workflows/ralphinho/workflow/state.ts, src/workflows/ralphinho/workflow/state.ts:109-111
- Evidence: state.ts line 109-111: `export function isTierComplete(snapshot: OutputSnapshot, unitId: string): boolean { return isMergeEligible(snapshot, unitId); }`. The original plan (docs/plans/workflow-state-contracts.md) envisioned isTierComplete checking test+build+finalReview separately, but the actual implementation was collapsed to just delegate to isMergeEligible. The name 'isTierComplete' no longer carries distinct semantic meaning from 'isMergeEligible'.
- Accept if: The implementation is a single-line delegation with no added logic or guards.
- Dismiss if: There is intent to add tier-specific completion logic that differs from merge eligibility.

```diff
Replace `isTierComplete(snapshot, unit.id)` with `isMergeEligible(snapshot, unit.id)` in ScheduledWorkflow.tsx and delete isTierComplete from state.ts.
```

