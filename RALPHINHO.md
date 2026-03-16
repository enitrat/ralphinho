# Ralphinho

An RFC-driven, multi-agent development pipeline. Takes an RFC document, decomposes it into work units with a dependency DAG, runs each unit through a quality pipeline of specialized AI agents, and lands them onto main via a merge queue.

For infrastructure details (Smithers engine, jj VCS, agent system), see [CONCEPTS.md](CONCEPTS.md).

---

## 1. Overview

### Setup

```
                   ┌─────────────┐
                   │  RFC / PRD  │
                   └──────┬──────┘
                          │
           ┌──────────────▼──────────────┐
           │  ralphinho init scheduled   │
           │                             │
           │  1. Scan repo (build/test   │
           │     commands, pkg manager)  │
           │  2. Detect agents on PATH   │
           │  3. AI decomposes RFC into  │
           │     work units + DAG        │
           └──────────────┬──────────────┘
                          │
                ┌─────────▼─────────┐
                │  work-plan.json   │
                │                   │
                │  units:           │
                │   ├─ id, tier     │
                │   ├─ description  │
                │   ├─ acceptance   │
                │   └─ deps: [...]  │
                └─────────┬─────────┘
                          │
                   human reviews
                    and edits
                          │
                ┌─────────▼─────────┐
                │  ralphinho run    │
                │                   │
                │  Launches the     │
                │  built-in Smithers│
                │  preset against   │
                │  .ralphinho state │
                └───────────────────┘
```

### Main Loop

A single `<Ralph>` loop drives the entire execution. On each iteration, every unit is classified into one of three states based on the dependency DAG and prior outputs. Only **Active** units run their quality pipeline. The merge queue runs once at the end of each iteration for all freshly quality-complete units.

```
┌─ Ralph Loop (up to MAX_PASSES) ──────────────────────────────────────────┐
│                                                                           │
│  Classify each unit:                                                      │
│    Done      = landed on main           → skip entirely                   │
│    NotReady  = deps not all Done        → skip (wait for deps)            │
│    Active    = deps satisfied, not Done → run quality pipeline            │
│                                                                           │
│  ┌─ Phase 1: Quality Pipelines (parallel, Active units only) ──────────┐ │
│  │                                                                      │ │
│  │  ┌── Unit A (large, Active) ──┐   ┌── Unit B (small, NotReady) ──┐ │ │
│  │  │                             │   │           SKIPPED             │ │ │
│  │  │  Research                   │   │   (dep A not yet Done)        │ │ │
│  │  │  Plan                       │   └───────────────────────────────┘ │ │
│  │  │  Implement                  │                                     │ │
│  │  │  Test                       │   ┌── Unit C (small, Active) ────┐ │ │
│  │  │  PRD + Code Review          │   │                               │ │ │
│  │  │  Review Fix                 │   │  Implement                    │ │ │
│  │  │  Final Review               │   │  Test                         │ │ │
│  │  │                             │   │  Code Review → Review Fix     │ │ │
│  │  │                             │   │  Final Review                 │ │ │
│  │  └─────────────────────────────┘   └───────────────────────────────┘ │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                                                           │
│  ┌─ Phase 2: Merge Queue ───────────────────────────────────────────────┐ │
│  │  For each freshly quality-complete unit:                              │ │
│  │    rebase onto main → run tests → land or evict                      │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                                                                           │
│  Done units skip. NotReady units re-check deps next iteration.            │
│  Evicted units re-enter as Active with conflict context.                  │
└───────────────────────────────────────────────────────────────────────────┘
```

**Example with dependencies (A→B, C independent):**

| Iteration | A | B (dep: A) | C | Merge Queue |
|-----------|---|------------|---|-------------|
| 1 | Pipeline → quality passes | Skip (NotReady) | Pipeline → quality passes | Land A ✓, Land C: conflict ✗ |
| 2 | Skip (Done) | Pipeline → quality passes | Pipeline (rebase fix) → quality passes | Land B ✓, Land C ✓ |
| 3 | All Done → Ralph exits | | | |

### Unit States

Each unit is in exactly one state at any point during execution. State is derived from context outputs, not stored explicitly.

```
                ┌─────────────────────┐
                │       ACTIVE        │ ← initial (deps satisfied or none)
                │  (run quality       │
                │   pipeline)         │
                └──────────┬──────────┘
                           │ tier gate passed (quality complete)
                           ▼
                ┌─────────────────────┐
                │  QUALITY-COMPLETE   │
                │  (enters merge      │
                │   queue this iter)  │
                └──────┬───────┬──────┘
                       │       │ evicted by merge queue
                       │       ▼
                       │  ┌─────────────────────┐
                       │  │  ACTIVE (evicted)   │ ← re-enter with eviction ctx
                       │  └─────────────────────┘
          landed ✓     │
                       ▼
                ┌─────────────────────┐
                │       DONE          │
                │  (skip entirely)    │
                └─────────────────────┘


   NotReady: deps not all Done → skip, re-check next iteration
```

**State derivation:**
- **Done**: merge queue output includes this unit in `ticketsLanded`
- **NotReady**: at least one dependency unit is not Done
- **Active**: all deps Done (or no deps) AND unit not landed
- Quality-complete is a sub-state of Active: the tier gate has passed but landing hasn't been attempted yet

### Per-Unit Quality Pipeline (detailed)

Each unit runs through the stages below inside its own worktree. Stages are gated by tier — a `small` unit skips research, plan, and PRD review. The diagram shows the full `large` pipeline with all feedback loops.

```
                          ╔═══════════════════════════════════════════════╗
                          ║  EVICTION / REVIEW FEEDBACK (from prior pass) ║
                          ║  Injected into research/plan/implement when   ║
                          ║  a previous attempt failed or was evicted.    ║
                          ╚═══════════════════════╤═══════════════════════╝
                                                  │
         ┌────────────────────────────────────────┼──────────────────────┐
         │  Per-Unit Pipeline (in worktree)       │                      │
         │                                        ▼                      │
         │  ┌──────────────────────────────────────────────────────────┐ │
         │  │  RESEARCH                                       [Sonnet] │ │
         │  │  Read RFC sections + codebase. Produce a context doc     │ │
         │  │  with findings, file references, and open questions.     │ │
         │  │  ── large only ── run once, skip if exists ──   │ │
         │  └─────────────────────────┬────────────────────────────────┘ │
         │                            │                                  │
         │                            ▼                                  │
         │  ┌──────────────────────────────────────────────────────────┐ │
         │  │  PLAN                                             [Opus] │ │
         │  │  Read context doc + RFC. Design atomic implementation    │ │
         │  │  steps, identify files to create/modify, plan tests.     │ │
         │  │  ── large only ── run once, skip if exists ──   │ │
         │  └─────────────────────────┬────────────────────────────────┘ │
         │                            │                                  │
         │                            ▼                                  │
         │  ┌──────────────────────────────────────────────────────────┐ │
         │  │  IMPLEMENT                                      [Codex] │ │
         │  │  Write code following the plan. TDD for new behavior,    │ │
         │  │  direct implementation for mechanical changes. Receives  │ │
         │  │  dependency context (what prior units built) + eviction  │ │
         │  │  context + review feedback from prior iterations.        │ │
         │  │  ── all tiers ──                                         │ │
         │  └─────────────────────────┬────────────────────────────────┘ │
         │                            │                                  │
         │                            ▼                                  │
         │  ┌──────────────────────────────────────────────────────────┐ │
         │  │  TEST                                            [Sonnet] │ │
         │  │  Run build + full test suite. Report pass/fail counts.   │ │
         │  │  Fix compilation errors if possible.                     │ │
         │  │  ── all tiers ──                                         │ │
         │  └─────────────────────────┬────────────────────────────────┘ │
         │                            │                                  │
         │                  ┌─────────┴─────────┐                        │
         │                  │  run in parallel   │                        │
         │                  ▼                   ▼                        │
         │  ┌─────────────────────┐ ┌─────────────────────────┐         │
         │  │  PRD REVIEW [Sonnet]│ │  CODE REVIEW      [Opus]│         │
         │  │                     │ │                          │         │
         │  │  Does the code      │ │  Is the code well-      │         │
         │  │  match the RFC spec │ │  written? Check error    │         │
         │  │  and acceptance     │ │  handling, security,     │         │
         │  │  criteria?          │ │  conventions, coverage.  │         │
         │  │                     │ │                          │         │
         │  │  ── large only ──  │ │  ── all tiers ──         │         │
         │  └─────────┬───────────┘ └──────────┬──────────────┘         │
         │            └──────────┬─────────────┘                         │
         │                       │                                       │
         │            both approved? ───yes───▶ (skip review-fix)        │
         │                       │ no                     │              │
         │                       ▼                        │              │
         │  ┌──────────────────────────────────────────┐  │              │
         │  │  REVIEW FIX                      [Codex] │  │              │
         │  │  Address issues in severity order         │  │              │
         │  │  (critical first). Fix valid issues,     │  │              │
         │  │  document false positives. Re-run         │  │              │
         │  │  build + tests after each fix.            │  │              │
         │  │  ── all tiers ──                 │  │              │
         │  └─────────────────────┬────────────────────┘  │              │
         │                        │◄──────────────────────┘              │
         │                        ▼                                      │
         │  ┌──────────────────────────────────────────────────────────┐ │
         │  │  FINAL REVIEW                                     [Opus] │ │
         │  │  Quality gate. Checks: all acceptance criteria met,      │ │
         │  │  tests pass, review severity ≤ minor. Decides            │ │
         │  │  readyToMoveOn. If false, reasoning is fed back to       │ │
         │  │  implement on the next Ralph iteration.                  │ │
         │  │  ── all tiers ──                                         │ │
         │  └─────────────────────┬────────────────────────────────────┘ │
         │                        │                                      │
         │                        ▼                                      │
         │              ┌─────────────────┐                              │
         │              │  TIER COMPLETE  │──────▶ enters merge queue    │
         │              └─────────────────┘                              │
         └───────────────────────────────────────────────────────────────┘

Feedback loops:
  ─ Final review reasoning  ──────────────────────┐
  ─ PRD review feedback     ──────────────────────┤
  ─ Code review feedback    ──────────────────────┼──▶ injected into IMPLEMENT
  ─ Failing test output     ──────────────────────┤     on next Ralph iteration
  ─ Merge queue eviction ctx ─────────────────────┘
```

### Landing on Main

```
 unit/{id} branch
        │
        ▼
┌──────────────────┐    conflict    ┌────────────────────────┐
│  Rebase onto     │──────────────▶│  EVICT                 │
│  main            │                │  (capture conflict ctx) │
└───────┬──────────┘                └────────────────────────┘
        │ clean
        ▼
┌──────────────────┐    fail        ┌────────────────────────┐
│  Run build +     │──────────────▶│  EVICT                 │
│  tests           │                │  (capture test output)  │
└───────┬──────────┘                └────────────────────────┘
        │ pass
        ▼
┌──────────────────┐
│  Fast-forward    │
│  main to unit    │
│  tip, push,      │
│  delete bookmark │
└──────────────────┘
```

---

## 2. Detailed Design

### A. Pre-Workflow: RFC Decomposition

**What happens**: `ralphinho init scheduled-work ./rfc.md` scans the repo, detects available agents, and sends the RFC to an AI (Claude Sonnet) that decomposes it into work units with a dependency DAG. The output is `.ralphinho/work-plan.json`.

**Why an upfront decomposition**: The alternative — discovering work at runtime — makes the pipeline unpredictable. Upfront decomposition gives the human a concrete plan to review and edit before any agent touches code. It also makes execution deterministic: the DAG locks in parallelism and ordering, so reruns are reproducible.

**Why human review matters**: The AI decomposition is a first draft. Humans can adjust tiers (promote/demote complexity), merge units that overlap on files (avoiding merge conflicts), remove unnecessary units, or tighten acceptance criteria. This is the single highest-leverage intervention point in the pipeline.

**Decomposition rules the AI follows**:
- **Prefer fewer, cohesive units** — each unit adds pipeline overhead and merge risk. Only split when units touch genuinely independent files.
- **Minimize cross-unit file overlap** — two units modifying the same file will conflict at merge time, requiring an expensive re-run.
- **Keep tests with implementation** — never decompose "implement X" and "test X" as separate units. Tests are part of the implementation.
- **Tiers are binary** — `small` for focused changes with clear scope, `large` for multi-file or architectural work needing research and planning.

**The DAG**: Dependencies are only added where a real code dependency exists (unit B imports a type that unit A creates). The DAG is validated for missing references and cycles.

### B. Dynamic Dependency-Based Scheduling

Unlike a static layer-based approach, the Ralph loop dynamically determines which units are workable on each iteration by checking the dependency graph against current landing state.

**Why dynamic scheduling**: A static layer model (layer 0 → layer 1 → ...) runs all layers sequentially even when a layer's merge queue produces no results. This lets downstream units run before their dependencies have landed — violating the DAG. Dynamic scheduling checks each unit's deps individually, so a unit only runs when ALL its specific dependencies are Done (landed on main).

**How it works**: On each Ralph re-render, every unit is classified:

1. **Done** — The merge queue has landed this unit on main. Skip it entirely.
2. **NotReady** — At least one dep is not Done. Skip it (it will be re-evaluated next iteration when its deps may have landed).
3. **Active** — All deps are Done (or the unit has no deps) and the unit itself is not landed. Run its quality pipeline.

Independent units (no deps) are always Active from iteration 1. Units with deps become Active only after their specific dependency units land — not after an entire "layer" completes.

**Dependency context**: When a unit becomes Active, the implement stage receives `depSummaries` from all landed dependency units — `whatWasDone`, `filesCreated`, `filesModified`. This tells the implementer what APIs and files its dependencies produced.

### C. Quality Pipeline: Separate Context Windows

Each work unit runs through a quality pipeline whose depth depends on its tier:

| Tier | Pipeline |
|------|----------|
| `small` | implement → test → code-review → review-fix → final-review |
| `large` | research → plan → implement → test → prd-review + code-review → review-fix → final-review |

**The core principle is separate context windows for separate concerns.**

Each stage runs in its own agent process with its own context window. The researcher reads the codebase and RFC to produce a context document. The planner reads that document to produce a plan. The implementer reads the plan to write code. The reviewer reads the code to find issues. No single agent has to hold the entire problem in context.

This separation is deliberate:
- **Research and planning** use Claude (Sonnet/Opus) — good at reading code, understanding architecture, and producing structured analysis. These stages run once per unit and are not re-run on quality retries.
- **Implementation** uses Codex — good at writing code, running commands, and iterating on test failures.
- **Reviews** use Claude (Opus for code review, Sonnet for PRD review) — good at spotting issues without being the author of the code.

The reviewer never wrote the code it's reviewing. This eliminates author bias — the same failure mode that makes self-review unreliable in human teams.

**Tier gate (quality-complete)**: A unit is quality-complete when its tier-specific gate passes:
- `small`: tests pass AND final review says `readyToMoveOn`
- `large`: tests pass AND final review says `readyToMoveOn`

**How cross-stage data flows**: Each stage reads structured output from previous stages via Smithers' context API. The implement stage also receives dependency context — for units with deps, it gets the `whatWasDone`, `filesCreated`, and `filesModified` from all completed dependency implementations.

**Feedback loops**: When reviews reject, or when a unit is evicted from the merge queue, the Ralph loop re-renders and the unit re-enters as Active. The implement stage receives review feedback and/or eviction context, allowing it to address specific issues rather than starting blind. Research and plan outputs are cached and not re-run.

---

## 3. Merge Queue

At the end of each Ralph iteration, after all Active units have run their quality pipelines, a single merge queue task processes all freshly quality-complete units. The merge queue is a single agent (Claude Opus) that handles all ready units together.

**Why an agent-driven merge queue**: Rebasing, conflict resolution, and test verification require judgment calls — is this conflict trivially resolvable (a lockfile regeneration) or does it need a full re-implementation? An agent can make that call. A script cannot.

**Why one merge queue per iteration (not per layer)**: Since the Ralph loop uses dynamic dep-based scheduling instead of fixed layers, there are no layer boundaries. All quality-complete units — regardless of their position in the dependency graph — enter the same merge queue at the end of each iteration. Units with file overlaps are landed sequentially within that queue.

**How it works**:

1. Collect all quality-complete units that haven't landed yet as merge tickets.
2. For each ticket, the agent switches to its worktree and rebases onto current main: `jj rebase -b bookmark("unit/{id}") -d main`
3. If the rebase has **conflicts**: capture the full conflict context (which files, what changed on main since the branch point) and mark the unit as **evicted**. Do not attempt resolution of non-trivial conflicts.
4. If the rebase is **clean**: run the full test suite in the rebased state.
   - Tests fail → **evict** with the test output
   - Tests pass → fast-forward main to the unit tip (`jj bookmark set main -r bookmark("unit/{id}")`), push, mark as **landed**
5. Clean up landed units: delete the bookmark, close the workspace.

**File overlap intelligence**: The merge queue prompt includes an analysis of which ready units touch the same files. When overlaps exist, non-overlapping units land first (no conflict risk). Overlapping units land one-by-one, rebasing each onto the updated main before attempting the next.

**Push failure handling**: If `jj git push` fails (e.g., remote updated by another process), the agent fetches, re-rebases, and retries up to 3 times before evicting.

**When no units are quality-complete**: The merge queue emits a structured no-op output (`status: "waiting"`) instead of returning null. This ensures the iteration is visible in the database and prevents silent advancement.

---

## 4. Eviction & Recovery

When a unit is evicted from the merge queue, it doesn't die — it re-enters the pipeline on the next Ralph iteration with full context about what went wrong.

**What gets captured on eviction**:
- The reason (conflict or test failure)
- Detailed context: conflicting files, the diff that conflicted, what landed on main since the branch point, or the full failing test output

**How it feeds back**: On the next Ralph iteration, the evicted unit's state is Active (its deps are still Done, and it hasn't landed). The eviction context is injected into the implement prompt:

```
## MERGE CONFLICT — RESOLVE BEFORE NEXT LANDING

Your previous implementation conflicted with another unit that landed first.
Restructure your changes to avoid the conflicting files/lines described below.

{full eviction context}
```

The implementer sees exactly what conflicted and what changed on main, so it can restructure its approach rather than blindly retry. The same worktree is reused (incremental changes), preserving partial progress.

**The Ralph loop**: The `<Ralph>` component re-renders until all units are Done (landed) or `MAX_PASSES` is exhausted. On each iteration:
- **Done** units are skipped entirely
- **NotReady** units are skipped (deps not yet landed) — they automatically become Active once their deps land in a future iteration
- **Active** units run their quality pipeline with any accumulated feedback
- The merge queue processes all freshly quality-complete units

**Why MAX_PASSES = 9**: The shared iteration budget covers both quality retries (review rejection → re-implement) and landing retries (merge eviction → re-implement → re-land). Nine iterations provides roughly 3 quality attempts × 3 landing attempts worth of headroom. Per-unit skip logic conserves the budget: Done and quality-passed units don't consume iterations, so in practice only actively-working units draw from the pool. If a unit exhausts the budget, the entire workflow stops — no downstream units run for failed dependencies.

**Completion report**: After the Ralph loop terminates, a final task summarizes: total units, units landed, units failed (with last stage reached and failure reason), passes used, and actionable next steps.
