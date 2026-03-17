# Plan: PR Workflow Component

## Overview

Create a `PushAndCreatePR` component as an alternative landing mode to `AgenticMergeQueue`. When `landingMode === "pr"`, the workflow pushes branches and creates GitHub PRs instead of merging directly. This adds a new feature with new public API surface.

## TDD Applies: YES

**Justification**: This adds new observable behavior — a new component (`PushAndCreatePR`), a new zod schema (`prCreationResultSchema`), a new prop (`landingMode`) that changes rendering behavior, and a new output schema key (`pr_creation`). All of these are testable and should have tests before implementation.

## Step-by-Step Plan

### Step 1: Write tests for `prCreationResultSchema`

**File**: `src/workflows/ralphinho/components/__tests__/PushAndCreatePR.test.tsx`

Tests:
- `prCreationResultSchema` validates a valid object with `ticketsPushed`, `ticketsFailed`, `summary`
- `prCreationResultSchema` rejects missing `summary`
- `prCreationResultSchema` allows empty arrays for `ticketsPushed` and `ticketsFailed`
- Each `ticketsPushed` item accepts nullable `prUrl` and `prNumber`

### Step 2: Write tests for `PushAndCreatePR` component rendering

**File**: `src/workflows/ralphinho/components/__tests__/PushAndCreatePR.test.tsx` (same file)

Tests:
- Renders as a `<Task>` with a non-empty prompt when tickets are provided
- Short-circuits with empty result `<Task>` when no tickets are ready (matching AgenticMergeQueue pattern)
- Prompt contains `jj git push --bookmark` instructions
- Prompt contains `gh pr create` instructions

### Step 3: Write tests for `ScheduledWorkflow` `landingMode` prop

**File**: `src/workflows/ralphinho/components/__tests__/ScheduledWorkflow.test.tsx`

Tests:
- Renders `<AgenticMergeQueue>` when `landingMode` is omitted (backward compat)
- Renders `<AgenticMergeQueue>` when `landingMode === "merge"`
- Renders `<PushAndCreatePR>` when `landingMode === "pr"`
- Existing props type accepts no `landingMode` without error

### Step 4: Write test for `pr_creation` schema key

**File**: `src/workflows/ralphinho/components/__tests__/PushAndCreatePR.test.tsx`

Tests:
- `scheduledOutputSchemas.pr_creation` exists and is a zod schema
- Validates the expected shape

### Step 5: Implement `prCreationResultSchema` and `PushAndCreatePR` component

**File to create**: `src/workflows/ralphinho/components/PushAndCreatePR.tsx`

```typescript
// Exports:
export const prCreationResultSchema: z.ZodObject<...>
export type PrCreationResult = z.infer<typeof prCreationResultSchema>
export type PushAndCreatePRTicket = {
  ticketId: string;
  ticketTitle: string;
  branch: string;
  worktreePath: string;
  filesModified: string[];
  filesCreated: string[];
}
export type PushAndCreatePRProps = {
  ctx: SmithersCtx<any>;
  tickets: PushAndCreatePRTicket[];
  agent: any;
  fallbackAgent?: any;
  repoRoot: string;
  baseBranch?: string;
  branchPrefix?: string;
  output: any;
  nodeId?: string;
}
export function PushAndCreatePR(props: PushAndCreatePRProps): JSX.Element
```

**Schema** (`prCreationResultSchema`):
```typescript
z.object({
  ticketsPushed: z.array(z.object({
    ticketId: z.string(),
    branch: z.string(),
    prUrl: z.string().nullable(),
    prNumber: z.number().nullable(),
    summary: z.string(),
  })),
  ticketsFailed: z.array(z.object({
    ticketId: z.string(),
    reason: z.string(),
  })),
  summary: z.string(),
})
```

**Component pattern**: Follow `AgenticMergeQueue` exactly:
- Filter tickets to ready ones
- Short-circuit with empty result if none ready
- Build prompt via `buildPRCreationPrompt()` function
- Return `<Task>` with prompt, agent, retries

**Prompt** instructs the agent to:
1. `jj git push --bookmark {branch}` for each ticket
2. `gh pr create --base {baseBranch} --head {branch} --title "..." --body "..."`
3. Handle already-existing PRs (detect via `gh pr list --head {branch}`, record URL)
4. Handle push failures (record reason, continue to next ticket)
5. Return structured JSON matching `prCreationResultSchema`

### Step 6: Add `pr_creation` to `scheduledOutputSchemas`

**File to modify**: `src/workflows/ralphinho/schemas.ts`

Add after `merge_queue`:
```typescript
pr_creation: z.object({
  ticketsPushed: z.array(z.object({
    ticketId: z.string(),
    branch: z.string(),
    prUrl: z.string().nullable(),
    prNumber: z.number().nullable(),
    summary: z.string(),
  })),
  ticketsFailed: z.array(z.object({
    ticketId: z.string(),
    reason: z.string(),
  })),
  summary: z.string(),
}),
```

### Step 7: Add `PR_CREATION_NODE_ID` and retry policy to contracts

**File to modify**: `src/workflows/ralphinho/workflow/contracts.ts`

Add:
```typescript
export const PR_CREATION_NODE_ID = "pr-creation" as const;
export const PR_CREATION_RETRY_POLICY: StageRetryPolicy = {
  kind: "backoff",
  retries: 2,
  initialDelayMs: 1_000,
  maxDelayMs: 8_000,
};
export const PR_CREATION_RETRIES = PR_CREATION_RETRY_POLICY.retries;
```

### Step 8: Add `landingMode` to `scheduledWorkConfigSchema`

**File to modify**: `src/config/types.ts`

Add to `scheduledWorkConfigSchema.extend({...})`:
```typescript
landingMode: z.enum(["merge", "pr"]).default("merge"),
```

### Step 9: Add `landingMode` prop to `ScheduledWorkflow` and wire conditional rendering

**File to modify**: `src/workflows/ralphinho/components/ScheduledWorkflow.tsx`

Changes:
1. Import `PushAndCreatePR` and `PushAndCreatePRTicket`
2. Import `PR_CREATION_NODE_ID` from contracts
3. Add `landingMode?: "merge" | "pr"` to `ScheduledWorkflowProps` (optional, defaults to `"merge"`)
4. Add `landingMode = "merge"` to destructured props
5. Build PR tickets (simpler than merge tickets — map from units that are merge-eligible)
6. Replace the `<AgenticMergeQueue>` block with conditional:
   ```tsx
   {landingMode === "pr" ? (
     <PushAndCreatePR
       nodeId={PR_CREATION_NODE_ID}
       branchPrefix={unitBranchPrefix}
       ctx={ctx}
       tickets={prTickets}
       agent={agents.mergeQueue}
       fallbackAgent={fallbacks?.mergeQueue}
       output={outputs.pr_creation}
       repoRoot={repoRoot}
       baseBranch={baseBranch}
     />
   ) : (
     <AgenticMergeQueue ... />  // existing code
   )}
   ```

### Step 10: Build a `buildPRTickets()` helper in `workflow/state.ts`

**File to modify**: `src/workflows/ralphinho/workflow/state.ts`

Add a function that builds `PushAndCreatePRTicket[]` from the same merge-eligible units but with a simpler shape (no `eligibilityProof`, just `ticketId`, `ticketTitle`, `branch`, `worktreePath`, `filesModified`, `filesCreated`).

### Step 11: Verify

- Run `bun run typecheck` — no new errors
- Run `bun test` — all new tests pass
- Verify existing call sites compile without changes (no `landingMode` prop required)

## Files to Create

| File | Purpose |
|------|---------|
| `src/workflows/ralphinho/components/PushAndCreatePR.tsx` | New component + schema |
| `src/workflows/ralphinho/components/__tests__/PushAndCreatePR.test.tsx` | Unit tests for component and schema |
| `src/workflows/ralphinho/components/__tests__/ScheduledWorkflow.test.tsx` | Tests for landingMode conditional |

## Files to Modify

| File | Change |
|------|--------|
| `src/workflows/ralphinho/schemas.ts` | Add `pr_creation` output schema |
| `src/workflows/ralphinho/workflow/contracts.ts` | Add `PR_CREATION_NODE_ID`, retry policy |
| `src/config/types.ts` | Add `landingMode` to `scheduledWorkConfigSchema` |
| `src/workflows/ralphinho/components/ScheduledWorkflow.tsx` | Add `landingMode` prop, conditional rendering |
| `src/workflows/ralphinho/workflow/state.ts` | Add `buildPRTickets()` helper |

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| `ScheduledOutputs` type needs `pr_creation` key — callers of `createSmithers()` might break | The `ScheduledOutputs` type is derived from `scheduledOutputSchemas`, so adding a key auto-propagates. Verify no callers explicitly list all keys. |
| PR creation output won't affect `isUnitLanded()` — the landing detection reads `merge_queue` rows | In PR mode, units won't be "landed" in the merge sense. This is intentional — PRs are created but not merged. The workflow loop termination may need adjustment (future work, out of scope). |
| `buildMergeTickets` returns merge-specific ticket type | Create a separate `buildPRTickets()` that reuses the filtering logic but returns `PushAndCreatePRTicket[]` |
| Agent prompt references `jj` commands that may not exist in all environments | Document in prompt that `jj` and `gh` CLI tools are required prerequisites |

## Acceptance Criteria Verification

| # | Criterion | How to Verify |
|---|-----------|--------------|
| 1 | `PushAndCreatePR` renders as `<Task>` with non-empty prompt | Unit test: render with tickets, assert prompt is non-empty string |
| 2 | `prCreationResultSchema` validates correct shape | Unit test: parse valid/invalid objects |
| 3 | `ScheduledWorkflow` renders `AgenticMergeQueue` when merge/omitted | Unit test: render without landingMode, assert AgenticMergeQueue present |
| 4 | `ScheduledWorkflow` renders `PushAndCreatePR` when `landingMode === "pr"` | Unit test: render with landingMode="pr", assert PushAndCreatePR present |
| 5 | Existing call sites compile without changes | `bun run typecheck` with no modifications to existing callers |
| 6 | `pr_creation` output slot in schemas | Unit test: assert `scheduledOutputSchemas.pr_creation` exists |
| 7 | `bun run typecheck` passes | Run typecheck as final verification |
