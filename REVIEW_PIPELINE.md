# Review Discovery Pipeline

A multi-agent code review pipeline. Takes a review instruction (natural language) and a set of code paths, decomposes them into review slices, runs each slice through a discovery → audit → ticket pipeline, and produces actionable review tickets for human triage.

For infrastructure details (Smithers engine, agent system), see [CONCEPTS.md](CONCEPTS.md).

---

## 1. Overview

### Setup

```
                   ┌───────────────────────┐
                   │  Review Instruction   │
                   │  + Code Paths         │
                   └───────────┬───────────┘
                               │
            ┌──────────────────▼──────────────────┐
            │  improvinho init review-discovery   │
            │                                     │
            │  1. Scan repo (build/test commands) │
            │  2. Detect agents on PATH           │
            │  3. AI decomposes paths into review │
            │     slices with focus areas + risk  │
            └──────────────────┬──────────────────┘
                               │
                     ┌─────────▼──────────┐
                     │  review-plan.json  │
                     │                    │
                     │  slices:           │
                     │   ├─ id, path      │
                     │   ├─ entryType     │
                     │   ├─ focusAreas    │
                     │   ├─ rationale     │
                     │   ├─ risk level    │
                     │   └─ inferredPaths │
                     └─────────┬──────────┘
                               │
                        human reviews
                         and edits
                               │
                     ┌─────────▼──────────┐
                     │  improvinho run    │
                     │                    │
                     │  Launches the      │
                     │  built-in Smithers │
                     │  review preset     │
                     └────────────────────┘
```

### Main Loop

A single `<Ralph>` loop drives the review. On each iteration, every slice runs its discovery → audit pipeline in parallel. Tickets are materialized and tracked. The loop terminates when all slices are complete, `MAX_PASSES` is reached, or two consecutive passes produce zero new confirmed tickets.

```
┌─ Ralph Loop (up to MAX_PASSES = 3) ──────────────────────────────────────┐
│                                                                           │
│  ┌─ Phase 1: Slice Pipelines (parallel, maxConcurrency) ──────────────┐ │
│  │                                                                      │ │
│  │  ┌── Slice A ─────────────────┐   ┌── Slice B ─────────────────┐   │ │
│  │  │  Discover → Audit → Ticket │   │  Discover → Audit → Ticket │   │ │
│  │  └────────────────────────────┘   └────────────────────────────┘   │ │
│  │                                                                      │ │
│  │  ┌── Slice C (complete) ──────┐   ┌── Slice D ─────────────────┐   │ │
│  │  │        SKIPPED             │   │  Discover → Audit → Ticket │   │ │
│  │  └────────────────────────────┘   └────────────────────────────┘   │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                                                           │
│  ┌─ Phase 2: Ticket Write ─────────────────────────────────────────────┐ │
│  │  Aggregate confirmed tickets across all slices this pass.           │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                                                           │
│  ┌─ Phase 3: Pass Tracker ─────────────────────────────────────────────┐ │
│  │  Record iteration state: slices run, slices complete,               │ │
│  │  new confirmed count, zero-new-pass counter.                        │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                                                           │
│  Termination conditions:                                                  │
│    - All slices complete                                                  │
│    - MAX_PASSES reached                                                   │
│    - 2 consecutive passes with zero new confirmed tickets                │
└───────────────────────────────────────────────────────────────────────────┘
```

### Slice States

Each slice is in exactly one state at any point. State is derived from context outputs.

```
              ┌─────────────────────┐
              │      PENDING        │ ← initial state
              │  (no ticket output) │
              └──────────┬──────────┘
                         │ pipeline runs
                         ▼
              ┌─────────────────────┐
              │     COMPLETE        │ ← ticket output exists
              │  (skip on future    │
              │   iterations)       │
              └─────────────────────┘
```

**State derivation:**
- **Complete**: a `review_ticket` output exists for this slice's ticket-materialize node
- **Pending**: no ticket output yet — run the discovery → audit → ticket pipeline

---

## 2. Per-Slice Review Pipeline (detailed)

Each slice runs through three stages in sequence. The pipeline uses separate agents for discovery and auditing — the auditor never discovered the issues it's evaluating, eliminating confirmation bias.

```
         ┌────────────────────────────────────────────────────────────┐
         │  Per-Slice Pipeline                                        │
         │                                                            │
         │  ┌──────────────────────────────────────────────────────┐ │
         │  │  DISCOVER                       [Codex gpt-5.4 medium] │ │
         │  │  Read the code slice. Identify candidate issues       │ │
         │  │  based on the review instruction and focus areas.     │ │
         │  │  Produce a list of candidates, each with:            │ │
         │  │    - kind (bug, security, simplification,            │ │
         │  │      architecture, test-gap)                         │ │
         │  │    - priority (critical / high / medium / low)       │ │
         │  │    - confidence, summary, line refs                  │ │
         │  │                                                      │ │
         │  │  Skipped if input signature matches previous run     │ │
         │  │  (same instruction + slice + pass → same discovery). │ │
         │  │                                                      │ │
         │  │  ── retries: 2  ── timeout: 20 min ──               │ │
         │  └─────────────────────────┬────────────────────────────┘ │
         │                            │                              │
         │                            ▼                              │
         │  ┌──────────────────────────────────────────────────────┐ │
         │  │  AUDIT                                        [Opus] │ │
         │  │  Re-examine each candidate with strict evidence      │ │
         │  │  requirements. For each candidate, either:           │ │
         │  │    - CONFIRM: provide evidence, repro/trace,         │ │
         │  │      triage guidance, accept/dismiss criteria        │ │
         │  │    - REJECT: provide rejection reason                │ │
         │  │                                                      │ │
         │  │  The auditor did not discover the issues — fresh     │ │
         │  │  eyes eliminate author bias.                          │ │
         │  │                                                      │ │
         │  │  ── retries: 2  ── timeout: 20 min ──               │ │
         │  └─────────────────────────┬────────────────────────────┘ │
         │                            │                              │
         │                            ▼                              │
         │  ┌──────────────────────────────────────────────────────┐ │
         │  │  TICKET MATERIALIZE                       [computed] │ │
         │  │  Filter audited issues to confirmed only.            │ │
         │  │  Deduplicate by dedupeKey. Attach slice area.        │ │
         │  │  Mark all tickets as requiresHumanReview.            │ │
         │  │                                                      │ │
         │  │  ── no agent, pure computation ──                    │ │
         │  └──────────────────────────────────────────────────────┘ │
         └────────────────────────────────────────────────────────────┘
```

### Agent Roles

| Stage | Agent | Model | Role |
|-------|-------|-------|------|
| Discover | Codex | gpt-5.4-codex (medium reasoning) | Find candidate issues in a bounded code slice |
| Audit | Claude | claude-opus-4-6 | Confirm or reject findings with strict evidence |

**Why Codex for discovery**: Discovery is a breadth task — scan a code slice and surface candidates quickly. Codex with medium reasoning effort balances speed and cost against thoroughness. The audit stage (Opus) provides the depth and rigor needed to confirm or reject each candidate.

Both agents receive a read-only workspace policy — they do not modify code, only analyze it.

### Input Signature & Skip Logic

Each discovery task computes a SHA-1 input signature from `(instruction, sliceId, path, passNumber)`. If a previous discovery output has the same signature, the task is skipped. This prevents redundant re-discovery when the Ralph loop re-renders without changes to the review instruction.

---

## 3. Data Flow

### Schemas

The pipeline produces six output types, persisted to SQLite via Smithers:

| Output | Description |
|--------|-------------|
| `slice_plan` | Initial plan summary: total slices and their IDs |
| `candidate_issue` | Discovery output: candidate issues per slice per pass |
| `audited_issue` | Audit output: confirmed/rejected issues with evidence |
| `review_ticket` | Materialized tickets per slice (confirmed issues only) |
| `ticket_write` | Per-pass aggregation: total and new ticket counts |
| `pass_tracker` | Iteration state: passes run, slices complete, zero-new counter |
| `completion_report` | Final summary with next steps |

### Ticket Structure

Each confirmed review ticket contains:

```
ReviewTicket {
  dedupeKey       — stable key for deduplication across passes
  kind            — bug | security | simplification | architecture | test-gap
  priority        — critical | high | medium | low
  confidence      — high | medium | low
  summary         — one-line description
  whyItMatters    — impact explanation
  evidence        — concrete evidence lines
  lineRefs        — file:line references
  reproOrTrace    — reproduction steps or execution trace (nullable)
  alternatives    — suggested alternative approaches (nullable)
  quickTriage     — fast human decision guidance
  acceptIf        — conditions under which to accept
  dismissIf       — conditions under which to dismiss
  primaryFile     — main file affected
  area            — slice path (directory or file)
  requiresHumanReview — always true (human-in-the-loop)
}
```

---

## 4. Configuration

The review preset loads from `.ralphinho/config.json` with mode `review-discovery`:

```json
{
  "mode": "review-discovery",
  "repoRoot": "/path/to/repo",
  "agents": { "claude": true, "codex": true, "gh": true },
  "maxConcurrency": 4,
  "reviewInstruction": "Find security issues and dead code",
  "reviewInstructionSource": "./review-prompt.md",
  "reviewPaths": ["src/", "lib/"]
}
```

| Field | Description |
|-------|-------------|
| `reviewInstruction` | Natural language review directive |
| `reviewInstructionSource` | Optional file path the instruction was loaded from |
| `reviewPaths` | Code paths to review |
| `maxConcurrency` | Max slices reviewed in parallel |
| `agents` | Which AI agents are available on PATH |

---

## 5. Termination & Completion

The Ralph loop exits when any of these conditions is met:

1. **All slices complete** — every slice has a `review_ticket` output
2. **MAX_PASSES reached** (default: 3)
3. **Two consecutive zero-new passes** — the pipeline is no longer finding novel issues

After termination, a completion report summarizes:
- Total slices and how many completed
- Total confirmed tickets and how many require human review
- Passes used
- Actionable next steps (review `.tickets/` output, accept/reject projected tickets)

---

## 6. Key Design Decisions

**Why discovery + audit (two stages, not one)**: A single agent that both discovers and confirms issues suffers from author bias — it tends to confirm its own findings. Splitting into discoverer and auditor forces independent verification. The auditor sees only the candidate list, not the discoverer's reasoning process.

**Why review-only (no fixes)**: The workspace policy explicitly prohibits code changes. Review pipelines that also fix issues conflate two concerns: finding problems and solving them. Keeping review read-only produces cleaner tickets and avoids half-applied fixes that create more issues than they solve.

**Why MAX_PASSES = 3**: Review is inherently convergent — most issues are found on the first pass. Subsequent passes handle edge cases and slices that timed out. Three passes balances thoroughness against cost. The zero-new-pass early exit ensures the pipeline doesn't burn tokens when it's found everything.

**Why human-in-the-loop**: All tickets are marked `requiresHumanReview: true`. AI review is good at surfacing candidates but has false positives. Human triage is the quality gate — accept or dismiss each ticket before any remediation begins.
