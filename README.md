# ralphinho

> Plan-driven AI development workflow — decompose specs into work units, implement them in parallel with quality gates, and land them onto main.

An opinionated [Smithers](https://smithers.sh) workflow. You provide a plan, ralphinho decomposes it into work units with a dependency DAG, runs each through a tier-based quality pipeline (research → plan → implement → test → review), and lands the results via a conflict-aware merge queue.

## Quick Start

From any repo with an RFC file:

```bash
# Install (or use bunx to run directly)
bun add github:enitrat/ralphinho smithers-orchestrator

# Initialize — decomposes the RFC into work units
bunx ralphinho init ./docs/rfc-003.md

# Review the generated plan, edit if needed
cat .ralphinho/work-plan.json

# Execute the workflow
bunx ralphinho run
```

### Prerequisites

- [Bun](https://bun.sh) >= 1.3
- [jj](https://martinvonz.github.io/jj/) (Jujutsu VCS) — `brew install jj`, then `jj git init --colocate` in your repo
- At least one agent CLI: [`claude`](https://claude.ai/download) and/or [`codex`](https://openai.com/codex)

## CLI

```
ralphinho — RFC-driven AI development workflow CLI

Usage:
  ralphinho init ./rfc.md              Decompose RFC into work units
  ralphinho plan                       (Re)generate work plan from RFC
  ralphinho run                        Execute the workflow
  ralphinho run --resume <run-id>      Resume a previous run
  ralphinho monitor                    Attach TUI to running workflow
  ralphinho status                     Show current state

Options:
  --cwd <path>                Repo root (default: cwd)
  --max-concurrency <n>       Max parallel work units (default: 6)
  --dry-run                   Generate plan without executing
  --help                      Show help
```

### `init`

Reads your RFC, scans the repo for build/test commands, detects available agent CLIs, then uses AI to decompose the RFC into work units with a dependency DAG. Outputs:

- `.ralphinho/config.json` — workflow configuration
- `.ralphinho/work-plan.json` — work units, dependencies, tiers, acceptance criteria

You can edit the work plan before running.

### `run`

Generates a Smithers workflow file, creates agent instances, and executes. The workflow:

1. Computes DAG layers (topological groups of independent units)
2. For each layer, runs quality pipelines in parallel (one per unit, in isolated jj worktrees)
3. Lands tier-complete units onto main via the merge queue
4. Repeats until all units land or max passes reached

### `plan`

Re-runs the AI decomposition using the RFC from the existing config. Useful after editing the RFC.

### `resume`

```bash
ralphinho run --resume sw-m3abc12-deadbeef
```

Picks up from exactly where a previous run stopped — partial implementations, in-progress reviews, everything is persisted in SQLite.

## How It Works

### Quality Pipeline (per unit)

Each work unit runs through a tier-based quality pipeline inside an isolated jj worktree:

| Tier | Stages | When to use |
|------|--------|-------------|
| **trivial** | implement → test | Config tweaks, dead code removal |
| **small** | implement → test → code-review | Single-file behavioral changes |
| **medium** | research → plan → implement → test → prd-review + code-review → review-fix | Multi-file features |
| **large** | research → plan → implement → test → prd-review + code-review → review-fix → final-review | Architectural changes |

The tier is assigned during RFC decomposition based on complexity assessment.

### Data Threading

Each stage reads prior outputs and feeds them forward:

```
research.contextFilePath → plan
plan.implementationSteps → implement
implement.{filesCreated, filesModified, whatWasDone} → test, reviews
test.{buildPassed, failingSummary} → reviews, implement (next pass)
reviews.{feedback, issues} → review-fix → implement (next pass)
final-review.reasoning → implement (next pass)
evictionContext → implement (after merge conflict)
```

### Merge Queue

After quality pipelines complete for a layer, the merge queue:

1. Detects file overlaps between units
2. Lands non-overlapping units speculatively (parallel rebase)
3. Lands overlapping units sequentially (rebase one at a time)
4. Runs post-land CI after each rebase
5. Evicts units with conflicts or test failures — detailed context is fed back to the implementer on the next pass

All VCS operations use jj: `jj rebase`, `jj bookmark set`, `jj git push`.

### DAG-Driven Parallelism

Work units declare dependencies. `computeLayers()` produces topological groups:

```
Layer 0: [unit-a, unit-b]     ← no deps, run in parallel
Layer 1: [unit-c]             ← depends on unit-a
Layer 2: [unit-d, unit-e]     ← depend on unit-c
```

Layers execute sequentially; units within a layer execute in parallel (up to `maxConcurrency`).

## Library Usage

The components can be used directly in custom Smithers workflows:

```tsx
import { createSmithers } from "smithers-orchestrator";
import { scheduledOutputSchemas } from "ralphinho/scheduled/schemas";
import { ScheduledWorkflow } from "ralphinho/components";

const { smithers, outputs, Workflow } = createSmithers(
  scheduledOutputSchemas,
  { dbPath: "./workflow.db" },
);

export default smithers((ctx) => (
  <Workflow name="my-workflow" cache>
    <ScheduledWorkflow
      ctx={ctx}
      outputs={outputs}
      workPlan={workPlan}
      repoRoot="/path/to/repo"
      maxConcurrency={6}
      agents={{
        researcher:    claudeAgent,
        planner:       opusAgent,
        implementer:   codexAgent,
        tester:        claudeAgent,
        prdReviewer:   claudeAgent,
        codeReviewer:  opusAgent,
        reviewFixer:   codexAgent,
        finalReviewer: opusAgent,
        mergeQueue:    opusAgent,
      }}
    />
  </Workflow>
));
```

### Components

| Component | Purpose |
|-----------|---------|
| `ScheduledWorkflow` | Main orchestrator — Ralph loop over DAG layers with pipelines + merge queue |
| `QualityPipeline` | Per-unit pipeline in an isolated worktree (research → implement → test → review) |
| `AgenticMergeQueue` | Lands completed units onto main, evicts on conflict |
| `Monitor` | TUI for observing workflow progress |

### Agent Configuration

Agents are role-based. Each role accepts a single agent or an array for fallback (Smithers v0.8+):

```tsx
agents={{
  implementer: [primaryCodex, fallbackClaude],  // array = fallback chain
  reviewer: claudeAgent,                         // single agent
}}
```

## Project Structure

```
src/
├── cli/                        # ralphinho CLI
│   ├── ralphinho.ts            # Entry point
│   ├── init-scheduled.ts       # RFC decomposition + config
│   ├── plan.ts                 # Re-generate work plan
│   ├── run.ts                  # Execute workflow
│   ├── render-scheduled-workflow.ts  # Generate workflow.tsx (~120 lines)
│   ├── status.ts               # Show current state
│   └── monitor-cmd.ts          # Attach TUI
├── components/
│   ├── ScheduledWorkflow.tsx    # Main orchestrator
│   ├── QualityPipeline.tsx      # Per-unit quality pipeline
│   ├── AgenticMergeQueue.tsx    # Conflict-aware merge queue
│   └── Monitor.tsx              # TUI dashboard
├── prompts/                     # MDX prompt templates
│   ├── Research.mdx
│   ├── Plan.mdx
│   ├── Implement.mdx
│   ├── Test.mdx
│   ├── PrdReview.mdx
│   ├── CodeReview.mdx
│   ├── ReviewFix.mdx
│   └── FinalReview.mdx
└── scheduled/
    ├── types.ts                 # WorkPlan, WorkUnit, SCHEDULED_TIERS, computeLayers
    ├── schemas.ts               # Zod output schemas (12 tables)
    └── decompose.ts             # AI RFC decomposition
```

## License

MIT
