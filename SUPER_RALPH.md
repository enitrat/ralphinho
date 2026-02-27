# Super-Ralph Workflow

The intent-driven, AI-scheduled workflow. Takes a free-form prompt, dynamically discovers tickets, and uses an AI scheduler to drive execution.

For common concepts (Smithers engine, jj, agents, tiers), see [CONCEPTS.md](CONCEPTS.md).

---

## Table of Contents

1. [Overview](#1-overview)
2. [Full Lifecycle](#2-full-lifecycle)
3. [The Ralph Loop](#3-the-ralph-loop)
4. [Ticket Discovery](#4-ticket-discovery)
5. [The AI Scheduler](#5-the-ai-scheduler)
6. [Job Lifecycle](#6-job-lifecycle)
7. [Per-Ticket Pipeline Stages](#7-per-ticket-pipeline-stages)
8. [Tier Definitions](#8-tier-definitions)
9. [Data Flow Between Stages](#9-data-flow-between-stages)
10. [The Merge Queue](#10-the-merge-queue)
11. [Cross-Run Durability](#11-cross-run-durability)
12. [The Monitor](#12-the-monitor)
13. [Configuration Flow](#13-configuration-flow)
14. [Agent Configuration](#14-agent-configuration)

---

## 1. Overview

Super-Ralph is an **autonomous, intent-driven** workflow:

```
User prompt → Clarifying questions → InterpretConfig → Ralph loop:
    → TicketScheduler (AI decides what to run next)
    → Parallel pipeline jobs (research/plan/implement/test/review per ticket)
    → AgenticMergeQueue (AI lands completed tickets via jj)
    → Repeat until all tickets landed
```

**Key characteristics:**
- Work is **discovered at runtime** by an AI agent reading specs and codebase
- An **AI scheduler** dynamically assigns jobs to agents on each iteration
- Tickets flow through a **tier-dependent quality pipeline**
- The system is **self-sustaining** — it discovers, implements, reviews, and lands work without human intervention

### Project Structure

```
src/
  cli/
    ralphinho.ts                 # Unified CLI entry point
    init-super-ralph.ts          # SuperRalph init + workflow generation
    clarifications.ts            # Hardcoded fallback clarification questions
    interactive-questions.ts     # Full-screen TUI for answering questions
  components/
    SuperRalph.tsx               # Root workflow: Ralph loop + job dispatch + merge queue
    Job.tsx                      # Per-job dispatcher (switches on jobType)
    TicketScheduler.tsx          # AI-driven job scheduler
    AgenticMergeQueue.tsx        # AI-driven merge coordinator
    InterpretConfig.tsx          # Prompt → structured config converter
    ClarifyingQuestions.tsx      # Smithers-based Q&A
    Monitor.tsx                  # Background TUI launcher
    TicketResume.tsx             # Cross-run resume helper
  prompts/                       # 11 MDX prompt templates
    Discover.mdx, Research.mdx, Plan.mdx, Implement.mdx, Test.mdx,
    BuildVerify.mdx, SpecReview.mdx, CodeReview.mdx, ReviewFix.mdx,
    Report.mdx, UpdateProgress.mdx
  schemas.ts                     # All Zod output schemas + complexity tier definitions
  selectors.ts                   # Pure functions for reading ctx
  scheduledTasks.ts              # SQLite-backed job queue (separate from Smithers DB)
  durability.ts                  # Cross-run ticket state via direct SQLite reads
  advanced-monitor-ui.ts         # OpenTUI-based terminal dashboard
```

---

## 2. Full Lifecycle

### Phase 1: CLI Startup

1. **Parse arguments**: Flags: `--cwd`, `--max-concurrency`, `--run-id`, `--resume`, `--dry-run`, `--skip-questions`. Prompt is positional (inline text, file path, or stdin via `"-"`).
2. **Detect agents**: Runs `which claude`, `which codex`, `which gh` in parallel.
3. **Build fallback config**: Scans repo for `package.json` scripts, `go.mod`, `Cargo.toml`. Builds `buildCmds`/`testCmds` maps, finds `specsPath`.

### Phase 2: Clarifying Questions (Pre-Smithers)

Runs entirely before the Smithers workflow launches.

1. **Generate questions**: Tries Anthropic API directly (`claude-opus-4-6`), asking for 10-15 product-focused questions. Falls back to `claude --print`, then to 12 hardcoded questions in `clarifications.ts`.
2. **Interactive TUI**: Full-screen terminal UI. Arrow keys navigate, Enter confirms, Left/Right jump between questions, "F" to finish early.
3. **Session construction**: Answers assembled into `{ answers, summary }` — a numbered Q&A string serialized into the generated workflow.

### Phase 3: Generate Workflow File

`renderWorkflowFile()` emits a complete `.tsx` file to `.ralphinho/generated/workflow.tsx`. All runtime constants are baked in as JS literals: `REPO_ROOT`, `DB_PATH`, `PROMPT_TEXT`, `CLARIFICATION_SESSION`, `FALLBACK_CONFIG`, `PACKAGE_SCRIPTS`, agent availability flags.

### Phase 4: Launch Smithers

```typescript
Bun.spawn(["bun", "--no-install", "-r", preloadPath, smithersCliPath, "run", workflowPath,
  "--root", repoRoot, "--run-id", runId, "--max-concurrency", String(maxConcurrency)], {
  env: { ...process.env, USE_CLI_AGENTS: "1", SMITHERS_DEBUG: "1" },
});
```

### Phase 5: Workflow Execution

The generated workflow has this structure:

```tsx
<Workflow name="super-ralph-full">
  <Sequence>
    {/* Step 1: AI interprets user prompt into structured config */}
    <InterpretConfig prompt={PROMPT_TEXT} clarificationSession={...} ... />

    {/* Step 2: Main pipeline + monitor run concurrently */}
    <Parallel>
      <SuperRalph ctx={ctx} outputs={outputs} {...getInterpretedConfig(ctx)} agents={agentPool} />
      <Monitor dbPath={DB_PATH} runId={ctx.runId} ... />
    </Parallel>
  </Sequence>
</Workflow>
```

The `<Sequence>` ensures InterpretConfig completes before SuperRalph starts. The `<Parallel>` runs SuperRalph and Monitor concurrently.

---

## 3. The Ralph Loop

SuperRalph wraps everything in:

```tsx
<Ralph until={false} maxIterations={Infinity} onMaxReached="return-last">
  <Parallel maxConcurrency={maxConcurrency}>
    {/* TicketScheduler (conditional) */}
    {/* Active Jobs */}
    {/* AgenticMergeQueue (conditional) */}
  </Parallel>
</Ralph>
```

### What "iteration" means

A Ralph iteration is one complete cycle of the Smithers render-schedule-execute loop. Each iteration:

1. **Render**: SuperRalph reads all current state (discovered tickets, pipeline stages, completed tickets, scheduler output). Opens the scheduled-tasks DB, reaps completed jobs, reconciles new jobs, reads active jobs, renders JSX.
2. **Schedule**: Smithers evaluates which tasks within the `<Parallel>` are runnable.
3. **Execute**: Runnable tasks execute.
4. **Persist**: Outputs written to SQLite.
5. **Re-render**: New tasks may appear (new jobs from scheduler) or disappear (completed jobs).

A new iteration starts when ALL tasks within the current iteration finish.

### Termination

`until={false}` means the loop never terminates via its condition. The workflow ends when Smithers detects a Ralph iteration produced no runnable tasks and no pending work remains:
- All tickets landed
- `activeJobs` is empty
- The scheduler produces no new jobs
- The merge queue has no ready tickets

---

## 4. Ticket Discovery

### How it triggers

The TicketScheduler schedules a `"discovery"` job when the pipeline needs more tickets. Rule: "If active tickets <= maxConcurrency * 2, schedule a discovery job."

### What the Discover prompt does

`Discover.mdx` instructs the agent to:

1. **Read specs** from `specsPath` — the project's specification documents
2. **Browse the codebase** and reference files to understand current state
3. **Review progress** — what's been done, what's in flight
4. **Generate 3-5 new tickets**, each with:
   - `id` (kebab-case), `title`, `description`
   - `category` (from the configured focus areas)
   - `priority` (critical / high / medium / low)
   - `complexityTier` (trivial / small / medium / large)
   - `acceptanceCriteria`, `relevantFiles`, `referenceFiles`
5. **Deduplicate** against existing in-progress tickets and completed ticket IDs
6. **Default to smallest tier** — only upgrade if the work clearly requires it

This is a **read-only** phase — the agent must not make any commits.

### Output schema

```typescript
discover: z.object({
  tickets: z.array(z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    category: z.string(),
    priority: z.enum(["critical", "high", "medium", "low"]),
    complexityTier: z.enum(["trivial", "small", "medium", "large"]),
    acceptanceCriteria: z.array(z.string()).nullable(),
    relevantFiles: z.array(z.string()).nullable(),
    referenceFiles: z.array(z.string()).nullable(),
  })),
  reasoning: z.string(),
  completionEstimate: z.string(),
})
```

### How discovered tickets become available

`selectDiscoverTickets()` reads ALL `discover` output rows, sorts by iteration ascending, deduplicates by ticket ID (latest iteration wins), and returns the merged list. This happens every Ralph iteration during render.

---

## 5. The AI Scheduler

### What it is

`TicketScheduler` is a Smithers `<Task>` (id: `"ticket-scheduler"`) that runs whenever `activeCount < maxConcurrency`. It is an AI agent that decides what jobs to schedule next.

### Context it receives

The scheduler prompt includes:
- Current time, pipeline summary (completed/active/concurrency counts)
- Currently running jobs table (jobId, type, agent, ticketId, age in minutes)
- Ticket state table (ID, title, priority, tier, current pipeline stage, stage status, next stages, landed flag, tier-done flag)
- Agent pool table (ID and description)
- Focus areas list
- Resumable tickets from prior runs (if any)
- Full tier pipeline reference

### The 11 scheduling rules

1. **Fill all free concurrency slots**
2. **Resume in-progress tickets first**
3. **Schedule the correct next stage** for each ticket's tier
4. **Load balance across focus areas**
5. **Keep the pipeline full** (schedule discovery when starved)
6. **Handle rate-limited agents** (spread work to others)
7. **No double-scheduling** (don't schedule a job that's already running)
8. **Maximize cheap agents** (prefer codex for implementation)
9. **Conditional review-fix** (only if review returned severity > "none")
10. **Respect tier completion** (don't schedule stages beyond a ticket's tier)
11. **Handle failed stages** (re-schedule or escalate)

### Output schema

```typescript
ticketScheduleSchema = z.object({
  jobs: z.array(z.object({
    jobId: z.string(),        // e.g. "T-1:research", "discovery"
    jobType: z.enum(JOB_TYPES),
    agentId: z.string(),      // key in agent pool
    ticketId: z.string().nullable(),
    focusId: z.string().nullable(),
    reason: z.string(),
  })),
  reasoning: z.string(),
  rateLimitedAgents: z.array(z.object({
    agentId: z.string(),
    resumeAtMs: z.number(),
  })),
})
```

---

## 6. Job Lifecycle

### The reconciliation loop (every Ralph iteration)

```
1. REAP:      For each job in scheduled_tasks DB, if isJobComplete(ctx, job) → removeJob(db, jobId)
2. RECONCILE: For each job in latest scheduler output, if !isJobComplete → insertJob(db, job)
3. READ:      activeJobs = getActiveJobs(db) (ordered by creation time)
4. RENDER:    activeJobs.map(job => <Job key={job.jobId} agent={resolveAgent(pool, job.agentId)} .../>)
```

### `isJobComplete`

Maps `jobType` to a Smithers output key, then checks `ctx.latest(outputKey, job.jobId)`:

```typescript
const JOB_TYPE_TO_OUTPUT_KEY = {
  "discovery":           "discover",
  "progress-update":     "progress",
  "ticket:research":     "research",
  "ticket:plan":         "plan",
  "ticket:implement":    "implement",
  "ticket:test":         "test_results",
  "ticket:build-verify": "build_verify",
  "ticket:spec-review":  "spec_review",
  "ticket:code-review":  "code_review",
  "ticket:review-fix":   "review_fix",
  "ticket:report":       "report",
};
```

### Job types

| Job Type | Scope | Node ID | Description |
|----------|-------|---------|-------------|
| `discovery` | Global | `"discovery"` | Find new tickets from specs/codebase |
| `progress-update` | Global | `"progress-update"` | Update PROGRESS.md |
| `ticket:research` | Per-ticket | `{ticketId}:research` | Gather context, write context file |
| `ticket:plan` | Per-ticket | `{ticketId}:plan` | Create TDD implementation plan |
| `ticket:implement` | Per-ticket | `{ticketId}:implement` | Write code following the plan |
| `ticket:test` | Per-ticket | `{ticketId}:test` | Run test suites, fix failures |
| `ticket:build-verify` | Per-ticket | `{ticketId}:build-verify` | Run builds, fix compilation errors |
| `ticket:spec-review` | Per-ticket | `{ticketId}:spec-review` | Check spec compliance |
| `ticket:code-review` | Per-ticket | `{ticketId}:code-review` | Check code quality |
| `ticket:review-fix` | Per-ticket | `{ticketId}:review-fix` | Fix review issues |
| `ticket:report` | Per-ticket | `{ticketId}:report` | Final status report |

---

## 7. Per-Ticket Pipeline Stages

Each stage reads prior stage outputs via selectors and passes relevant data as MDX prompt props.

### Research

**Prompt**: `Research.mdx`
**Reads**: nothing (first stage)
**Produces**: `{ contextFilePath: string, summary: string }`

The agent:
1. Reads specs and reference documentation
2. Reads existing implementation files listed in the ticket
3. Writes a context file at `docs/context/{ticketId}.md` with all paths and summaries
4. Commits with jj and pushes to the ticket branch

If the ticket was previously evicted from the merge queue, the prompt includes the full eviction context (reason, attempted commits, what landed on main since).

### Plan

**Prompt**: `Plan.mdx`
**Reads**: `selectResearch()` → contextFilePath, summary
**Produces**: `{ planFilePath: string, implementationSteps: string[] | null }`

The agent:
1. Reads the context file from research
2. Assesses whether TDD applies (behavior changes vs. mechanical work)
3. Breaks down work into small atomic steps
4. Identifies files to create and modify
5. Plans test approach (TDD if applicable)
6. Notes risks and potential issues
7. Writes the plan at `docs/plans/{ticketId}.md`
8. Commits with jj

### Implement

**Prompt**: `Implement.mdx`
**Reads**: `selectPlan()`, `selectImplement()` (previous attempt), `selectTestResults()` (failing tests), `selectCodeReviews()` (review feedback), `selectLand()` (eviction context)
**Produces**: `{ whatWasDone: string, filesCreated: string[] | null, filesModified: string[] | null, nextSteps: string | null }`

The agent:
1. Reads the plan and context files
2. Assesses TDD applicability
3. **If TDD applies**: Red-Green-Refactor — write failing tests first, then minimal implementation, then refactor
4. **If TDD does not apply**: make changes, typecheck, run existing tests
5. Runs verification commands
6. Follows architecture rules from config
7. **MANDATORY**: commits and pushes to `ticket/{ticketId}` branch — uncommitted work "does not count"

The implement prompt is the most complex, incorporating feedback from multiple sources: previous implementation attempt, failing tests, review issues, eviction context, and formatter/verification commands.

### Test

**Prompt**: `Test.mdx`
**Reads**: nothing directly (runs commands in worktree)
**Produces**: `{ goTestsPassed, rustTestsPassed, e2eTestsPassed, sqlcGenPassed: boolean, failingSummary: string | null }`

The agent:
1. Runs ALL provided test suite commands
2. Verifies TDD compliance: test files exist for new code, integration tests for user-facing features
3. If tests fail and code fixes are needed, commits each fix atomically with jj
4. Reports each category as passed or failed

### Build Verify

**Prompt**: `BuildVerify.mdx`
**Reads**: `selectImplement()` → filesCreated, filesModified, whatWasDone
**Produces**: `{ buildPassed: boolean, errors: string[] | null }`

The agent:
1. Runs each build step command
2. If builds fail: reads errors, fixes root cause (not symptoms), commits fixes atomically, re-runs to verify

### Spec Review

**Prompt**: `SpecReview.mdx`
**Reads**: `selectImplement()`, `selectTestResults()`
**Produces**: `{ severity: "none"|"minor"|"major"|"critical", feedback: string, issues: string[] | null }`

The agent:
1. Reads every file modified/created
2. Verifies against spec check items from config
3. Checks TDD compliance (tests written BEFORE implementation, unit tests, integration tests, edge cases)
4. Reports severity: critical (breaks core architecture), major (missing spec requirement), minor (naming/docs), none (perfect)

### Code Review

**Prompt**: `CodeReview.mdx`
**Reads**: `selectImplement()` → filesCreated, filesModified
**Produces**: `{ severity: "none"|"minor"|"major"|"critical", feedback: string, issues: string[] | null }`

The agent:
1. Reads every file modified/created
2. Checks: error handling, security, code style, test coverage, performance, architecture
3. Reports severity using the same scale as spec review

Three output schema variants exist: `code_review`, `code_review_codex`, `code_review_gemini`. `selectCodeReviews()` merges all three into worst-severity aggregate.

### Review Fix

**Only scheduled when**: review returned severity > "none" (scheduler rule 9)
**Prompt**: `ReviewFix.mdx`
**Reads**: `selectSpecReview()`, `selectCodeReviews()` → all issues
**Produces**: `{ allIssuesResolved: boolean, summary: string }`

The agent:
1. For EACH issue from both reviews: reads the relevant file, determines if valid or false positive
2. If valid: makes the fix. If false positive: documents why
3. After each fix, runs validation commands
4. If a fix requires new behavior: follows TDD (write test first, verify fail, fix, verify pass)
5. Each fix committed separately with jj

### Report

**Prompt**: `Report.mdx`
**Reads**: all previous stages
**Produces**: `{ ticketId, status: "partial"|"complete"|"blocked", summary, filesChanged, testsAdded, reviewRounds, struggles, lessonsLearned }`

The agent:
1. Verifies each acceptance criterion is met
2. Confirms all tests pass
3. Summarizes accomplishments
4. Notes struggles and lessons learned
5. Determines final status: "complete" (all criteria met), "partial" (some met), "blocked" (external dependency)

---

## 8. Tier Definitions

| Tier | Stages | Final Stage |
|------|--------|-------------|
| `trivial` | implement → build-verify | build-verify |
| `small` | implement → test → build-verify | build-verify |
| `medium` | research → plan → implement → test → build-verify → code-review | code-review |
| `large` | research → plan → implement → test → build-verify → spec-review → code-review → review-fix → report | report |

### Tier completion

`isTicketTierComplete()` checks only the **final required stage** for the ticket's tier. A trivial ticket is tier-complete when `build_verify` output exists. A large ticket requires `report` output.

Tier completion means the ticket is **ready for the merge queue**, not that it is done. A ticket is only "done" once it has landed on main.

---

## 9. Data Flow Between Stages

All `ctx` access goes through pure functions in `selectors.ts`. No raw `ctx.latest` calls scattered through components.

### Selector reference

| Selector | Output Key | Node ID Pattern |
|----------|-----------|-----------------|
| `selectDiscoverTickets(ctx)` | `discover` | `"discovery"` (all rows merged) |
| `selectResearch(ctx, id)` | `research` | `{id}:research` |
| `selectPlan(ctx, id)` | `plan` | `{id}:plan` |
| `selectImplement(ctx, id)` | `implement` | `{id}:implement` |
| `selectTestResults(ctx, id)` | `test_results` | `{id}:test` |
| `selectSpecReview(ctx, id)` | `spec_review` | `{id}:spec-review` |
| `selectCodeReviews(ctx, id)` | `code_review` + variants | `{id}:code-review` + variants |
| `selectLand(ctx, id)` | `land` then `merge_queue_result` | `{id}:land` or scan |
| `selectTicketPipelineStage(ctx, id)` | all stages (reverse walk) | returns stage name string |
| `selectCompletedTicketIds(ctx, tickets)` | calls `selectLand` | returns IDs where `merged === true` |

### Data threading chain

```
Research → {contextFilePath, summary}
    ↓
Plan → reads contextFilePath → {planFilePath, implementationSteps}
    ↓
Implement → reads planFilePath, implementationSteps, failingTests, reviewFeedback, evictionContext
    ↓            → {whatWasDone, filesCreated, filesModified}
Test → runs commands → {testsPassed, failingSummary}
    ↓
BuildVerify → reads filesCreated, filesModified → {buildPassed, errors}
    ↓
SpecReview → reads filesCreated, filesModified, testResults → {severity, feedback, issues}
    ↓
CodeReview → reads filesCreated, filesModified → {severity, feedback, issues}
    ↓
ReviewFix → reads all review issues → {allIssuesResolved, summary}
    ↓
Report → reads all prior data → {status, summary, lessonsLearned}
    ↓
MergeQueue → reads filesCreated, filesModified, worktreePath → land/evict
```

### Eviction context threading

When a ticket is evicted from the merge queue, `formatEvictionContext()` extracts the reason, details, attempted commit log, diff summary, and mainline changes since branch point. This is injected into Research, Plan, and Implement prompts on the next pipeline attempt.

---

## 10. The Merge Queue

### AgenticMergeQueue

Renders when `mergeQueueTickets.length > 0` (any ticket is tierComplete && !landed).

The agent receives:
- Queue status table (ticketId, title, priority, reportComplete, landed, filesModified)
- File overlap analysis (which files are touched by multiple tickets)
- Pre-land checks (commands to run in worktree before merge)
- Post-land CI checks (commands to run after rebase)
- Detailed jj merge instructions

### Merge flow per ticket (priority order: critical > high > medium > low)

1. Run pre-land checks in the ticket's worktree
2. `jj rebase -b bookmark("ticket/{ticketId}") -d {mainBranch}`
3. Run post-land CI checks
4. `jj bookmark set {mainBranch} -r bookmark("ticket/{ticketId}")` (fast-forward)
5. `jj git push --bookmark {mainBranch}`
6. `jj bookmark delete ticket/{ticketId}` + cleanup worktree

### On failure

Trivially resolvable conflicts (lockfiles, generated code) are resolved inline. Complex conflicts or CI failures evict the ticket with full context.

### Output schema

```typescript
merge_queue_result: z.object({
  ticketsLanded: z.array(z.object({ ticketId, mergeCommit, summary })),
  ticketsEvicted: z.array(z.object({ ticketId, reason, details })),
  ticketsSkipped: z.array(z.object({ ticketId, reason })),
  summary: z.string(),
  nextActions: z.string().nullable(),
})
```

### Speculative Merge Queue (alternative)

A non-LLM TypeScript implementation exists in `src/mergeQueue/coordinator.ts`. Not currently wired into the workflow but exported for potential use.

Works on a sliding window of `maxSpeculativeDepth` tickets. Each is rebased on top of the previous one (stacked). CI runs in parallel on all speculative branches. If all pass, fast-forward main. If ticket N fails, land 0..N-1, evict N, invalidate N+1..end.

Three ordering strategies: `"priority"`, `"ticket-order"`, `"report-complete-fifo"` (default).

---

## 11. Cross-Run Durability

### How ticket state persists

Smithers stores all output rows in SQLite, keyed by `(run_id, node_id, iteration)`. These persist across runs.

### Finding resumable tickets

`durability.ts` reads the Smithers DB directly (bypassing ctx) to find tickets from prior runs:

```typescript
function getResumableTickets(dbPath, currentRunId): CrossRunTicketState[] {
  const allState = loadCrossRunTicketState(dbPath);
  return allState.filter(t =>
    !t.landed &&
    t.latestRunId !== currentRunId &&
    t.pipelineStage !== "not_started"
  );
}
```

### Integration with scheduler

Resumable tickets are passed to `TicketScheduler` as a prop. The scheduler prompt renders a "Resumable Tickets from Previous Runs" section with instructions to prioritize them over discovering new tickets. Tickets further in the pipeline get higher priority.

### TicketResume component

An alternative resume mechanism. Renders a `<Task>` that checks if each prior ticket's jj bookmark still exists (`jj bookmark list | grep ticket/{ticketId}`). Sorted by pipeline stage (most advanced first).

---

## 12. The Monitor

### Fire-and-forget pattern

The Monitor runs as a sibling of SuperRalph in a `<Parallel>`:

```tsx
<Task id="monitor" output={monitorOutputSchema} continueOnFail={true}>
  {async () => {
    runMonitorUI({ dbPath, runId, projectName, prompt }).catch(() => {});
    return { started: true, status: "running" };  // Returns immediately
  }}
</Task>
```

`continueOnFail={true}` ensures a TUI crash doesn't block the pipeline.

### TUI implementation

Uses `@opentui/core` and `bun:sqlite`. Three-panel layout:
- **Header**: Run ID and truncated prompt
- **Stats bar**: Discovered / In Pipeline / Landed / Evicted / Jobs counts
- **Left panel (Pipeline)**: Per-ticket kanban with stage icons
- **Right panel**: Active jobs or ticket detail on Enter

Polls both databases every 2 seconds.

---

## 13. Configuration Flow

```
CLI args
  → promptText (inline, file, or stdin)
  → clarificationSession (interactive TUI)
  → buildFallbackConfig (auto-detected from repo)
      ↓
  InterpretConfig Task (AI agent)
  Inputs: prompt, clarificationSession, fallbackConfig, packageScripts, detectedAgents
  Output: interpretConfigOutputSchema
      ↓
  SuperRalph receives config via {...getInterpretedConfig(ctx)}
```

### InterpretConfig output schema

```typescript
z.object({
  projectName: z.string().min(1),
  projectId: z.string().min(1),
  focuses: z.array(z.object({
    id: z.string(), name: z.string(), description: z.string(),
  })).min(1).max(12),
  specsPath: z.string().min(1),
  referenceFiles: z.array(z.string()),
  buildCmds: z.record(z.string(), z.string()),
  testCmds: z.record(z.string(), z.string()),
  preLandChecks: z.array(z.string()),
  postLandChecks: z.array(z.string()),
  codeStyle: z.string().min(1),
  reviewChecklist: z.array(z.string()).min(1),
  maxConcurrency: z.number().int().min(1).max(64),
  reasoning: z.string().optional(),
})
```

---

## 14. Agent Configuration

Five role-based agents:

| Role | Primary Preference | Model |
|------|-------------------|-------|
| `planning` | claude | claude-sonnet-4-6 |
| `implementation` | codex | gpt-5.3-codex |
| `testing` | codex | gpt-5.3-codex |
| `reviewing` | claude | claude-sonnet-4-6 |
| `reporting` | claude | claude-sonnet-4-6 |

Agents are passed to SuperRalph as a `Record<string, { agent, description }>` pool. The scheduler assigns `agentId` strings to jobs. `resolveAgent` looks up the agent in the pool with fallback to the first available:

```typescript
function resolveAgent(pool, agentId): AgentLike {
  if (agentId && pool[agentId]) return pool[agentId].agent;
  return Object.values(pool)[0]?.agent;  // fallback to first
}
```

---

## Appendix: End-to-End Ticket Lifecycle

```
[Iteration 0]
  ├─ No tickets exist
  ├─ Scheduler: "pipeline starved, schedule discovery"
  │     → insertJob(db, {jobId:"discovery", jobType:"discovery"})
  │
[Iteration 1]
  ├─ Job("discovery") runs in Worktree("wt-discovery")
  │     Agent reads specs, codebase → outputs discover:{tickets:[T-1(medium), T-2(trivial)]}
  ├─ isJobComplete(discovery) = true → removeJob
  │
[Iteration 2]
  ├─ selectDiscoverTickets → [T-1, T-2]
  ├─ Scheduler: "schedule T-1:research + T-2:implement"
  │     → insertJob(db, {T-1:research}), insertJob(db, {T-2:implement})
  │
[Iterations 3-N: Pipeline execution (parallel)]
  │
  │  T-2 (trivial: implement → build-verify)
  │  ├─ T-2:implement runs → outputs implement:{filesCreated, filesModified, whatWasDone}
  │  ├─ T-2:build-verify runs → outputs build_verify:{buildPassed: true}
  │  └─ isTicketTierComplete(T-2, "trivial") = true ← final stage is build-verify ✓
  │
  │  T-1 (medium: research → plan → implement → test → build-verify → code-review)
  │  ├─ T-1:research → {contextFilePath: "docs/context/T-1.md", summary: "..."}
  │  ├─ T-1:plan → {planFilePath: "docs/plans/T-1.md", implementationSteps: [...]}
  │  ├─ T-1:implement → {whatWasDone, filesCreated, filesModified}
  │  ├─ T-1:test → {testsPassed, failingSummary}
  │  ├─ T-1:build-verify → {buildPassed: true}
  │  └─ T-1:code-review → {severity: "minor", feedback: "...", issues: [...]}
  │     isTicketTierComplete(T-1, "medium") = true ✓
  │
[When tierComplete && !landed]
  └─ AgenticMergeQueue fires with [T-2, T-1]
       │
       ├─ T-2: rebase → CI passes → fast-forward main → push → cleanup
       │     → merge_queue_result:{ticketsLanded:[{T-2}]}
       │
       ├─ T-1: rebase → CONFLICT → evict with context
       │     → merge_queue_result:{ticketsEvicted:[{T-1, reason: "rebase_conflict"}]}
       │
[Next iterations: Eviction recovery]
  ├─ Scheduler re-schedules T-1:implement (or earlier stage)
  ├─ Agent receives evictionContext with conflict details
  ├─ Agent re-implements avoiding the conflict
  ├─ Pipeline re-runs → tierComplete → re-enters merge queue
  └─ Second landing attempt succeeds → T-1 landed
```
