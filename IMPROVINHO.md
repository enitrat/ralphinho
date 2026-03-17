# Improvinho

> Multi-lens code review pipeline. Runs three specialized AI agents over bounded code slices, validates findings deterministically, and produces a single triageable summary.

For shared infrastructure (Smithers engine, agent system), see [CONCEPTS.md](CONCEPTS.md).

---

## What Improvinho Does

You point it at code paths and describe what to look for. It gives you a prioritized, evidence-backed list of findings in `.tickets/summary.md`.

The workflow has three stages:

1. **Discovery** — Three parallel AI agents review each code slice through different lenses (refactoring, type safety, architecture).
2. **Validation** — Pure code (no second LLM call) rejects low-quality findings and deduplicates collisions.
3. **Materialization** — Confirmed findings merge across slices and lenses into a single summary file.

Improvinho does not implement fixes. It produces review artifacts for human triage.

---

## Why a Separate Workflow

Ralphinho assumes implementation units, code changes, testing, review-fix loops, and a merge queue. Improvinho assumes review scopes, findings, and human triage. Those are different execution models. Reusing infrastructure is fine; forcing them into one loop is not.

---

## Quick Start

```bash
# Initialize a review
ralphinho init review "Review for bugs, security issues, and simplification opportunities" \
  --paths src/api/auth src/lib/session.ts

# Execute
ralphinho run

# Read findings
cat .tickets/summary.md
```

---

## Pipeline Shape

```
  Explicit paths                Three lenses per slice
  from --paths                  run in parallel
       |                              |
       v                              v
+-------------+    +--------------------------------------+
| Review Plan |    | Discovery (per slice)                |
| (no LLM)   |--->|   refactor-hunter      [Codex]       |
|             |    |   type-system-purist   [Sonnet]      |
|             |    |   app-logic-arch       [Codex]       |
+-------------+    +------------------+-------------------+
                                      |
                                      v
                   +--------------------------------------+
                   | Validation Filter (pure code)        |
                   |   reject low-confidence              |
                   |   reject empty evidence              |
                   |   deduplicate by key                 |
                   +------------------+-------------------+
                                      |
                                      v
                   +--------------------------------------+
                   | Materialization                      |
                   |   merge across lenses and scopes     |
                   |   promote priority and kind          |
                   |   write .tickets/summary.md          |
                   +--------------------------------------+
```

### Execution Order

1. All **local slices** run in parallel (up to `maxConcurrency`).
2. After all local slices complete, one **cross-cutting slice** runs sequentially.
3. A deterministic **merge step** combines findings from all slices.
4. A **completion report** summarizes the run.

The cross-cutting slice depends on local slice outputs — it runs after them, not alongside them.

---

## Review Scopes

The repo is reviewed through explicit, bounded scopes derived from `--paths`.

### Local Scopes

Each path becomes one scope. Good scopes are concrete:

| Good | Bad |
|------|-----|
| `src/components/xyz/` | `src/` (too broad) |
| `src/lib/security/token.ts` | `architecture` (not a path) |
| `src/api/users/` | `general cleanup` (not a path) |

### Cross-Cutting Scope

When more than one path is provided, Improvinho adds a virtual cross-cutting scope that spans all paths. This scope catches:

- Duplication across modules
- Inconsistent abstractions
- Architectural boundary problems
- Repeated test gaps or error-handling mismatches

It is still bounded by the explicit paths selected for the run.

### Risk Inference

Each scope receives a risk level (`high`, `medium`, `low`) computed deterministically at plan time:

| Risk | Criteria |
|------|----------|
| High | Path matches sensitive keywords (auth, crypto, payment, security) or directory matches api/server/db patterns, or file exceeds 600 lines |
| Medium | File between 250-600 lines, or server-like directory patterns |
| Low | Everything else |

Risk influences how the agent prioritizes its review effort within a scope.

---

## Discovery Lenses

Three agents review each scope in parallel, each with a different focus:

| Lens | Default Agent | Focus |
|------|--------------|-------|
| `refactor-hunter` | Codex (gpt-5.4) | Duplication, dead code, unnecessary abstraction, parameter sprawl, deletion opportunities |
| `type-system-purist` | Claude Sonnet | Runtime guards for impossible states, stringly-typed logic, tests that verify types instead of behavior |
| `app-logic-architecture` | Codex (gpt-5.4) | Logic layering, state ownership, cross-module coupling, leaky abstractions |

You can override all lenses to a single agent with `--agent sonnet`, `--agent opus`, or `--agent codex`.

Each lens has a mission statement and checklist that the agent receives in its prompt, ensuring focused, non-overlapping discovery.

---

## Validation Filter

After discovery, a pure-code filter (no LLM call) processes raw findings:

### Rejection Rules

A finding is rejected if:
- Confidence is `low`
- Summary, evidence, or `primaryFile` is empty
- `lineRefs` is empty (no concrete location)

### Deduplication

Within each slice, findings are keyed by:

```
lens:kind:primaryFile:symbol:pattern
```

When duplicates exist, the finding with higher confidence wins. Ties break on higher priority. The `symbol` defaults to `module` when no specific symbol is identified.

---

## Cross-Slice Merge

After all slices complete, confirmed findings merge across lenses and scopes using a **lens-agnostic** merge key:

```
primaryFile:symbol:pattern
```

This means the same underlying issue discovered by different lenses or in different scopes (local vs cross-cutting) collapses into a single finding.

### Merge Behavior

| Aspect | Rule |
|--------|------|
| Canonical finding | Highest confidence, then priority, then preference for "slice" mode over "cross-cutting" |
| Priority | Promoted to the highest across the group |
| Confidence | Promoted to the highest across the group |
| Kind | Promoted to the most severe: `security > bug > architecture > test-gap > simplification` |
| Support count | Number of independent lens/scope combinations that produced the same finding |

A finding with `supportCount: 3` was independently discovered by three different agents — stronger signal than a single-lens finding.

---

## Finding Model

Every finding follows one canonical shape:

```ts
{
  id: string                    // display: IMP-0001, IMP-0002, ...
  status: "draft" | "confirmed" | "projected" | "rejected"
  dedupeKey: string
  lens: "refactor-hunter" | "type-system-purist" | "app-logic-architecture"
  kind: "bug" | "security" | "simplification" | "architecture" | "test-gap"
  priority: "critical" | "high" | "medium" | "low"
  confidence: "high" | "medium" | "low"
  summary: string
  evidence: string              // code snippet, trace, or logical argument
  primaryFile: string
  lineRefs: string[]
  symbol: string | null
  pattern: string
  suggestedDiff: string | null
  rejectionReason: string | null
  scopeId: string
  scopeLabel: string
  discoveredAt: string
}
```

### Evidence Bar

Every finding requires exactly three things:

1. A one-sentence summary
2. File references with line numbers
3. One concrete proof (code snippet, trace, or direct logical argument)

Optional triage hints (`acceptIf`, `dismissIf`, `suggestedDiff`) are allowed but not mandatory.

---

## Output

The workflow produces one file:

```
.tickets/summary.md
```

Findings are grouped by priority, highest first:

```md
# Improvinho Review — 2026-03-17

## Critical (1)
### IMP-0003 — SQL injection in user search
**Priority:** critical | **Confidence:** high | **Lenses:** refactor-hunter, type-system-purist
**File:** src/api/search.ts:42-48
**Evidence:** User input is interpolated directly into the query string...

## High (2)
### IMP-0001 — Null session in login handler
...
```

Each finding includes title, priority, confidence, contributing lenses, file refs, evidence, and optional suggested diff.

No `index.json`. No per-ticket folder tree. If a finding matters long-term, move it into your real issue tracker — or use the [Linear integration](README.md#linear-integration) to push findings automatically.

---

## Incremental Re-Runs

Discovery tasks use **input signature caching**. The cache key is a SHA-1 of (instruction, sliceId, mode, lens, path, inferredPaths). If you re-run the same review without changing paths or instruction, completed discovery tasks are skipped automatically.

Change a path or the review instruction, and the affected tasks re-run while cached results are preserved.

---

## Stop Condition

Coverage-based, not output-based:

- Each local scope runs once
- The cross-cutting scope runs once
- Then the workflow ends

If results are weak, the fix is better prompts or better scoping — not more passes.

---

## Non-Goals

- Do not auto-implement fixes (review-only by default)
- Do not create a fake issue tracker in the filesystem
- Do not run multi-pass loops over the same slice
- Do not emit vague cleanup advice with no proof
- Do not depend on a second model call to decide whether the first model was useful
