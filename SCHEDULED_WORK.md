# Scheduled Work Workflow

The RFC-driven, deterministic workflow. Takes an RFC/PRD document, decomposes it into work units with a dependency DAG, and executes them in topological order.

For common concepts (Smithers engine, jj, agents, tiers), see [CONCEPTS.md](CONCEPTS.md).

---

## Table of Contents

1. [Overview](#1-overview)
2. [Full Lifecycle](#2-full-lifecycle)
3. [RFC Decomposition](#3-rfc-decomposition)
4. [Work Plan Structure](#4-work-plan-structure)
5. [DAG Execution Model](#5-dag-execution-model)
6. [Per-Unit Pipeline Stages](#6-per-unit-pipeline-stages)
7. [Tier Definitions](#7-tier-definitions)
8. [The Merge Queue](#8-the-merge-queue)
9. [Eviction and Recovery](#9-eviction-and-recovery)
10. [Agent Configuration](#10-agent-configuration)
11. [Output Schemas](#11-output-schemas)

---

## 1. Overview

Scheduled Work is a **deterministic, RFC-driven** workflow:

```
RFC document
  → AI decomposes into WorkUnits with dependency DAG
  → Human reviews/edits work-plan.json
  → Execution: for each topological layer (sequential)
      → Phase 1: Run quality pipelines for all units in layer (parallel)
      → Phase 2: Merge queue lands tier-complete units onto main
  → Ralph loop repeats if evictions occurred (up to MAX_PASSES)
```

**Key characteristics:**
- Work is **defined upfront** from an RFC — no runtime discovery
- Execution order is **deterministic** — the DAG determines parallelism and ordering
- **No AI scheduler** — layers are computed from dependencies, units within a layer run in parallel
- Human can **review and edit** the work plan before execution
- The quality pipeline per unit depends on its tier, same as SuperRalph but with different stage compositions

### How it differs from Super-Ralph

| Aspect | Super-Ralph | Scheduled Work |
|--------|------------|----------------|
| Input | Free-form prompt | RFC/PRD document |
| Work discovery | AI discovers tickets at runtime | AI decomposes RFC upfront |
| Scheduling | AI scheduler (dynamic) | DAG layers (deterministic) |
| Human control | Clarifying questions pre-run | Edit work-plan.json pre-run |
| Re-planning | CLI `plan` command | CLI `plan` command |
| Cross-run resume | Yes (durability.ts) | No (relies on Smithers cache) |
| Monitor TUI | Yes | No |

### Project Structure

```
src/
  scheduled/
    decompose.ts       # AI-powered RFC → work units decomposition
    schemas.ts         # All sw_ output schemas
    types.ts           # WorkUnit, WorkPlan, SCHEDULED_TIERS, DAG utilities
  cli/
    ralphinho.ts                  # Unified CLI entry point
    init-scheduled.ts             # ScheduledWork init (RFC decomposition)
    render-scheduled-workflow.ts  # Generates the Smithers workflow.tsx
    plan.ts                       # Re-generate work plan
    run.ts                        # Dispatch to appropriate workflow mode
    shared.ts                     # Shared CLI utilities
```

---

## 2. Full Lifecycle

### Phase 1: Initialize (`ralphinho init scheduled-work ./rfc.md`)

1. **Read the RFC file** from the provided path
2. **Check prerequisites** — ensures `jj` is available
3. **Scan the repo** via `scanRepo()` — detects project name, package manager, build commands, test commands
4. **Detect agents** — checks if `claude`, `codex`, and `gh` CLIs are available on PATH
5. **Decompose the RFC** via `decomposeRFC()` — AI breaks the RFC into work units with a dependency DAG
6. **Write outputs** to `.ralphinho/`:
   - `.ralphinho/config.json` — mode, repoRoot, rfcPath, agents, maxConcurrency
   - `.ralphinho/work-plan.json` — the full work plan with units, dependencies, tiers

The user is told to review and edit `work-plan.json` before running.

### Phase 2: Review and Edit (Human)

The work plan is a plain JSON file. The user can:
- Adjust tiers (promote/demote complexity)
- Edit descriptions and acceptance criteria
- Add or remove dependencies
- Reorder or remove units entirely

### Phase 3: Re-plan (Optional — `ralphinho plan`)

Re-runs decomposition without re-initializing. Reads the RFC path from config, calls `decomposeRFC()` again, overwrites `work-plan.json`. Useful if the RFC was updated or the initial decomposition was unsatisfactory.

### Phase 4: Execute (`ralphinho run`)

1. **Read config and work plan** from `.ralphinho/`
2. **Compute topological layers** from the dependency DAG
3. **Generate workflow** — `renderScheduledWorkflow()` emits a complete `.tsx` file
4. **Launch Smithers** with the generated workflow

### Phase 5: Workflow Execution

The generated workflow has this structure:

```tsx
<Workflow name="scheduled-work" cache>
  <Ralph until={done} maxIterations={MAX_PASSES * units.length * 20}>
    <Sequence>
      {layers.map((layer, layerIdx) => (
        <Sequence key={"layer-" + layerIdx}>
          {/* Phase 1: Quality pipelines (parallel per unit) */}
          <Parallel maxConcurrency={MAX_CONCURRENCY}>
            {layer.map(unit => (
              <Worktree key={uid} path={"/tmp/workflow-wt-" + uid} branch={"unit/" + uid}>
                <Sequence>
                  [Research] → [Plan] → [Implement] → [Test]
                  → [PRD Review + Code Review (parallel)]
                  → [Review Fix] → [Final Review]
                </Sequence>
              </Worktree>
            ))}
          </Parallel>

          {/* Phase 2: Merge queue for this layer */}
          <Task id={mqNodeId} output={outputs.sw_merge_queue} agent={mergeQueueAgent}>
            {buildMergeQueuePrompt(toMerge, ...)}
          </Task>
        </Sequence>
      ))}

      {/* Pass tracker */}
      <Task id="pass-tracker" output={outputs.sw_pass_tracker}>
        {() => ({ pass: currentPass + 1, allComplete, ... })}
      </Task>
    </Sequence>
  </Ralph>
</Workflow>
```

**Key points:**
- The Ralph loop wraps everything. `MAX_PASSES` defaults to 3.
- Layers are **sequential** — layer N+1 starts only after layer N (including its merge queue) finishes.
- Units within a layer are **parallel** — up to `maxConcurrency`.
- Each unit runs in its own **worktree** at `/tmp/workflow-wt-{unitId}` on branch `unit/{unitId}`.
- `done` = `currentPass >= MAX_PASSES || allUnitsComplete`

---

## 3. RFC Decomposition

### The `decomposeRFC()` function

Located in `src/scheduled/decompose.ts`.

1. Builds a prompt with repo context (project name, package manager, build/test commands) and the full RFC content
2. Sends to Anthropic API (claude-sonnet-4-6) with a system prompt instructing the model to act as a "senior software architect"
3. Parses JSON response, validates DAG, validates against `workPlanSchema`
4. Computes topological layers
5. Falls back to `claude` CLI if no `ANTHROPIC_API_KEY` is set

### Decomposition Rules (from the system prompt)

The AI is instructed to:

- **Make each unit cohesive and independent** — a unit should be implementable without knowledge of other units
- **Prefer fewer, cohesive units over many granular ones** — only split when units touch genuinely independent files. Each unit adds pipeline overhead and merge risk
- **Minimize cross-unit file overlap** — if two units would modify the same file, strongly prefer combining them into one unit. Cross-unit file overlap causes merge conflicts that require expensive re-runs
- Only add dependencies where there is a real code dependency
- **Make acceptance criteria verifiable** — concrete, testable conditions
- **Keep tests with implementation** — "Never decompose 'implement X' + 'test X' as two separate units"
- **Assign tiers conservatively**:
  - `trivial` — single-file, mechanical changes
  - `small` — a few files, straightforward logic
  - `medium` — multiple files, requires understanding context
  - `large` — cross-cutting, architectural impact

### DAG Validation

After decomposition, the DAG is validated:
- All dependency references point to existing unit IDs
- No cycles (checked via DFS)
- If validation fails, the decomposition is rejected

---

## 4. Work Plan Structure

### WorkUnit

```typescript
{
  id: string,           // kebab-case, e.g. "metadata-cleanup"
  name: string,         // human-readable
  rfcSections: string[], // which RFC sections, e.g. ["3", "3.2"]
  description: string,  // detailed description
  deps: string[],       // IDs of units that must complete first
  acceptance: string[], // concrete acceptance criteria
  tier: "trivial" | "small" | "medium" | "large"
}
```

### WorkPlan

```typescript
{
  source: string,         // path to the RFC file
  generatedAt: string,
  repo: {
    projectName: string,
    buildCmds: Record<string, string>,
    testCmds: Record<string, string>,
  },
  units: WorkUnit[]
}
```

### Topological Layers

`computeLayers(units)` organizes units into execution layers:

- **Layer 0**: Units with no dependencies
- **Layer N**: Units whose dependencies are all in layers 0..N-1

Units within the same layer can run in parallel. Layers execute sequentially.

Example:
```
Layer 0: [A, B]         ← A and B have no deps, run in parallel
Layer 1: [C, D]         ← C depends on A, D depends on B
Layer 2: [E]            ← E depends on both C and D
```

---

## 5. DAG Execution Model

Unlike SuperRalph's AI-driven scheduler, ScheduledWork execution is **deterministic**: the DAG determines parallelism and ordering.

### Execution Flow Per Layer

```
Layer N:
  ├─ Phase 1: Quality Pipelines (parallel)
  │   ├─ Unit A: [Research → Plan → Implement → Test → Reviews → ...]
  │   ├─ Unit B: [Implement → Test → Code Review]
  │   └─ Unit C: [Implement → Test]
  │
  └─ Phase 2: Merge Queue
      ├─ Land tier-complete units onto main
      └─ Evict units with conflicts (re-run on next pass)
```

### Reactivity via Ralph Loop

On each Ralph iteration, the workflow checks:
- Which units are **landed** (merge queue succeeded)
- Which units are **evicted** (merge queue failed)
- Whether **all units are complete** or `MAX_PASSES` exhausted

Evicted units get their conflict context injected and re-run on the next Ralph pass. The `pass-tracker` task increments the pass counter.

### Tier-Gated Stage Skipping

Each pipeline stage checks `tierHasStep(tier, step)` before rendering. Stages outside a unit's tier are simply not rendered in the JSX, so they never execute.

---

## 6. Per-Unit Pipeline Stages

All prompts are constructed as JavaScript template literals in `render-scheduled-workflow.ts`. Each stage is a `<Task>` with an inline prompt.

### Research (medium/large only)

**Agent**: `researcher` (Claude Sonnet)

The prompt instructs the agent to:
1. Read the RFC file focusing on the unit's referenced sections
2. Read relevant source files from the codebase
3. Identify patterns, types, and interfaces relevant to the work
4. Note dependencies between this unit and other parts of the system
5. Write a context document and commit it with jj

**Output schema (`sw_research`)**:
```typescript
{
  contextFilePath: string,
  findings: string[],
  referencesRead: string[],
  openQuestions: string[]
}
```

### Plan (medium/large only)

**Agent**: `planner` (Claude Opus)

The prompt instructs the agent to:
1. Use the research context document
2. Reference the RFC sections and acceptance criteria
3. Create a detailed implementation plan with atomic steps
4. Identify files to create and modify
5. Plan the test approach
6. Write and commit the plan document

**Output schema (`sw_plan`)**:
```typescript
{
  planFilePath: string,
  implementationSteps: string[],
  filesToCreate: string[],
  filesToModify: string[],
  complexity: string
}
```

### Implement (all tiers)

**Agent**: `implementer` (Codex preferred)

This is the most complex prompt. It includes:
- RFC sections and unit description
- Acceptance criteria
- Plan reference (if medium/large)
- Research context (if medium/large)
- **Dependency context**: for units with deps, the implement summaries (whatWasDone, filesCreated, filesModified) from all completed dependencies are injected so the implementer knows what APIs and files its dependencies produced
- **Feedback from previous iterations**: final review reasoning, PRD review feedback, code review feedback, failing test output, review fix summary
- **Merge conflict context** (if evicted from a previous pass)
- Build and test commands (including lint/typecheck if detected)

#### Tier-adaptive task instructions

The implement prompt varies by tier to avoid unnecessary TDD overhead:

| Tier | Testing instructions |
|------|---------------------|
| **trivial** | "Do NOT write new tests for config, metadata, or mechanical changes. Verify with build only." |
| **small** | "Write tests if you added new behavior. Skip tests for mechanical refactors, re-exports, or type-only changes." |
| **medium/large** | "For new behavior: write a failing test first (TDD), then implement. For non-behavioral changes: implement directly without TDD." |

The agent:
1. Reads the plan and context files (if they exist)
2. Reviews dependency context to understand available APIs/types
3. Implements the changes following the tier-appropriate testing strategy
4. Runs build and test commands to verify
5. Commits and pushes to `unit/{unitId}` branch

**Output schema (`sw_implement`)**:
```typescript
{
  summary: string,
  filesCreated: string[],
  filesModified: string[],
  whatWasDone: string,
  nextSteps: string,
  believesComplete: boolean
}
```

### Test (all tiers)

**Agent**: `tester` (Claude Sonnet)

The prompt instructs the agent to:
1. Run the build command
2. Run the test suite
3. Analyze any failures
4. Fix compilation errors if possible
5. Report results

**Output schema (`sw_test`)**:
```typescript
{
  buildPassed: boolean,
  testsPassed: boolean,
  testsPassCount: number,
  testsFailCount: number,
  failingSummary: string | null,
  testOutput: string
}
```

### PRD Review (medium/large only)

**Agent**: `prdReviewer` (Claude Sonnet)

The prompt instructs the agent to:
1. Review the implementation against the RFC specification
2. Check each acceptance criterion
3. Assess severity: critical (core spec violation), major (missing requirement), minor (cosmetic), none (compliant)

Runs **in parallel** with Code Review via `<Parallel continueOnFail>`.

**Output schema (`sw_prd_review`)**:
```typescript
{
  severity: "none" | "minor" | "major" | "critical",
  approved: boolean,
  feedback: string,
  issues: Array<{ title, severity, description, file?, suggestion?, reference? }>
}
```

### Code Review (small/medium/large)

**Agent**: `codeReviewer` (Claude Opus)

The prompt instructs the agent to:
1. Review code quality independently of spec compliance
2. Check: error handling, security, test coverage, coding conventions
3. Assess severity using the same scale as PRD review

Runs **in parallel** with PRD Review.

**Output schema (`sw_code_review`)**:
```typescript
{
  severity: "none" | "minor" | "major" | "critical",
  approved: boolean,
  feedback: string,
  issues: Array<{ title, severity, description, file?, suggestion?, reference? }>
}
```

### Review Fix (medium/large — skipped if both reviews approve)

**Agent**: `reviewFixer` (Codex preferred)

Skipped via `skipIf` when both PRD review and code review have severity "none".

The prompt instructs the agent to:
1. Address each issue in severity order (critical first)
2. Fix valid issues, document false positives
3. Run build and tests after each fix
4. Commit each fix separately with jj

**Output schema (`sw_review_fix`)**:
```typescript
{
  summary: string,
  fixesMade: string[],
  falsePositives: string[],
  allIssuesResolved: boolean,
  buildPassed: boolean,
  testsPassed: boolean
}
```

### Final Review (large only — the quality gate)

**Agent**: `finalReviewer` (Claude Opus)

This is the terminal gate for large-tier units. The agent decides `readyToMoveOn` based on:
- All acceptance criteria met
- Tests pass
- Review severity is none or minor
- Implementation is functionally complete

The `reasoning` field feeds back to the implementer on the next Ralph pass if `readyToMoveOn` is false.

**Output schema (`sw_final_review`)**:
```typescript
{
  readyToMoveOn: boolean,
  reasoning: string,
  approved: boolean,
  qualityScore: number,
  remainingIssues: string[]
}
```

---

## 7. Tier Definitions

| Tier | Stages | Gate Condition |
|------|--------|---------------|
| `trivial` | implement → test | Tests + build pass |
| `small` | implement → test → code-review | Tests + build pass AND code review approved |
| `medium` | research → plan → implement → test → prd-review → code-review → review-fix | Tests + build pass AND (both reviews approved OR reviewFix.allIssuesResolved) |
| `large` | research → plan → implement → test → prd-review → code-review → review-fix → final-review | finalReview.readyToMoveOn is true |

### Key differences from SuperRalph tiers

- **All tiers include `test`** (SuperRalph's trivial tier skips test)
- **`prd-review`** replaces SuperRalph's `spec-review` (reviews against RFC specifically)
- **`final-review`** replaces SuperRalph's `report` (acts as a quality gate, not a completion summary)
- **No separate `build-verify` stage** — build verification is folded into the test step
- **Review fix is skippable** — automatically skipped when both reviews approve

---

## 8. The Merge Queue

After all quality pipelines in a layer complete, a merge queue task runs.

### How it works

The `buildMergeQueuePrompt()` function generates a prompt for the merge queue agent (Claude Opus):

1. For each tier-complete unit in the layer:
   - Switch to the unit's worktree
   - Rebase onto main: `jj rebase -d main`
2. If **conflict**: capture full conflict details, mark as EVICTED (do not attempt resolution)
3. If **clean rebase**: run tests in the rebased state
   - If tests fail: mark as EVICTED with test failure output
   - If tests pass: fast-forward main (`jj bookmark set main --to @`), push, mark as LANDED
4. Return structured JSON with results

### Output schema (`sw_merge_queue`)

```typescript
{
  ticketsLanded: Array<{ ticketId, mergeCommit, summary }>,
  ticketsEvicted: Array<{ ticketId, reason, details }>,
  ticketsSkipped: Array<{ ticketId, reason }>,
  summary: string,
  nextActions: string | null
}
```

### Landing detection

Two functions scan merge queue outputs:
- `unitLanded(ctx, unitId)` — returns true if the unit appears in any `ticketsLanded` array
- `unitEvicted(ctx, unitId)` — returns true if the unit appears in any `ticketsEvicted` array

These are checked on each Ralph iteration to determine which units need re-running.

---

## 9. Eviction and Recovery

When a unit is evicted from the merge queue:

1. The merge queue captures the **eviction context**: reason (conflict, test failure), details, and diff information
2. On the next Ralph pass, the eviction context is injected into the **implement prompt**:

```
## MERGE CONFLICT — RESOLVE BEFORE NEXT LANDING
{evictionCtx}

Your previous implementation conflicted with another unit that landed first.
Restructure your changes to avoid the conflicting files and lines described above.
```

3. The implementer re-runs with awareness of the conflict
4. The full quality pipeline re-runs for the unit
5. The unit re-enters the merge queue on the next layer pass

### MAX_PASSES limit

The Ralph loop runs up to `MAX_PASSES` (default: 3) times. If a unit is still not landed after all passes, the workflow terminates with that unit incomplete. The `pass-tracker` task tracks the current pass number.

---

## 10. Agent Configuration

Nine specialized agents:

| Agent | Model | Role |
|-------|-------|------|
| `researcher` | Claude Sonnet | Gather context from codebase |
| `planner` | Claude Opus | Create implementation plan from RFC |
| `implementer` | Codex (GPT-5.3) | Write code following the plan |
| `tester` | Claude Sonnet | Run tests and validate |
| `prdReviewer` | Claude Sonnet | Verify implementation matches RFC |
| `codeReviewer` | Claude Opus | Check code quality, security |
| `reviewFixer` | Codex (GPT-5.3) | Fix issues from reviews |
| `finalReviewer` | Claude Opus | Final gate decision |
| `mergeQueueAgent` | Claude Opus | Rebase and land branches |

All agents share a common system prompt structure with:
- A workspace policy ("don't refuse to work because of dirty git state")
- JSON output formatting rules
- jj commit conventions

Agent selection uses `chooseAgent(primary, role)` which supports three tiers: `"claude"` (Sonnet), `"opus"` (Opus), and `"codex"` (Codex). Preference with fallback, same pattern as SuperRalph but with Opus as an explicit tier.

---

## 11. Output Schemas

All output schemas are prefixed with `sw_` to avoid collisions with SuperRalph schemas if sharing a database.

| Schema | Stage | Key Fields |
|--------|-------|------------|
| `sw_research` | Research | `contextFilePath`, `findings[]`, `referencesRead[]`, `openQuestions[]` |
| `sw_plan` | Plan | `planFilePath`, `implementationSteps[]`, `filesToCreate[]`, `filesToModify[]` |
| `sw_implement` | Implement | `summary`, `filesCreated[]`, `filesModified[]`, `whatWasDone`, `believesComplete` |
| `sw_test` | Test | `buildPassed`, `testsPassed`, `testsPassCount`, `testsFailCount`, `failingSummary` |
| `sw_prd_review` | PRD Review | `severity`, `approved`, `feedback`, `issues[]` |
| `sw_code_review` | Code Review | `severity`, `approved`, `feedback`, `issues[]` |
| `sw_review_fix` | Review Fix | `summary`, `fixesMade[]`, `falsePositives[]`, `allIssuesResolved`, `buildPassed`, `testsPassed` |
| `sw_final_review` | Final Review | `readyToMoveOn`, `reasoning`, `qualityScore`, `remainingIssues[]` |
| `sw_pass_tracker` | Pass Tracker | `pass`, `allComplete` |
| `sw_completion_report` | Completion Report | `totalUnits`, `unitsLanded[]`, `unitsFailed[]`, `passesUsed`, `summary`, `nextSteps[]` |
| `sw_merge_queue` | Merge Queue | `ticketsLanded[]`, `ticketsEvicted[]`, `ticketsSkipped[]` |

---

## Appendix: End-to-End Work Unit Lifecycle

```
1. User writes an RFC document (markdown)

2. ralphinho init scheduled-work ./rfc.md
   ├─ Scans repo for build/test commands
   ├─ AI decomposes RFC into WorkUnits with dependency DAG
   └─ Writes .ralphinho/config.json + .ralphinho/work-plan.json

3. User reviews/edits work-plan.json (optional)

4. ralphinho plan (optional — regenerate if RFC changed)

5. ralphinho run
   ├─ Generates Smithers workflow.tsx from the work plan
   └─ Launches Smithers execution

6. For each topological layer (sequential):
   ├─ Phase 1: Quality pipelines (parallel)
   │   ├─ Each unit in its own Worktree on branch unit/{id}
   │   └─ Pipeline depth depends on tier:
   │       trivial: implement → test
   │       small:   implement → test → code-review
   │       medium:  research → plan → implement → test → reviews → review-fix
   │       large:   research → plan → implement → test → reviews → review-fix → final-review
   │
   └─ Phase 2: Merge queue
       ├─ Rebase tier-complete units onto main
       ├─ Run post-rebase tests
       ├─ Land passing units (fast-forward main)
       └─ Evict failing units (with full conflict context)

7. Ralph loop repeats if not all units landed (up to MAX_PASSES=3)
   └─ Evicted units get conflict context injected and re-run

8. Done when all units are landed on main, or MAX_PASSES exhausted

9. Completion report generated:
   ├─ Total units, landed count, failed count, passes used
   ├─ For each failed unit: last stage reached and failure reason
   └─ Suggested next steps (resume command, DB inspection)
```
