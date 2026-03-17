# Research: pr-workflow-component

## Summary

Create `PushAndCreatePR.tsx` as a Smithers `<Task>` component and wire it into `ScheduledWorkflow` via a `landingMode` prop. Add corresponding output schema to `schemas.ts`.

## RFC Sections (§Step 4, §Step 5)

### §Step 4: PR Creation Component

- **File**: `src/workflows/ralphinho/components/PushAndCreatePR.tsx` (CREATE)
- **Pattern**: Same as `AgenticMergeQueue.tsx` — a `<Task>` with an agent prompt
- **Schema**: `prCreationResultSchema` (zod):
  - `ticketsPushed`: array of `{ ticketId, branch, prUrl (nullable), prNumber (nullable), summary }`
  - `ticketsFailed`: array of `{ ticketId, reason }`
  - `summary`: string
- **Agent prompt instructs**:
  1. `jj git push --bookmark {branch}` for each completed ticket
  2. `gh pr create --base {baseBranch} --head {branch} --title "..." --body "..."`
  3. Handle already-existing PRs (skip creation, record URL)
  4. Handle push failures (record and continue)

### §Step 5: Wire into ScheduledWorkflow

- **File**: `src/workflows/ralphinho/components/ScheduledWorkflow.tsx` (MODIFY)
- Add `landingMode?: "merge" | "pr"` prop, defaulting to `"merge"` for backward compatibility
- Conditionally render `<PushAndCreatePR>` instead of `<AgenticMergeQueue>` when `landingMode === "pr"`
- Reuse `MERGE_QUEUE_NODE_ID` for state tracking

### Schema changes

- **File**: `src/workflows/ralphinho/schemas.ts` (MODIFY)
- Add `pr_creation` output schema or extend `merge_queue` slot with a union

### Config changes

- **File**: `src/config/types.ts` (MODIFY)
- Add optional `landingMode: z.enum(["merge", "pr"]).default("merge")` to `scheduledWorkConfigSchema`

## Reference Files Read

### `AgenticMergeQueue.tsx` (Pattern Reference)
- **Location**: `src/workflows/ralphinho/components/AgenticMergeQueue.tsx`
- **Key patterns**:
  - Exports a result zod schema (`mergeQueueResultSchema`) and a type alias
  - Exports a ticket type (`AgenticMergeQueueTicket`) for inputs
  - Has a props type with `ctx`, `output`, `agent`, `fallbackAgent`, `nodeId`, etc.
  - Builds prompt via a dedicated `buildMergeQueuePrompt()` function
  - Short-circuits with an empty result `<Task>` when no tickets are ready
  - Uses `MERGE_QUEUE_RETRIES` and `MERGE_QUEUE_RETRY_POLICY` from contracts
  - The `<Task>` takes `id`, `output`, `agent`, `fallbackAgent`, `retries`, `meta`

### `ScheduledWorkflow.tsx` (Modification Target)
- **Location**: `src/workflows/ralphinho/components/ScheduledWorkflow.tsx`
- **Current structure**:
  - Props: `{ ctx, outputs, workPlan, repoRoot, maxConcurrency, maxPasses, baseBranch, agents, fallbacks }`
  - `ScheduledWorkflowAgents = QualityPipelineAgents & { mergeQueue: AgentLike | AgentLike[] }`
  - Render: `<Sequence>` → `<Ralph until={done}>` → `<Sequence>` → `<Parallel>` (quality pipelines) → `<AgenticMergeQueue>` → `<Task>` (pass tracker) → `<Task>` (completion report)
  - `AgenticMergeQueue` receives: `nodeId={MERGE_QUEUE_NODE_ID}`, `branchPrefix`, `ctx`, `tickets`, `agent`, `fallbackAgent`, `output={outputs.merge_queue}`, `outputs`, `repoRoot`, `baseBranch`, `postLandChecks`, `preLandChecks`
  - `mergeTickets` are built via `buildMergeTickets(snapshot, units, ctx.runId, ctx.iteration)`

### `schemas.ts` (Schema File)
- **Location**: `src/workflows/ralphinho/schemas.ts`
- **Current keys**: `research`, `plan`, `implement`, `test`, `prd_review`, `code_review`, `review_fix`, `final_review`, `pass_tracker`, `completion_report`, `merge_queue`
- **`merge_queue` schema shape**: `{ ticketsLanded, ticketsEvicted, ticketsSkipped, summary, nextActions }`
- New `pr_creation` key needed with the `prCreationResultSchema` shape

### `contracts.ts` (Node IDs and Retry Policies)
- **Location**: `src/workflows/ralphinho/workflow/contracts.ts`
- `MERGE_QUEUE_NODE_ID = "merge-queue"` — reuse for PushAndCreatePR when `landingMode === "pr"`
- Retry policy pattern: export const + named retries constant
- May need new `PR_CREATION_RETRY_POLICY` and `PR_CREATION_RETRIES` or reuse merge queue ones

### `config/types.ts` (Config Schema)
- **Location**: `src/config/types.ts`
- `scheduledWorkConfigSchema` extends `baseConfigSchema` with `mode`, `rfcPath`, `baseBranch`, `agentOverride`
- Add `landingMode: z.enum(["merge", "pr"]).default("merge")`

### `runtimeNames.ts` (Branch Naming)
- **Location**: `src/workflows/ralphinho/components/runtimeNames.ts`
- `buildUnitBranchPrefix(runId, basePrefix)` → e.g. `unit/{runScope}/`
- `buildUnitWorktreePath(runId, unitId)` → `/tmp/workflow-wt-{runScope}-{unitId}`
- PushAndCreatePR needs to know the branch name pattern to push correctly

### `workflow/state.ts` (Merge Ticket Building)
- **Location**: `src/workflows/ralphinho/workflow/state.ts`
- `buildMergeTickets(snapshot, units, runId, iteration)` — builds `AgenticMergeQueueTicket[]`
- For PR mode, a similar function or the same tickets can be adapted

### `types.ts` (WorkPlan/WorkUnit)
- **Location**: `src/workflows/ralphinho/types.ts`
- `WorkPlan`, `WorkUnit` types — the core data model

## Key Implementation Decisions

1. **Schema approach**: Add a separate `pr_creation` key to `scheduledOutputSchemas` rather than unionizing with `merge_queue`. This keeps the schemas clean and the output table distinct.

2. **Ticket type**: PushAndCreatePR needs a simpler ticket type than `AgenticMergeQueueTicket` — it doesn't need `eligibilityProof`, `preLandChecks`, etc. It mainly needs `ticketId`, `branch`, `baseBranch`, and worktree info.

3. **Prompt structure**: Follow the AgenticMergeQueue pattern — dedicated `buildPRCreationPrompt()` function that builds a detailed markdown prompt.

4. **Retry policy**: Reuse `MERGE_QUEUE_RETRY_POLICY` (backoff, 2 retries) or create a dedicated one. Push/PR creation is idempotent enough for retries.

5. **Backward compatibility**: Default `landingMode` to `"merge"` everywhere — ScheduledWorkflow props, config schema.

## Open Questions

1. Should `pr_creation` output be stored in a separate DB table or reuse the `merge_queue` slot? (Recommendation: separate `pr_creation` table for cleaner semantics)
2. Does `buildMergeTickets()` from `state.ts` need modification, or should PushAndCreatePR use a different ticket-building function? (The existing one has merge-specific fields like `eligibilityProof`)
3. Should `PushAndCreatePR` reuse `MERGE_QUEUE_NODE_ID` or define its own node ID? (RFC says reuse for state tracking, but a separate ID like `"pr-creation"` might be cleaner)
