# Ralphinho

> Spec-driven, multi-agent development pipeline. Takes an RFC, decomposes it into work units with a dependency DAG, runs each unit through a quality pipeline of specialized AI agents, and lands them onto main.

For shared infrastructure (Smithers engine, jj VCS, agent system, worktree isolation), see [CONCEPTS.md](CONCEPTS.md).

---

## What Ralphinho Does

You give it an RFC. It gives you implemented, reviewed, tested code landed on your main branch.

The workflow has two phases:

1. **Init** — An AI decomposes your RFC into work units with explicit dependencies. You review and edit the plan.
2. **Run** — The Smithers engine executes each unit through a quality pipeline (research, plan, implement, test, review), then lands completed units onto main via a merge queue.

Units run in parallel when their dependencies allow it. Failed units retry with full context about what went wrong.

---

## Setup

```
                   +---------------+
                   |  RFC / PRD    |
                   +-------+-------+
                           |
            +--------------v--------------+
            |  ralphinho init ./rfc.md    |
            |                             |
            |  1. Scan repo (build/test   |
            |     commands, pkg manager)  |
            |  2. Detect agents on PATH   |
            |  3. AI decomposes RFC into  |
            |     work units + DAG        |
            +--------------+--------------+
                           |
                 +---------v---------+
                 |  work-plan.json   |
                 |                   |
                 |  units:           |
                 |   - id, tier      |
                 |   - description   |
                 |   - acceptance    |
                 |   - deps: [...]   |
                 +---------+---------+
                           |
                    human reviews
                     and edits
                           |
                 +---------v---------+
                 |  ralphinho run    |
                 +-------------------+
```

### RFC Decomposition

`ralphinho init` sends your RFC to an AI (Claude Sonnet) that produces a work plan. The decomposition follows these rules:

| Rule | Rationale |
|------|-----------|
| Prefer fewer, cohesive units | Each unit adds pipeline overhead and merge risk |
| Minimize cross-unit file overlap | Two units modifying the same file will conflict at merge time |
| Keep tests with implementation | Never split "implement X" and "test X" into separate units |
| Tiers are binary: `small` or `large` | `small` = focused changes, `large` = multi-file or architectural |

The DAG encodes real code dependencies (unit B imports a type that unit A creates). It is validated for missing references and cycles.

**Human review is the highest-leverage intervention point.** You can adjust tiers, merge overlapping units, remove unnecessary units, or tighten acceptance criteria before any agent touches code.

---

## The Ralph Loop

A single `<Ralph>` loop drives execution. Each iteration classifies every unit, runs quality pipelines for active units, then lands completed ones.

```
+-- Ralph Loop (up to MAX_PASSES = 9) ------------------------------------+
|                                                                          |
|  Classify each unit:                                                     |
|    Done     = landed on main            -> skip entirely                 |
|    NotReady = deps not all Done         -> skip (wait for deps)          |
|    Active   = deps satisfied, not Done  -> run quality pipeline          |
|                                                                          |
|  +- Phase 1: Quality Pipelines (parallel, Active units only) ----------+|
|  |                                                                      ||
|  |  +-- Unit A (large, Active) ---+   +-- Unit B (small, NotReady) --+ ||
|  |  |                             |   |           SKIPPED             | ||
|  |  |  Research                   |   |   (dep A not yet Done)        | ||
|  |  |  Plan                       |   +-------------------------------+ ||
|  |  |  Implement                  |                                     ||
|  |  |  Test                       |   +-- Unit C (small, Active) -----+ ||
|  |  |  PRD + Code Review          |   |                               | ||
|  |  |  Review Fix                 |   |  Implement                    | ||
|  |  |  Final Review               |   |  Test                         | ||
|  |  |                             |   |  Code Review -> Review Fix    | ||
|  |  |                             |   |  Final Review                 | ||
|  |  +-----------------------------+   +-------------------------------+ ||
|  +----------------------------------------------------------------------+|
|                                                                          |
|  +- Phase 2: Landing ------------------------------------------------- +|
|  |  For each quality-complete unit:                                      |
|  |    rebase onto main -> run tests -> land or evict                     |
|  +----------------------------------------------------------------------+|
|                                                                          |
|  Done units skip. NotReady units re-check deps next iteration.           |
|  Evicted units re-enter as Active with conflict context.                 |
+--------------------------------------------------------------------------+
```

### Dynamic Dependency Scheduling

Units do not run in fixed layers. On each iteration, every unit's state is derived from the dependency graph and current landing state:

- **Done** — Landed on main. Skip entirely.
- **NotReady** — At least one dependency is not Done. Skip; re-check next iteration.
- **Active** — All deps Done (or no deps) and unit not landed. Run quality pipeline.

Independent units (no deps) are Active from iteration 1. A unit with deps becomes Active only when its specific dependencies land — not when an entire "layer" completes.

### Dependency Context

When a unit becomes Active, the implement stage receives summaries from all landed dependency units: `whatWasDone`, `filesCreated`, `filesModified`. The implementer knows what APIs and files its dependencies produced.

### Example

| Iteration | A | B (dep: A) | C | Landing |
|-----------|---|------------|---|---------|
| 1 | Pipeline passes | Skip (NotReady) | Pipeline passes | Land A, Land C: conflict |
| 2 | Skip (Done) | Pipeline passes | Pipeline (rebase fix) passes | Land B, Land C |
| 3 | All Done | | | |

---

## Quality Pipeline

Each unit runs through a tier-based pipeline inside its own worktree. Separate context windows for separate concerns — no single agent holds the entire problem.

### Stages by Tier

| Tier | Pipeline |
|------|----------|
| `small` | implement -> test -> code-review -> review-fix -> final-review |
| `large` | research -> plan -> implement -> test -> prd-review + code-review -> review-fix -> final-review |

### Agent Assignments

| Stage | Default Agent | Role |
|-------|--------------|------|
| Research | Claude Sonnet | Read RFC sections + codebase, produce context doc |
| Plan | Claude Opus | Design atomic implementation steps from context |
| Implement | Codex | Write code following the plan (TDD where applicable) |
| Test | Claude Sonnet | Run build + full test suite, fix compilation errors |
| PRD Review | Claude Sonnet | Verify implementation matches RFC and acceptance criteria |
| Code Review | Claude Opus | Check code quality, security, conventions, coverage |
| Review Fix | Codex | Address review issues in severity order |
| Final Review | Claude Opus | Quality gate: decide `readyToMoveOn` |

The reviewer never wrote the code it reviews. This eliminates author bias.

### Stage Caching

Research and Plan use **input signature caching** — if the inputs (RFC section, unit description, acceptance criteria) haven't changed since the last run, the stage is skipped. Implement, Test, and reviews always re-run.

### Review Fix Skip

When both PRD Review and Code Review approve, the Review Fix stage is skipped entirely.

### Detailed Pipeline Flow (large tier)

```
         +-- Per-Unit Pipeline (in worktree) --------------------------------+
         |                                                                    |
         |  RESEARCH  [Sonnet]                                                |
         |  Read RFC + codebase. Produce context doc with findings.           |
         |  -- large only, cached --                                          |
         |        |                                                           |
         |        v                                                           |
         |  PLAN  [Opus]                                                      |
         |  Design atomic implementation steps, identify files, plan tests.   |
         |  -- large only, cached --                                          |
         |        |                                                           |
         |        v                                                           |
         |  IMPLEMENT  [Codex]                                                |
         |  Write code. Receives: plan + dep context + review feedback        |
         |  + eviction context from prior iterations.                         |
         |  -- all tiers --                                                   |
         |        |                                                           |
         |        v                                                           |
         |  TEST  [Sonnet]                                                    |
         |  Run build + test suite. Report pass/fail. Fix if possible.        |
         |  -- all tiers --                                                   |
         |        |                                                           |
         |     +--+--+                                                        |
         |     |     |    (parallel)                                           |
         |     v     v                                                        |
         |  PRD REVIEW [Sonnet]     CODE REVIEW [Opus]                        |
         |  Match RFC spec?         Well-written? Secure?                     |
         |  -- large only --        -- all tiers --                           |
         |     |     |                                                        |
         |     +--+--+                                                        |
         |        |                                                           |
         |   both approved? --yes--> (skip review-fix)                        |
         |        | no                      |                                 |
         |        v                         |                                 |
         |  REVIEW FIX  [Codex]             |                                 |
         |  Address issues by severity.     |                                 |
         |  -- all tiers --                 |                                 |
         |        |<------------------------+                                 |
         |        v                                                           |
         |  FINAL REVIEW  [Opus]                                              |
         |  Quality gate. Checks acceptance criteria, tests, review           |
         |  severity. Decides readyToMoveOn. If false, reasoning feeds        |
         |  back to implement on the next Ralph iteration.                    |
         |  -- all tiers --                                                   |
         |        |                                                           |
         |        v                                                           |
         |  QUALITY-COMPLETE --> enters landing phase                         |
         +--------------------------------------------------------------------+
```

### Feedback Loops

On each Ralph iteration, accumulated feedback is injected into the Implement prompt:

| Source | What it contains |
|--------|-----------------|
| Final Review rejection | Reasoning for why the unit is not ready |
| PRD Review issues | Spec mismatches and missing acceptance criteria |
| Code Review issues | Quality, security, and convention problems |
| Failing test output | Test names, error messages, stack traces |
| Merge queue eviction | Conflict files, diffs, what landed on main since branch point |

Research and Plan outputs are cached and not re-run. The implementer iterates against stable context.

---

## Landing

After all Active units finish their quality pipelines, the landing phase processes all quality-complete units. Two modes are available:

| Mode | What happens | When to use |
|------|-------------|-------------|
| `merge` (default) | Agent rebases onto main, runs CI, fast-forwards main | Direct integration, no external review needed |
| `pr` | Agent pushes branch, creates GitHub PR via `gh pr create` | When human review of PRs is required |

### Merge Queue Flow

```
 unit/{id} branch
        |
        v
+------------------+    conflict    +------------------------+
|  Rebase onto     |-------------->|  EVICT                 |
|  main            |                |  (capture conflict ctx) |
+--------+---------+                +------------------------+
         | clean
         v
+------------------+    fail        +------------------------+
|  Run build +     |-------------->|  EVICT                 |
|  tests           |                |  (capture test output)  |
+--------+---------+                +------------------------+
         | pass
         v
+------------------+
|  Fast-forward    |
|  main, push,     |
|  delete bookmark |
+------------------+
```

**File overlap intelligence.** The merge queue analyzes which ready units touch the same files. Non-overlapping units land first. Overlapping units land sequentially, rebasing between each.

**Push failure recovery.** If `jj git push` fails (remote updated), the agent fetches, re-rebases, and retries up to 3 times before evicting.

### Decision Integrity

A unit must pass a **decision audit** to be merge-eligible:

- The final review must say `readyToMoveOn: true`
- If a prior iteration rejected the unit, the current approval must be backed by fresh substantive work (new implement output, review-fix, or passing tests)
- An approval that follows a rejection without fresh evidence is marked **invalidated** and the unit does not enter the merge queue

This prevents rubber-stamp approvals from landing broken code.

---

## Eviction and Recovery

When a unit is evicted from the merge queue, it re-enters as Active on the next Ralph iteration with full context about what went wrong.

**Captured on eviction:**
- Reason (conflict or test failure)
- Detailed context: conflicting files, the diff that conflicted, what landed on main since the branch point, or the full failing test output

**How it feeds back:** The eviction context is injected into the Implement prompt on the next iteration. The implementer sees exactly what conflicted and what changed on main, so it restructures its approach rather than blindly retrying. The same worktree is reused, preserving partial progress.

### Iteration Budget

`MAX_PASSES = 9` covers both quality retries (review rejection -> re-implement) and landing retries (merge eviction -> re-implement -> re-land). Done and quality-passed units do not consume iterations, so only actively-working units draw from the budget. If a unit exhausts the budget, the entire workflow stops.

### Completion Report

After the Ralph loop terminates, a final task summarizes: total units, units landed, units that failed (with last stage reached and failure reason), passes used, and actionable next steps. Units that landed but have invalidated decision audits are flagged separately.
