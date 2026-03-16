# Refactor Plan: Self-Improving Repo Architecture

## Goal

Re-architecture super-ralph-lite so that:

1. **Workflows are self-contained modules** — each workflow lives in its own directory with its components, types, schemas, and prompts. A workflow exports a top-level Smithers JSX component that can be used standalone or embedded in a larger orchestration.
2. **The CLI is a thin orchestration layer** — it invokes workflows by reading configs and calling Smithers. A `--linear` flag optionally wires Linear as input/output.
3. **Linear adapters are optional glue** — they read workflow outputs and translate to/from Linear. Workflows never import Linear code.

This enables the **self-improving loop**:
```
improvinho (scan) → Linear (human triage) → ralphinho (implement) → PR
```

## Guiding Principle

> **Architecture changes; workflow internals don't.**
>
> The restructuring is primarily file moves, import path updates, and barrel file rewrites.
> No workflow logic, prompts, schemas, or component implementations should change.
> The only new code is the Linear adapter layer.

---

## Current Structure

```
src/
  cli/
    ralphinho.ts              # CLI entry point
    init-review.ts            # improvinho init handler
    init-scheduled.ts         # ralphinho init handler
    run.ts                    # workflow runner
    plan.ts                   # plan regeneration
    status.ts                 # status display
    shared.ts                 # shared CLI utilities
    ...
  components/
    index.ts                  # barrel — exports ALL components
    ReviewDiscoveryWorkflow.tsx
    ReviewSlicePipeline.tsx
    ScheduledWorkflow.tsx
    QualityPipeline.tsx
    AgenticMergeQueue.tsx
    Monitor.tsx
    runtimeNames.ts
  review/
    types.ts
    schemas.ts
    plan.ts
    projection.ts
    lenses.ts
  scheduled/
    types.ts
    schemas.ts
    decompose.ts
    index.ts
  prompts/
    DiscoverIssues.mdx
    Implement.mdx
    Test.mdx
    CodeReview.mdx
    PrdReview.mdx
    FinalReview.mdx
    ReviewFix.mdx
    Research.mdx
    Plan.mdx
  config/
    types.ts                  # discriminated union config schema
  runtime/
    smithers-launch.ts
    events.ts
    event-bridge.ts
    observability.ts
    projections.ts
  workflow/
    contracts.ts
    decisions.ts
    state.ts
    snapshot.ts
  preset.tsx                  # Smithers entry point for scheduled work
  review-preset.tsx           # Smithers entry point for review discovery
  preset-runtime.ts           # shared preset loader
  index.ts                    # public API barrel
```

## Target Structure

```
src/
  workflows/
    improvinho/
      index.ts                          # barrel: re-exports component + types + schemas
      preset.tsx                        # Smithers entry point (MOVE from src/review-preset.tsx)
      components/
        ReviewDiscoveryWorkflow.tsx      # MOVE from src/components/
        ReviewSlicePipeline.tsx          # MOVE from src/components/
      types.ts                          # MOVE from src/review/types.ts
      schemas.ts                        # MOVE from src/review/schemas.ts
      plan.ts                           # MOVE from src/review/plan.ts
      projection.ts                     # MOVE from src/review/projection.ts
      lenses.ts                         # MOVE from src/review/lenses.ts
      prompts/
        DiscoverIssues.mdx              # MOVE from src/prompts/

    ralphinho/
      index.ts                          # barrel: re-exports component + types + schemas
      preset.tsx                        # Smithers entry point (MOVE from src/preset.tsx)
      components/
        ScheduledWorkflow.tsx            # MOVE from src/components/
        QualityPipeline.tsx             # MOVE from src/components/
        AgenticMergeQueue.tsx           # MOVE from src/components/
        runtimeNames.ts                 # MOVE from src/components/runtimeNames.ts
      types.ts                          # MOVE from src/scheduled/types.ts
      schemas.ts                        # MOVE from src/scheduled/schemas.ts
      decompose.ts                      # MOVE from src/scheduled/decompose.ts
      prompts/
        Research.mdx                    # MOVE from src/prompts/
        Plan.mdx                        # MOVE from src/prompts/
        Implement.mdx                   # MOVE from src/prompts/
        Test.mdx                        # MOVE from src/prompts/
        PrdReview.mdx                   # MOVE from src/prompts/
        CodeReview.mdx                  # MOVE from src/prompts/
        ReviewFix.mdx                   # MOVE from src/prompts/
        FinalReview.mdx                 # MOVE from src/prompts/
      workflow/                         # MOVE from src/workflow/ (ralphinho-specific)
        contracts.ts
        decisions.ts
        state.ts
        snapshot.ts

  adapters/
    linear/
      index.ts                          # NEW — barrel
      client.ts                         # NEW — Linear SDK singleton
      types.ts                          # NEW — serializable Linear types
      push-findings.ts                  # NEW — MergedReviewFinding[] → Linear issues
      consume-tickets.ts                # NEW — fetch approved ticket → ralphinho input

  cli/
    ralphinho.ts                        # UPDATE — add --linear flag routing
    init-review.ts                      # UPDATE — import paths only
    init-scheduled.ts                   # UPDATE — import paths only
    run.ts                              # UPDATE — import paths + --linear pre/post hooks
    plan.ts                             # UPDATE — import paths only
    status.ts                           # UPDATE — import paths only
    shared.ts                           # KEEP — shared CLI utilities (no changes)
    ...

  runtime/                              # KEEP — shared infrastructure (no changes)
    smithers-launch.ts
    events.ts
    event-bridge.ts
    observability.ts
    projections.ts

  config/
    types.ts                            # KEEP — discriminated union config schema

  shared/
    monitor/                            # MOVE — Monitor is shared between workflows
      Monitor.tsx
      index.ts

  preset-runtime.ts                     # UPDATE — import paths only
  index.ts                              # UPDATE — re-export from new locations
```

---

## File Move Map

Every move is a copy + import path update. **No logic changes.**

### Improvinho (review discovery)

| From | To | Change |
|---|---|---|
| `src/components/ReviewDiscoveryWorkflow.tsx` | `src/workflows/improvinho/components/ReviewDiscoveryWorkflow.tsx` | Import paths |
| `src/components/ReviewSlicePipeline.tsx` | `src/workflows/improvinho/components/ReviewSlicePipeline.tsx` | Import paths |
| `src/review/types.ts` | `src/workflows/improvinho/types.ts` | None |
| `src/review/schemas.ts` | `src/workflows/improvinho/schemas.ts` | Import paths |
| `src/review/plan.ts` | `src/workflows/improvinho/plan.ts` | Import paths |
| `src/review/projection.ts` | `src/workflows/improvinho/projection.ts` | Import paths |
| `src/review/lenses.ts` | `src/workflows/improvinho/lenses.ts` | Import paths |
| `src/prompts/DiscoverIssues.mdx` | `src/workflows/improvinho/prompts/DiscoverIssues.mdx` | None |
| `src/review-preset.tsx` | `src/workflows/improvinho/preset.tsx` | Import paths |

### Ralphinho (scheduled work)

| From | To | Change |
|---|---|---|
| `src/components/ScheduledWorkflow.tsx` | `src/workflows/ralphinho/components/ScheduledWorkflow.tsx` | Import paths |
| `src/components/QualityPipeline.tsx` | `src/workflows/ralphinho/components/QualityPipeline.tsx` | Import paths |
| `src/components/AgenticMergeQueue.tsx` | `src/workflows/ralphinho/components/AgenticMergeQueue.tsx` | Import paths |
| `src/components/runtimeNames.ts` | `src/workflows/ralphinho/components/runtimeNames.ts` | None |
| `src/scheduled/types.ts` | `src/workflows/ralphinho/types.ts` | Import paths |
| `src/scheduled/schemas.ts` | `src/workflows/ralphinho/schemas.ts` | None |
| `src/scheduled/decompose.ts` | `src/workflows/ralphinho/decompose.ts` | Import paths |
| `src/workflow/contracts.ts` | `src/workflows/ralphinho/workflow/contracts.ts` | None |
| `src/workflow/decisions.ts` | `src/workflows/ralphinho/workflow/decisions.ts` | Import paths |
| `src/workflow/state.ts` | `src/workflows/ralphinho/workflow/state.ts` | Import paths |
| `src/workflow/snapshot.ts` | `src/workflows/ralphinho/workflow/snapshot.ts` | Import paths |
| `src/prompts/Research.mdx` | `src/workflows/ralphinho/prompts/Research.mdx` | None |
| `src/prompts/Plan.mdx` | `src/workflows/ralphinho/prompts/Plan.mdx` | None |
| `src/prompts/Implement.mdx` | `src/workflows/ralphinho/prompts/Implement.mdx` | None |
| `src/prompts/Test.mdx` | `src/workflows/ralphinho/prompts/Test.mdx` | None |
| `src/prompts/PrdReview.mdx` | `src/workflows/ralphinho/prompts/PrdReview.mdx` | None |
| `src/prompts/CodeReview.mdx` | `src/workflows/ralphinho/prompts/CodeReview.mdx` | None |
| `src/prompts/ReviewFix.mdx` | `src/workflows/ralphinho/prompts/ReviewFix.mdx` | None |
| `src/prompts/FinalReview.mdx` | `src/workflows/ralphinho/prompts/FinalReview.mdx` | None |
| `src/preset.tsx` | `src/workflows/ralphinho/preset.tsx` | Import paths |

### Shared

| From | To | Change |
|---|---|---|
| `src/components/Monitor.tsx` | `src/shared/monitor/Monitor.tsx` | Import paths |

### Deleted after moves

| Path | Reason |
|---|---|
| `src/components/` | All components moved to workflow dirs |
| `src/review/` | All review logic moved to improvinho |
| `src/scheduled/` | All scheduled logic moved to ralphinho |
| `src/workflow/` | All workflow logic moved to ralphinho |
| `src/prompts/` | All prompts moved to workflow dirs |

---

## Import Path Updates

After each file move, update its internal imports. The pattern is mechanical:

**ReviewSlicePipeline.tsx** (example):
```diff
- import { DiscoveredFinding, ... } from "../review/types";
- import { reviewOutputSchemas } from "../review/schemas";
- import { REVIEW_LENSES, ... } from "../review/lenses";
- import DiscoverIssuesPrompt from "../prompts/DiscoverIssues.mdx";
+ import { DiscoveredFinding, ... } from "../types";
+ import { reviewOutputSchemas } from "../schemas";
+ import { REVIEW_LENSES, ... } from "../lenses";
+ import DiscoverIssuesPrompt from "../prompts/DiscoverIssues.mdx";
```

**QualityPipeline.tsx** (example):
```diff
- import { WorkUnit, WorkPlan } from "../scheduled/types";
- import { scheduledOutputSchemas } from "../scheduled/schemas";
- import ResearchPrompt from "../prompts/Research.mdx";
- import { TIER_STAGES, stageNodeId, ... } from "../workflow/contracts";
+ import { WorkUnit, WorkPlan } from "../types";
+ import { scheduledOutputSchemas } from "../schemas";
+ import ResearchPrompt from "../prompts/Research.mdx";
+ import { TIER_STAGES, stageNodeId, ... } from "../workflow/contracts";
```

These are find-and-replace operations — no logic changes.

---

## New Code: Linear Adapters

### `src/adapters/linear/client.ts`

Thin wrapper around `@linear/sdk`. Lazy singleton, configured via `LINEAR_API_KEY` env var.
Mirrors the pattern from smithers' `src/linear/client.ts`.

see reference code at /Users/msaug/workspace/smithers — send a subagent explore that.

### `src/adapters/linear/types.ts`

Serializable types for Linear issues, teams, statuses. No SDK dependency — plain objects.

### `src/adapters/linear/push-findings.ts`

```typescript
/**
 * Convert MergedReviewFinding[] → Linear issues.
 *
 * Reads findings from the improvinho SQLite DB (or accepts them directly),
 * creates one Linear issue per finding with:
 *   - Title: "[IMP-XXXX] {summary}"
 *   - Description: markdown body with kind, priority, evidence, suggestedDiff
 *   - Labels: kind (bug, security, etc.) + priority
 *   - Project: configurable
 *
 * Returns created issue IDs for confirmation.
 */
```

Input: `MergedReviewFinding[]` (from `improvinho/projection.ts`)
Output: `{ created: { findingId: string; linearIssueId: string; url: string }[] }`

### `src/adapters/linear/consume-tickets.ts`

```typescript
/**
 * Fetch the highest-priority approved ticket from Linear.
 *
 * Queries Linear for issues with a specific label (e.g., "ralph-approved")
 * in a specific team/project. Returns the single highest-priority one.
 *
 * Converts the Linear issue into ralphinho-compatible input:
 *   - Title → work unit name
 *   - Description → RFC-like content for decompose.ts or direct task
 *   - Metadata → tracking info for post-completion updates
 *
 * After ralphinho completes, call updateTicket() to:
 *   - Move issue to "In Progress" / "Done"
 *   - Add comment with PR link and implementation summary
 *   - Remove the trigger label
 */
```

Input: `{ teamId?, label: string, projectId? }`
Output: `{ ticket: LinearTicket, asWorkInput: WorkInput } | null`

---

## CLI Changes

### `ralphinho.ts` — Add `--linear` flag

```diff
  Global Options:
    --cwd <path>                Repo root (default: current directory)
    --max-concurrency <n>       Max parallel work units (default: 6)
    --force                     Skip prompts and attempt resume
+   --linear                    Enable Linear integration
+   --label <name>              Linear label filter (default: "ralph-approved")
+   --team <id>                 Linear team ID
    --help                      Show this help
```

### `run.ts` — Wire `--linear` flag

The `--linear` flag triggers adapter calls **around** the existing workflow:

**For improvinho** (`ralphinho init review ... && ralphinho run --linear`):
```
1. Run the review-discovery workflow (unchanged)
2. After completion, read MergedReviewFinding[] from SQLite DB
3. Call push-findings.ts to create Linear issues
4. Print summary: "Created N Linear issues"
```

**For ralphinho** (`ralphinho run --linear --label ralph-approved`):
```
1. Call consume-tickets.ts to fetch one approved ticket
2. Convert ticket to work input (RFC-like content)
3. Write ephemeral RFC to .ralphinho/linear-task.md
4. Run init-scheduled with that RFC
5. Run the scheduled-work workflow (unchanged)
6. After completion, update Linear ticket (status + comment)
```

The key point: the workflow components are never aware of Linear. The CLI orchestrates the adapter calls.

---

## Execution Order

### Phase 1: Restructure (file moves + import updates) — COMPLETE

Committed as `24cfd59`. All 53 tests passing.

1. ~~Create directory structure under `src/workflows/`~~
2. ~~Move improvinho files (components, types, schemas, plan, projection, lenses, prompts, preset)~~
3. ~~Update improvinho import paths~~
4. ~~Move ralphinho files (components, types, schemas, decompose, workflow/, prompts, preset)~~
5. ~~Update ralphinho import paths~~
6. Monitor stays in `src/components/` (shared between workflows)
7. ~~Update CLI import paths~~
8. ~~Update `src/index.ts` barrel to re-export from new locations~~
9. ~~Update `src/cli/shared.ts` `getRalphinhoPresetPath` to point to new preset locations~~
10. ~~Update `src/runtime/` imports (events, event-bridge, projections, advanced-monitor-ui)~~
11. ~~Delete old files and verify tests pass~~

### Phase 2: Linear adapters (new code)

1. Add `@linear/sdk` dependency
2. Implement `src/adapters/linear/client.ts`
3. Implement `src/adapters/linear/types.ts`
4. Implement `src/adapters/linear/push-findings.ts`
5. Implement `src/adapters/linear/consume-tickets.ts`
6. Add `--linear` flag to CLI
7. Wire adapters into `run.ts`
8. Test end-to-end with a real Linear project

### Phase 3: Polish

1. Update README / docs
2. Add `LINEAR_API_KEY` to `.env.example`
3. Consider: should `--linear` also work with `init` directly? (e.g., `ralphinho init review --paths src/ --linear` does init + run + push in one shot)

---

## What Does NOT Change

- **Workflow JSX components** — ReviewDiscoveryWorkflow, ReviewSlicePipeline, ScheduledWorkflow, QualityPipeline, AgenticMergeQueue logic is untouched
- **MDX prompts** — all prompt content stays identical
- **Zod schemas** — all type/schema definitions stay identical
- **Review lenses** — lens definitions unchanged
- **Projection/merge logic** — finding merge and markdown projection unchanged
- **RFC decomposition** — AI decomposition logic unchanged
- **Smithers launch** — runtime launch infrastructure unchanged
- **Workflow contracts** — stage definitions, retry configs, node IDs unchanged
- **Tests** — existing test logic unchanged (import paths updated mechanically)

---

## Risk Assessment

| Risk | Mitigation |
|---|---|
| Import paths break silently | TypeScript compiler will catch all missing imports |
| Preset path resolution breaks | `getRalphinhoPresetPath()` updated in Phase 1 step 9 |
| Barrel re-exports miss something | Compare old `src/index.ts` exports with new one |
| Tests reference old paths | Mechanical find-and-replace on test import paths |
| MDX import resolution | Relative paths within workflow dirs stay short and clean |

All risks are caught at compile time. No runtime behavior changes.
