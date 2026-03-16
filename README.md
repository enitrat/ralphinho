# ralphinho

> Multi-agent AI development workflows — code review with improvinho, spec-driven implementation with ralphinho, and optional Linear integration for human-in-the-loop triage.

Built on the [Smithers](https://smithers.sh) workflow engine. Two standalone workflow modes plus an optional Linear glue layer that connects them into a self-improving loop.

## Workflows

| Mode | CLI | Input | Output |
|------|-----|-------|--------|
| **Ralphinho** (scheduled-work) | `ralphinho init ./rfc.md` | RFC/spec document | Implemented code, landed on main |
| **Improvinho** (review-discovery) | `ralphinho init review "prompt" --paths ...` | Review instruction + paths | Findings summary in `.tickets/summary.md` |

Both workflows are fully independent and can be used standalone without Linear.

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) >= 1.3
- [jj](https://martinvonz.github.io/jj/) (Jujutsu VCS) — `brew install jj`
  - `ralphinho init` automatically runs `jj git init --colocate` if the repo is not yet colocated
- At least one agent CLI: [`claude`](https://claude.ai/download) and/or [`codex`](https://openai.com/codex)

### Install

```bash
bun add github:enitrat/ralphinho smithers-orchestrator
```

### Ralphinho — Implement from spec

```bash
# Decompose an RFC into work units with a dependency DAG
ralphinho init ./docs/rfc-003.md

# Review and edit the generated plan
cat .ralphinho/work-plan.json

# Execute the workflow
ralphinho run
```

### Improvinho — Review and discover issues

```bash
# Initialize a review of specific paths
ralphinho init review "Review for bugs, security issues, and simplification opportunities" \
  --paths src/api/auth src/lib/session.ts

# Execute the review
ralphinho run

# Read the findings
cat .tickets/summary.md
```

## CLI Reference

```
ralphinho — Multi-agent AI development workflow CLI

Usage:
  ralphinho init ./rfc.md                               Decompose RFC into work units
  ralphinho init review "<prompt>" --paths <paths...>   Initialize review-discovery mode
  ralphinho plan                                        (Re)generate work plan from RFC
  ralphinho run                                         Execute the initialized workflow
  ralphinho run --resume <run-id>                       Resume a previous run
  ralphinho run --force                                 Resume without prompts
  ralphinho monitor --run-id <run-id>                   Attach TUI to a workflow run
  ralphinho status                                      Show current state

Global Options:
  --cwd <path>                Repo root (default: current directory)
  --max-concurrency <n>       Max parallel work units (default: 6)
  --force                     Skip prompts and attempt resume
  --help                      Show this help

Init Options:
  --dry-run                   Generate work plan but don't execute
  --agent <sonnet|opus|codex> Review mode only: override all review lens agents

Linear Integration:
  --linear                    Enable Linear integration (requires LINEAR_API_KEY)
  --team <id>                 Linear team ID (required with --linear)
  --label <name>              Linear label filter (default: "ralph-approved")
  --min-priority <level>      Minimum priority to push (critical|high|medium|low)
```

## Linear Integration

Linear serves as a human-in-the-loop buffer between improvinho (review) and ralphinho (implementation). This is entirely optional — both workflows work standalone without it.

### The Loop

```
Improvinho scans repo → pushes findings to Linear as issues
                              ↓
                    Human triages in Linear (accept / reject / edit)
                              ↓
Ralphinho consumes approved tickets → implements → marks done
```

### Improvinho → Linear (push findings)

After a successful review run, pass `--linear` to push findings as Linear issues:

```bash
# Run review and push findings to Linear
ralphinho init review "Review auth layer" --paths src/auth
ralphinho run --linear --team <team-id>

# Only push high+ priority findings
ralphinho run --linear --team <team-id> --min-priority high
```

Each finding becomes a Linear issue with:
- Title: `[IMP-0001] <summary>`
- Structured description with evidence, file refs, suggested diff
- Priority mapped to Linear's priority levels (critical=1, high=2, medium=3, low=4)
- Labels matching the finding kind (bug, security, etc.)

### Linear → Ralphinho (consume tickets)

When `--linear` is passed and no existing config is found, ralphinho automatically:

1. Fetches the highest-priority ticket with the specified label (default: `ralph-approved`)
2. Converts the ticket to RFC-like markdown
3. Runs `init scheduled-work` with the generated RFC
4. Executes the workflow
5. Marks the ticket as done on success

```bash
# Consume one approved ticket and implement it
ralphinho run --linear --team <team-id>

# With a custom label filter
ralphinho run --linear --team <team-id> --label ready-for-ai
```

### Environment

```bash
export ANTHROPIC_API_KEY=sk-...       # Required for AI decomposition
export LINEAR_API_KEY=lin_api_...     # Required for --linear
export LINEAR_TEAM_ID=<team-id>       # Optional — fallback for --team flag
export LINEAR_LABEL=ralph-approved    # Optional — fallback for --label flag
```

With `LINEAR_TEAM_ID` set, you can skip `--team` on every invocation:

```bash
ralphinho run --linear    # uses LINEAR_TEAM_ID from env
```

## How It Works

### Ralphinho: Quality Pipeline (per work unit)

Each work unit runs through a tier-based pipeline inside an isolated jj worktree:

| Tier | Stages |
|------|--------|
| **small** | implement → test → code-review → review-fix → final-review |
| **large** | research → plan → implement → test → prd-review + code-review → review-fix → final-review |

After quality pipelines complete, the merge queue lands units onto main:
1. Rebases onto main
2. Runs CI checks
3. Lands or evicts (eviction context feeds back into the next implementation pass)

### Improvinho: Review Pipeline (per scope)

Each review scope runs through 3 parallel discovery lenses:
- `refactor-hunter` — code smells, dead code, simplification
- `type-system-purist` — type safety, contract violations
- `app-logic-architecture` — architectural issues, cross-cutting concerns

Findings are validated (pure code, no second LLM call), deduplicated across lenses and scopes, and projected into a single summary.

### DAG-Driven Parallelism

Work units declare dependencies. Topological sorting produces layers:

```
Layer 0: [unit-a, unit-b]     ← no deps, run in parallel
Layer 1: [unit-c]             ← depends on unit-a
Layer 2: [unit-d, unit-e]     ← depend on unit-c
```

Layers execute sequentially; units within a layer run in parallel (up to `maxConcurrency`).

## Project Structure

```
src/
├── cli/                            # CLI entry points
│   ├── ralphinho.ts                # Main entry point
│   ├── init-scheduled.ts           # RFC decomposition + config
│   ├── init-review.ts              # Review discovery init
│   ├── plan.ts                     # Re-generate work plan
│   ├── run.ts                      # Execute workflow (+ Linear wiring)
│   ├── status.ts                   # Show current state
│   ├── monitor-cmd.ts              # Attach TUI
│   └── shared.ts                   # Arg parsing, env detection, utilities
├── workflows/
│   ├── ralphinho/                  # Scheduled-work workflow
│   │   ├── components/             # ScheduledWorkflow, QualityPipeline, AgenticMergeQueue
│   │   ├── workflow/               # contracts, decisions, state, snapshot
│   │   ├── prompts/                # MDX templates (Research, Plan, Implement, etc.)
│   │   ├── types.ts                # WorkPlan, WorkUnit, computeLayers
│   │   ├── schemas.ts              # Zod output schemas
│   │   ├── decompose.ts            # AI RFC decomposition
│   │   └── preset.tsx              # Smithers preset entry point
│   └── improvinho/                 # Review-discovery workflow
│       ├── components/             # ReviewDiscoveryWorkflow, ReviewSlicePipeline
│       ├── prompts/                # DiscoverIssues.mdx
│       ├── types.ts                # ReviewFinding, ReviewPlan
│       ├── schemas.ts              # Zod output schemas
│       ├── projection.ts           # Merge + summary generation
│       ├── lenses.ts               # Discovery lens definitions
│       └── preset.tsx              # Smithers preset entry point
├── adapters/
│   └── linear/                     # Optional Linear integration
│       ├── client.ts               # LinearClient singleton
│       ├── useLinear.ts            # Core operations (Effect-based)
│       ├── effect.ts               # Slim Effect interop layer
│       ├── push-findings.ts        # Improvinho findings → Linear issues
│       ├── consume-tickets.ts      # Linear tickets → RFC markdown
│       ├── types.ts                # Serializable Linear types
│       └── index.ts                # Barrel exports
├── runtime/                        # Smithers launch, events, projections
├── config/                         # Config schemas
└── index.ts                        # Package exports
```

## Further Documentation

| Document | Scope |
|----------|-------|
| [CONCEPTS.md](CONCEPTS.md) | Infrastructure: Smithers engine, agent system, jj VCS, worktree isolation, tiers |
| [IMPROVINHO.md](IMPROVINHO.md) | Improvinho review pipeline: scopes, lenses, finding model, projection |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Architecture index |

## License

MIT
