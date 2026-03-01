# Refactor: Delete SuperRalph, Build Proper Scheduled Workflow Components

## Summary

Replace the 780-line string template in `render-scheduled-workflow.ts` with proper
Smithers components that reuse the existing MDX prompts. Delete all SuperRalph-specific
code (no backwards compatibility).

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Job.tsx | Rewrite as `QualityPipeline` | Job is tightly coupled to SuperRalph types |
| InterpretConfig.tsx | Delete | Scheduled work reads structured work-plan.json |
| Monitor.tsx | Keep and adapt | TUI is useful for observing progress |
| Schema naming | Drop `sw_` prefix | No more collision with SuperRalph schemas |
| MDX prompt props | Rename `ticketId` → `unitId` | Clean break, "ticket" concept deleted |
| Agent config | Role-based map | `Record<Role, AgentLike \| AgentLike[]>` |
| Review structure | prd-review + code-review (parallel) | Keep existing dual-concern separation |

---

## Phase 1: Delete SuperRalph

Delete all SuperRalph-specific files. No backwards compat.

### Files to delete
```
src/components/SuperRalph.tsx
src/components/TicketScheduler.tsx
src/components/InterpretConfig.tsx
src/components/Job.tsx
src/selectors.ts
src/scheduledTasks.ts
src/durability.ts
src/hooks/useSuperRalph.ts
src/agentRegistry.ts
src/cli/init-super-ralph.ts
src/cli/clarifying-questions.ts  (if exists — used by init-super-ralph)
src/prompts/Discover.mdx          (super-ralph discovery stage)
src/prompts/UpdateProgress.mdx    (super-ralph progress update)
```

### Files to gut
- `src/schemas.ts` — delete `ralphOutputSchemas` and all the SuperRalph-specific schemas
  (keep `COMPLEXITY_TIERS`, `getTierStages`, `getTierFinalStage`, `isTierStage` if still useful,
  or move them to `src/scheduled/types.ts` which already has `SCHEDULED_TIERS`)
- `src/index.ts` — remove all SuperRalph exports
- `src/components/index.ts` — remove SuperRalph, TicketScheduler, InterpretConfig, Job exports
- `src/cli/ralphinho.ts` — remove `super-ralph` init route
- `src/cli/run.ts` — remove `runSuperRalph()` function

---

## Phase 2: Rename Schemas (drop `sw_` prefix)

Rename `src/scheduled/schemas.ts` keys from `sw_*` to clean names.

### Before → After
```
sw_research         → research
sw_plan             → plan
sw_implement        → implement
sw_test             → test
sw_prd_review       → prd_review
sw_code_review      → code_review
sw_review_fix       → review_fix
sw_final_review     → final_review
sw_pass_tracker     → pass_tracker
sw_completion_report → completion_report
sw_merge_queue      → merge_queue
```

### Schema shapes (keep as-is, they're well-designed)

```ts
export const scheduledOutputSchemas = {
  research: z.object({
    contextFilePath: z.string(),
    findings: z.array(z.string()),
    referencesRead: z.array(z.string()),
    openQuestions: z.array(z.string()),
    notes: z.string().nullable(),
  }),
  plan: z.object({
    planFilePath: z.string(),
    implementationSteps: z.array(z.string()),
    filesToCreate: z.array(z.string()),
    filesToModify: z.array(z.string()),
    complexity: z.enum(["trivial", "small", "medium", "large"]),
  }),
  implement: z.object({
    summary: z.string(),
    filesCreated: z.array(z.string()).nullable(),
    filesModified: z.array(z.string()).nullable(),
    whatWasDone: z.string(),
    nextSteps: z.string().nullable(),
    believesComplete: z.boolean(),
  }),
  test: z.object({
    buildPassed: z.boolean(),
    testsPassed: z.boolean(),
    testsPassCount: z.number(),
    testsFailCount: z.number(),
    failingSummary: z.string().nullable(),
    testOutput: z.string(),
  }),
  prd_review: z.object({
    severity: z.enum(["critical", "major", "minor", "none"]),
    approved: z.boolean(),
    feedback: z.string(),
    issues: z.array(issueSchema).nullable(),
  }),
  code_review: z.object({
    severity: z.enum(["critical", "major", "minor", "none"]),
    approved: z.boolean(),
    feedback: z.string(),
    issues: z.array(issueSchema).nullable(),
  }),
  review_fix: z.object({
    summary: z.string(),
    fixesMade: z.array(z.object({ issue: z.string(), fix: z.string(), file: z.string().nullable() })),
    falsePositives: z.array(z.object({ issue: z.string(), reasoning: z.string() })),
    allIssuesResolved: z.boolean(),
    buildPassed: z.boolean(),
    testsPassed: z.boolean(),
  }),
  final_review: z.object({
    readyToMoveOn: z.boolean(),
    reasoning: z.string(),
    approved: z.boolean(),
    qualityScore: z.number(),
    remainingIssues: z.array(z.object({
      severity: z.enum(["critical", "major", "minor"]),
      description: z.string(),
      file: z.string().nullable(),
    })).nullable(),
  }),
  pass_tracker: z.object({
    totalIterations: z.number(),
    unitsRun: z.array(z.string()),
    unitsComplete: z.array(z.string()),
    summary: z.string(),
  }),
  completion_report: z.object({
    totalUnits: z.number(),
    unitsLanded: z.array(z.string()),
    unitsFailed: z.array(z.object({
      unitId: z.string(),
      lastStage: z.string(),
      reason: z.string(),
    })),
    passesUsed: z.number(),
    summary: z.string(),
    nextSteps: z.array(z.string()),
  }),
  merge_queue: mergeQueueResultSchema,  // reuse from AgenticMergeQueue
};
```

### Update references
- `src/cli/render-scheduled-workflow.ts` — uses `outputs.sw_*` → `outputs.*`
- `src/scheduled/index.ts` — re-export renamed schemas

---

## Phase 3: Rename MDX Prompt Props

Rename across all kept MDX files: `ticketId` → `unitId`, `ticketTitle` → `unitName`,
`ticketCategory` → `unitCategory`, `ticketDescription` → `unitDescription`.

### Files to update
```
src/prompts/Research.mdx
src/prompts/Plan.mdx
src/prompts/Implement.mdx
src/prompts/Test.mdx
src/prompts/BuildVerify.mdx       (assess: keep or delete — scheduled doesn't use build-verify)
src/prompts/SpecReview.mdx        (rename to PrdReview.mdx — matches scheduled naming)
src/prompts/CodeReview.mdx
src/prompts/ReviewFix.mdx
src/prompts/Report.mdx            (assess: keep or rename to FinalReview.mdx)
```

### New MDX prompt: FinalReview.mdx

Create `src/prompts/FinalReview.mdx` for the scheduled-work final gate.

Props:
```ts
{
  unitId: string;
  unitName: string;
  description: string;
  acceptanceCriteria: string[];
  pass: number;
  maxPasses: number;
  implSummary: string | null;
  believesComplete: boolean;
  buildPassed: boolean | null;
  testsPassCount: number;
  testsFailCount: number;
  prdSeverity: string | null;
  prdApproved: boolean | null;
  codeSeverity: string | null;
  codeApproved: boolean | null;
  issuesResolved: boolean | null;
}
```

### Add optional scheduled-work props to existing MDX prompts

These are additive — new optional fields that show conditionally:

| Prompt | New optional props |
|--------|-------------------|
| Research.mdx | `rfcSections: string[]`, `rfcSource: string` |
| Implement.mdx | `acceptanceCriteria: string[]`, `depSummaries: DepSummary[]` |
| Test.mdx | `whatWasDone: string`, `filesCreated: string[]`, `filesModified: string[]` |
| SpecReview/PrdReview.mdx | `acceptanceCriteria: string[]`, `rfcSections: string[]` |
| CodeReview.mdx | `whatWasDone: string` |

### Prompts to delete (super-ralph specific)
```
src/prompts/Discover.mdx
src/prompts/UpdateProgress.mdx
```

### Prompts to assess
- `BuildVerify.mdx` — scheduled tiers don't include build-verify. **Delete** (test stage covers build).
- `Report.mdx` — scheduled uses final-review, not report. **Delete** (replaced by FinalReview.mdx).

---

## Phase 4: Update AgenticMergeQueue

Small prop additions to make the component reusable for scheduled workflows.

### New props
```ts
export type AgenticMergeQueueProps = {
  // ... existing props ...
  /** Override the Task node ID (default: "agentic-merge-queue") */
  nodeId?: string;
  /** Branch prefix for unit branches (default: "ticket/") */
  branchPrefix?: string;
};
```

### Changes
- Add `nodeId` prop, pass to `<Task id={nodeId}>` (default: `"agentic-merge-queue"`)
- Add `branchPrefix` prop, use in prompt builder (default: `"ticket/"`)
- Replace all hardcoded `ticket/{ticketId}` in prompt with `${branchPrefix}{ticketId}`

---

## Phase 5: Create QualityPipeline Component

New file: `src/components/QualityPipeline.tsx`

Replaces `Job.tsx`. Renders the full quality pipeline for a single work unit
inside a `<Worktree>`, using MDX prompts and tier-based stage selection.

### Props interface
```ts
import type { SmithersCtx, AgentLike } from "smithers-orchestrator";
import type { WorkUnit, WorkPlan, ScheduledTier } from "../scheduled/types";

type ScheduledOutputs = typeof import("../scheduled/schemas").scheduledOutputSchemas;

type DepSummary = {
  id: string;
  whatWasDone: string;
  filesCreated: string[];
  filesModified: string[];
};

export type QualityPipelineProps = {
  unit: WorkUnit;
  ctx: SmithersCtx<ScheduledOutputs>;
  outputs: ScheduledOutputs;

  // Agents (per role, supports arrays for fallback)
  agents: {
    researcher: AgentLike | AgentLike[];
    planner: AgentLike | AgentLike[];
    implementer: AgentLike | AgentLike[];
    tester: AgentLike | AgentLike[];
    prdReviewer: AgentLike | AgentLike[];
    codeReviewer: AgentLike | AgentLike[];
    reviewFixer: AgentLike | AgentLike[];
    finalReviewer: AgentLike | AgentLike[];
  };

  // Work plan context
  workPlan: WorkPlan;
  depSummaries: DepSummary[];
  evictionContext: string | null;

  // Config
  retries?: number;
};
```

### Render structure
```tsx
<Worktree path={`/tmp/workflow-wt-${unit.id}`} branch={`unit/${unit.id}`}>
  <Sequence>
    {/* Research (medium/large) */}
    {tierHas("research") && (
      <Task id={`${uid}:research`} output={outputs.research} agent={agents.researcher}>
        <ResearchPrompt unitId={unit.id} unitName={unit.name} ... />
      </Task>
    )}

    {/* Plan (medium/large) */}
    {tierHas("plan") && (
      <Task id={`${uid}:plan`} output={outputs.plan} agent={agents.planner}>
        <PlanPrompt unitId={unit.id} ... />
      </Task>
    )}

    {/* Implement (all tiers) */}
    <Task id={`${uid}:implement`} output={outputs.implement} agent={agents.implementer}>
      <ImplementPrompt unitId={unit.id} ... />
    </Task>

    {/* Test (all tiers) */}
    <Task id={`${uid}:test`} output={outputs.test} agent={agents.tester}>
      <TestPrompt unitId={unit.id} ... />
    </Task>

    {/* PRD + Code Review (parallel, medium/large) */}
    <Parallel continueOnFail>
      {tierHas("prd-review") && (
        <Task id={`${uid}:prd-review`} output={outputs.prd_review} agent={agents.prdReviewer} continueOnFail>
          <PrdReviewPrompt unitId={unit.id} ... />
        </Task>
      )}
      {tierHas("code-review") && (
        <Task id={`${uid}:code-review`} output={outputs.code_review} agent={agents.codeReviewer} continueOnFail>
          <CodeReviewPrompt unitId={unit.id} ... />
        </Task>
      )}
    </Parallel>

    {/* ReviewFix (medium/large, skip if both approve) */}
    {tierHas("review-fix") && (
      <Task id={`${uid}:review-fix`} output={outputs.review_fix} agent={agents.reviewFixer}
            skipIf={bothApproved}>
        <ReviewFixPrompt unitId={unit.id} ... />
      </Task>
    )}

    {/* FinalReview (large only — the gate) */}
    {tierHas("final-review") && (
      <Task id={`${uid}:final-review`} output={outputs.final_review} agent={agents.finalReviewer}>
        <FinalReviewPrompt unitId={unit.id} ... />
      </Task>
    )}
  </Sequence>
</Worktree>
```

### Data threading
Each step reads prior outputs via `ctx.outputMaybe()` / `ctx.latest()`:
```
research.contextFilePath → plan.contextFilePath
plan.implementationSteps → implement.implementationSteps
implement.{filesCreated, filesModified, whatWasDone} → test, prd-review, code-review
test.{buildPassed, testsPassed, failingSummary} → prd-review, implement (next pass)
prd-review.{severity, feedback, issues} → review-fix
code-review.{severity, feedback, issues} → review-fix
final-review.reasoning → implement (next pass)
evictionContext → implement
```

---

## Phase 6: Create ScheduledWorkflow Component

New file: `src/components/ScheduledWorkflow.tsx`

The main orchestrator that composes `QualityPipeline` + `AgenticMergeQueue`.

### Props interface
```ts
export type ScheduledWorkflowProps = {
  ctx: SmithersCtx<ScheduledOutputs>;
  outputs: ScheduledOutputs;
  workPlan: WorkPlan;
  repoRoot: string;
  maxConcurrency: number;
  maxPasses?: number;        // default: 3
  mainBranch?: string;       // default: "main"
  agents: {
    researcher: AgentLike | AgentLike[];
    planner: AgentLike | AgentLike[];
    implementer: AgentLike | AgentLike[];
    tester: AgentLike | AgentLike[];
    prdReviewer: AgentLike | AgentLike[];
    codeReviewer: AgentLike | AgentLike[];
    reviewFixer: AgentLike | AgentLike[];
    finalReviewer: AgentLike | AgentLike[];
    mergeQueue: AgentLike | AgentLike[];
  };
};
```

### Render structure
```tsx
export function ScheduledWorkflow({ ctx, outputs, workPlan, repoRoot, agents,
  maxConcurrency, maxPasses = 3, mainBranch = "main",
}: ScheduledWorkflowProps) {
  const units = workPlan.units;
  const layers = computeLayers(units);

  // Gate functions (read from ctx.latest)
  const tierComplete = (unitId) => { /* ... */ };
  const unitLanded = (unitId) => { /* read from merge_queue outputs */ };
  const unitEvicted = (unitId) => { /* ... */ };
  const getEvictionContext = (unitId) => { /* ... */ };
  const unitComplete = (unitId) => unitLanded(unitId);

  // Pass tracking
  const passTracker = ctx.latest("pass_tracker", "pass-tracker");
  const currentPass = passTracker?.totalIterations ?? 0;
  const done = currentPass >= maxPasses || units.every(u => unitComplete(u.id));

  return (
    <Sequence>
      <Ralph until={done} maxIterations={maxPasses * units.length * 20} onMaxReached="return-last">
        <Sequence>
          {layers.map((layer, layerIdx) => (
            <Sequence key={`layer-${layerIdx}`}>
              {/* Phase 1: Parallel quality pipelines */}
              <Parallel maxConcurrency={maxConcurrency}>
                {layer.map(unit => {
                  if (unitLanded(unit.id)) return null;
                  return (
                    <QualityPipeline
                      key={unit.id}
                      unit={unit}
                      ctx={ctx}
                      outputs={outputs}
                      agents={agents}  // minus mergeQueue
                      workPlan={workPlan}
                      depSummaries={buildDepSummaries(unit, ctx)}
                      evictionContext={getEvictionContext(unit.id)}
                    />
                  );
                })}
              </Parallel>

              {/* Phase 2: Merge queue — land tier-complete units */}
              <AgenticMergeQueue
                nodeId={`merge-queue:layer-${layerIdx}`}
                branchPrefix="unit/"
                tickets={buildMergeTickets(layer, ctx)}
                agent={agents.mergeQueue}
                output={outputs.merge_queue}
                repoRoot={repoRoot}
                mainBranch={mainBranch}
                postLandChecks={Object.values(workPlan.repo.testCmds)}
                preLandChecks={[]}
              />
            </Sequence>
          ))}

          {/* Pass tracker */}
          <Task id="pass-tracker" output={outputs.pass_tracker}>
            {{ totalIterations: currentPass + 1, ... }}
          </Task>
        </Sequence>
      </Ralph>

      {/* Completion report */}
      <Task id="completion-report" output={outputs.completion_report}>
        {{ totalUnits: units.length, ... }}
      </Task>
    </Sequence>
  );
}
```

### Helper functions (inside the component)
- `buildDepSummaries(unit, ctx)` — gather implement outputs for unit's deps
- `buildMergeTickets(layer, ctx)` — convert tier-complete units to `AgenticMergeQueueTicket[]`
- `tierComplete(unitId)` — check if quality pipeline passed for unit's tier
- `unitLanded(unitId)` / `unitEvicted(unitId)` — read from merge_queue outputs

---

## Phase 7: Slim Down render-scheduled-workflow.ts

Reduce from ~780 lines to ~100 lines. The generated workflow file imports and configures
`ScheduledWorkflow` — following the same pattern as the super-ralph generated workflow.

### Target structure
```tsx
import React from "react";
import { readFileSync } from "node:fs";
import { createSmithers, ClaudeCodeAgent, CodexAgent } from "smithers-orchestrator";
import { scheduledOutputSchemas } from "${importPrefix}/scheduled/schemas";
import { ScheduledWorkflow } from "${importPrefix}/components";

const REPO_ROOT = "...";
const DB_PATH = "...";
const PLAN_PATH = "...";
const MAX_CONCURRENCY = 6;

const workPlan = JSON.parse(readFileSync(PLAN_PATH, "utf8"));

// Agent factory (same pattern as super-ralph generated file)
function createClaude(role: string, model = "claude-sonnet-4-6") { ... }
function createCodex(role: string) { ... }
function chooseAgent(primary, role) { ... }

const agents = {
  researcher:    chooseAgent("claude", "Researcher"),
  planner:       chooseAgent("opus",   "Planner"),
  implementer:   chooseAgent("codex",  "Implementer"),
  tester:        chooseAgent("claude", "Tester"),
  prdReviewer:   chooseAgent("claude", "PRD Reviewer"),
  codeReviewer:  chooseAgent("opus",   "Code Reviewer"),
  reviewFixer:   chooseAgent("codex",  "Review Fixer"),
  finalReviewer: chooseAgent("opus",   "Final Reviewer"),
  mergeQueue:    chooseAgent("opus",   "Merge Queue"),
};

const { smithers, outputs, Workflow } = createSmithers(
  scheduledOutputSchemas,
  { dbPath: DB_PATH },
);

export default smithers((ctx) => (
  <Workflow name="scheduled-work" cache>
    <ScheduledWorkflow
      ctx={ctx}
      outputs={outputs}
      workPlan={workPlan}
      repoRoot={REPO_ROOT}
      maxConcurrency={MAX_CONCURRENCY}
      agents={agents}
    />
  </Workflow>
));
```

---

## Phase 8: Adapt Monitor.tsx

Update Monitor to work with scheduled workflow data model:
- Show layers and units instead of tickets
- Read from renamed schema tables (no `sw_` prefix)
- Display unit progress through quality pipeline stages

(Lower priority — can be done as a follow-up)

---

## Phase 9: Update Exports

### src/components/index.ts
```ts
export { QualityPipeline } from "./QualityPipeline";
export type { QualityPipelineProps } from "./QualityPipeline";

export { ScheduledWorkflow } from "./ScheduledWorkflow";
export type { ScheduledWorkflowProps } from "./ScheduledWorkflow";

export { AgenticMergeQueue, mergeQueueResultSchema } from "./AgenticMergeQueue";
export type { AgenticMergeQueueProps, AgenticMergeQueueTicket, MergeQueueResult } from "./AgenticMergeQueue";

export { Monitor, monitorOutputSchema } from "./Monitor";
export type { MonitorOutput, MonitorProps } from "./Monitor";
```

### src/index.ts
```ts
// Components
export { QualityPipeline, ScheduledWorkflow, AgenticMergeQueue, Monitor } from "./components";

// Scheduled work types
export { computeLayers, validateDAG, SCHEDULED_TIERS } from "./scheduled/types";
export type { WorkPlan, WorkUnit, ScheduledTier } from "./scheduled/types";

// Schemas
export { scheduledOutputSchemas } from "./scheduled/schemas";
```

### src/scheduled/index.ts
- Re-export renamed schemas
- Remove any SuperRalph-specific re-exports

---

## Phase 10: Verify Build

- Run `bun build` or `tsc --noEmit`
- Fix any import/type errors
- Ensure `ralphinho init scheduled-work` + `ralphinho run` still works end-to-end

---

## Execution Order

```
Phase 1 (Delete SuperRalph)
    ↓
Phase 2 (Rename schemas)  ←  can parallel with Phase 3
Phase 3 (Rename MDX props)  ←  can parallel with Phase 2
    ↓
Phase 4 (Update AgenticMergeQueue)
    ↓
Phase 5 (Create QualityPipeline)
    ↓
Phase 6 (Create ScheduledWorkflow)
    ↓
Phase 7 (Slim render-scheduled-workflow.ts)
    ↓
Phase 8 (Adapt Monitor — lower priority)
    ↓
Phase 9 (Update exports)
    ↓
Phase 10 (Verify build)
```

## Files Created
```
src/components/QualityPipeline.tsx    (new — replaces Job.tsx)
src/components/ScheduledWorkflow.tsx  (new — main orchestrator)
src/prompts/FinalReview.mdx           (new — gate prompt for large units)
```

## Files Modified
```
src/components/AgenticMergeQueue.tsx  (add nodeId + branchPrefix props)
src/components/Monitor.tsx            (adapt to scheduled data model)
src/components/index.ts               (update exports)
src/scheduled/schemas.ts              (drop sw_ prefix)
src/scheduled/index.ts                (update exports)
src/cli/render-scheduled-workflow.ts  (slim down to ~100 lines)
src/cli/ralphinho.ts                  (remove super-ralph init route)
src/cli/run.ts                        (remove runSuperRalph)
src/index.ts                          (clean up exports)
src/prompts/Research.mdx              (rename props + add rfcSections)
src/prompts/Plan.mdx                  (rename props)
src/prompts/Implement.mdx             (rename props + add acceptanceCriteria, depSummaries)
src/prompts/Test.mdx                  (rename props + add context fields)
src/prompts/SpecReview.mdx            (rename to PrdReview.mdx, rename props)
src/prompts/CodeReview.mdx            (rename props + add whatWasDone)
src/prompts/ReviewFix.mdx             (rename props)
```

## Files Deleted
```
src/components/SuperRalph.tsx
src/components/TicketScheduler.tsx
src/components/InterpretConfig.tsx
src/components/Job.tsx
src/selectors.ts
src/scheduledTasks.ts
src/durability.ts
src/hooks/useSuperRalph.ts
src/agentRegistry.ts
src/schemas.ts                         (ralphOutputSchemas no longer needed)
src/cli/init-super-ralph.ts
src/cli/clarifying-questions.ts
src/prompts/Discover.mdx
src/prompts/UpdateProgress.mdx
src/prompts/BuildVerify.mdx
src/prompts/Report.mdx
```
