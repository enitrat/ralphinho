# Research: Ralphinho Contracts & Components Cleanup

## Summary

This unit consolidates redundancy across `contracts.ts`, `types.ts`, and three component files (`QualityPipeline.tsx`, `AgenticMergeQueue.tsx`, `PushAndCreatePR.tsx`). It covers 8 IMP findings: IMP-0004, IMP-0005, IMP-0008, IMP-0009, IMP-0010, IMP-0012, IMP-0013, IMP-0014, IMP-0016.

## Files to Modify

### Primary targets

| File | Path | Changes |
|------|------|---------|
| contracts.ts | `src/workflows/ralphinho/workflow/contracts.ts` | Delete `StageTableName` type (L14-23), remove `as StageTableName` casts from `DISPLAY_STAGES` (L66-74), delete 10 `*_RETRIES` alias constants (L127-136) |
| types.ts | `src/workflows/ralphinho/types.ts` | Delete `SCHEDULED_TIERS` (L59-79), keep `ScheduledTier` but derive from contracts.ts's `TIER_STAGES` |
| QualityPipeline.tsx | `src/workflows/ralphinho/components/QualityPipeline.tsx` | Replace `*_RETRIES` imports with inline `.retries`; fix `buildIssueList` to accept `Issue[]`; fix `tierHasStep` to use `ScheduledTier`/`StageName` params |
| AgenticMergeQueue.tsx | `src/workflows/ralphinho/components/AgenticMergeQueue.tsx` | Delete local `mergeQueueResultSchema`; import/derive from `scheduledOutputSchemas.merge_queue`; fix props types (SmithersCtx<ScheduledOutputs>, AgentLike, etc.) |
| PushAndCreatePR.tsx | `src/workflows/ralphinho/components/PushAndCreatePR.tsx` | Delete local `prCreationResultSchema`; import/derive from `scheduledOutputSchemas.pr_creation`; fix props types |
| contracts.test.ts | `src/workflows/ralphinho/workflow/__tests__/contracts.test.ts` | Delete tautological alias assertions (L26-27, L33-34) |

### Secondary (re-export updates)

| File | Path | Changes |
|------|------|---------|
| index.ts (ralphinho) | `src/workflows/ralphinho/index.ts` | Remove `SCHEDULED_TIERS` from types re-export; possibly re-export from contracts or keep `ScheduledTier` type only |
| index.ts (root) | `src/index.ts` | Remove `SCHEDULED_TIERS` from re-exports |

### Reference files (read-only)

| File | Path | Purpose |
|------|------|---------|
| schemas.ts | `src/workflows/ralphinho/schemas.ts` | Source of truth for `scheduledOutputSchemas`, `issueSchema` |
| smithers-orchestrator.d.ts | `src/types/smithers-orchestrator.d.ts` | Type declarations for `SmithersCtx`, `AgentLike`, `TaskProps` |

## Detailed Findings

### 1. SCHEDULED_TIERS duplication (IMP-0005)

- **types.ts:59-79** defines `SCHEDULED_TIERS` with `as const` and derives `ScheduledTier` from it
- **contracts.ts:43-63** defines `TIER_STAGES` with identical stage arrays, typed as `Record<ScheduledTier, readonly StageName[]>`
- Consumers: `TIER_STAGES` is used in QualityPipeline.tsx, ScheduledWorkflow.tsx, projections, monitor UI. `SCHEDULED_TIERS` is re-exported from `index.ts` and `src/index.ts` but no direct consumer outside re-exports was found.
- **Plan**: Delete `SCHEDULED_TIERS` from types.ts. Keep `TIER_STAGES` in contracts.ts as single source. Derive `ScheduledTier` from `TIER_STAGES` in contracts.ts: `export type ScheduledTier = keyof typeof TIER_STAGES`. Update re-exports in index.ts files.

### 2. *_RETRIES alias constants (IMP-0012, IMP-0013, IMP-0016)

- **contracts.ts:127-136** has 10 constants like `RESEARCH_RETRIES = RESEARCH_RETRY_POLICY.retries`
- All 3 consumer components already import both the alias AND the policy object
- **QualityPipeline.tsx**: Uses `retries={RESEARCH_RETRIES}` and `meta={{ retryPolicy: RESEARCH_RETRY_POLICY }}` — can use `.retries` inline
- **AgenticMergeQueue.tsx:5**: Imports `MERGE_QUEUE_RETRIES` and `MERGE_QUEUE_RETRY_POLICY`, uses both
- **PushAndCreatePR.tsx:5**: Imports `PR_CREATION_RETRIES` and `PR_CREATION_RETRY_POLICY`, uses both
- **Plan**: Delete L127-136 from contracts.ts. Replace `retries={FOO_RETRIES}` with `retries={FOO_RETRY_POLICY.retries}` in all 3 components.

### 3. StageTableName type (IMP-0014)

- **contracts.ts:14-23** defines `StageTableName` as a string literal union of 9 values
- Only referenced as `as StageTableName` casts in `DISPLAY_STAGES` (L66-74)
- No function parameter, return type, or variable uses it as a constraint
- With `as const` on `DISPLAY_STAGES`, the literal types are already narrowed
- **Plan**: Delete `StageTableName`. Remove all `as StageTableName` casts. If needed later, derive: `type StageTableName = typeof DISPLAY_STAGES[number]['table']`.

### 4. Local schema duplication (IMP-0008)

- **AgenticMergeQueue.tsx:7-27** defines `mergeQueueResultSchema` — matches `scheduledOutputSchemas.merge_queue` in schemas.ts:184-204
- **PushAndCreatePR.tsx:9-22** defines `prCreationResultSchema` — matches `scheduledOutputSchemas.pr_creation` in schemas.ts:166-179
- `mergeQueueResultSchema` is re-exported from `index.ts` (line 6)
- **Plan**: Delete local schemas. Import from schemas.ts. Derive types: `export type MergeQueueResult = z.infer<typeof scheduledOutputSchemas.merge_queue>`. Update index.ts re-export.

### 5. Props with `any` types (IMP-0004)

- **AgenticMergeQueueProps** (L48-64): `ctx: SmithersCtx<any>`, `outputs: any`, `agent: any`, `fallbackAgent?: any`, `output: any`
- **PushAndCreatePRProps** (L39-49): `ctx: SmithersCtx<any>`, `agent: any`, `fallbackAgent?: any`, `output: any`
- Available proper types: `SmithersCtx<ScheduledOutputs>` from QualityPipeline.tsx, `AgentLike` from smithers-orchestrator, `ScheduledOutputs` from QualityPipeline.tsx
- Note: `output` prop passes `outputs.merge_queue` or `outputs.pr_creation` — typed as the specific Zod schema
- **Plan**: Replace `ctx: SmithersCtx<any>` → `ctx: SmithersCtx<ScheduledOutputs>`, `outputs: any` → `outputs: ScheduledOutputs`, `agent: any` → `agent: AgentLike | AgentLike[]`, `fallbackAgent?: any` → `fallbackAgent?: AgentLike`, `output: any` → proper type from ScheduledOutputs

### 6. buildIssueList untyped (IMP-0009)

- **QualityPipeline.tsx:96-109**: Takes `unknown`, manually checks `Array.isArray`, casts to `{ severity?, description?, file? }`
- `issueSchema` in schemas.ts:11-17 already defines the shape with `severity: z.enum(["critical","major","minor"])`, `description: z.string()`, `file: z.string().nullable()`
- Callers pass `prdReview?.issues` and `codeReview?.issues` which come from validated Zod output
- **Note**: `issueSchema` is not exported from schemas.ts — it's a local const. Need to export it.
- **Plan**: Export `issueSchema` from schemas.ts. Create `type Issue = z.infer<typeof issueSchema>`. Change signature to `buildIssueList(issues: Issue[] | null | undefined): string[]`.

### 7. tierHasStep stringly typed (IMP-0010)

- **QualityPipeline.tsx:81-86**: Takes `tier: string, step: string`, casts `tier as keyof typeof TIER_STAGES`, falls back to `TIER_STAGES.large`
- All callers pass `unit.tier` (typed `ScheduledTier`) and string literals that are `StageName`
- **Plan**: Change to `tierHasStep(tier: ScheduledTier, step: StageName): boolean { return (TIER_STAGES[tier] as readonly string[]).includes(step); }`

### 8. Tautological test assertions (IMP-0012 tests)

- **contracts.test.ts:26-27**: `expect(RESEARCH_RETRY_POLICY.retries).toBe(RESEARCH_RETRIES)` — tests alias identity
- **contracts.test.ts:33-34**: Same for IMPLEMENT/TEST
- **Plan**: Remove these 4 assertions. Keep the `kind` assertions (`toBe("backoff")`, `toBe("fail-fast")`).

## Type dependency chain

```
schemas.ts (issueSchema, scheduledOutputSchemas)
  ← QualityPipeline.tsx (ScheduledOutputs = typeof scheduledOutputSchemas)
  ← AgenticMergeQueue.tsx (needs ScheduledOutputs for props)
  ← PushAndCreatePR.tsx (needs ScheduledOutputs for props)

types.ts (ScheduledTier — will move derivation to contracts.ts)
  ← contracts.ts (TIER_STAGES uses ScheduledTier — will self-derive)
  ← QualityPipeline.tsx (tierHasStep params)

smithers-orchestrator.d.ts (AgentLike, SmithersCtx)
  ← AgenticMergeQueue.tsx
  ← PushAndCreatePR.tsx
```

## Import changes summary

### contracts.ts
- Remove `import type { ScheduledTier } from "../types"` — will define locally
- Add `export type ScheduledTier = keyof typeof TIER_STAGES`

### QualityPipeline.tsx
- Remove all `*_RETRIES` imports (RESEARCH_RETRIES, PLAN_RETRIES, etc.)
- Add `import type { StageName } from "../workflow/contracts"`
- Add `import { issueSchema } from "../schemas"` (or type import)

### AgenticMergeQueue.tsx
- Remove `z` import and local schema
- Add `import { scheduledOutputSchemas } from "../schemas"`
- Add `import type { AgentLike } from "smithers-orchestrator"`
- Add `import type { ScheduledOutputs } from "./QualityPipeline"` (or re-export)

### PushAndCreatePR.tsx
- Remove `z` import and local schema
- Add `import { scheduledOutputSchemas } from "../schemas"`
- Add `import type { AgentLike } from "smithers-orchestrator"`
- Add `import type { ScheduledOutputs } from "./QualityPipeline"`

### index.ts (ralphinho)
- Remove `SCHEDULED_TIERS` from types re-export
- Update `mergeQueueResultSchema` re-export source (or derive from scheduledOutputSchemas)

### index.ts (root)
- Remove `SCHEDULED_TIERS` from re-exports

## Open Questions

1. **issueSchema export**: It's currently a local `const` in schemas.ts — exporting it is a minor API change. Should it be exported as `issueSchema` or under a different name?
2. **ScheduledOutputs location**: Currently defined in QualityPipeline.tsx as `export type ScheduledOutputs = typeof scheduledOutputSchemas`. Should it move to schemas.ts or a shared types file so AgenticMergeQueue and PushAndCreatePR can import without depending on QualityPipeline?
3. **mergeQueueResultSchema re-export**: `index.ts` re-exports `mergeQueueResultSchema` from AgenticMergeQueue.tsx. After deletion, should we re-export `scheduledOutputSchemas.merge_queue` directly or create an alias?
4. **DISPLAY_STAGES without casts**: After removing `as StageTableName`, does TypeScript correctly infer the table string literals via `as const`? Need to verify.
