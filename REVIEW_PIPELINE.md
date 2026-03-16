# Review Discovery Pipeline

`improvinho` is the review preset for `super-ralph-lite`.

It is intentionally small:

1. build bounded local review slices from explicit paths
2. run three discovery lenses in parallel per review scope
3. run one scoped cross-cutting pass after the local slices
4. filter and dedupe findings in code
5. persist findings in SQLite
6. project one `.tickets/summary.md` file

There is no multi-pass Ralph loop, no candidate entity, and no separate audit agent.

For broader repo concepts, see [CONCEPTS.md](CONCEPTS.md).

---

## Overview

```text
review instruction + explicit paths
  -> build review-plan.json
  -> run local slices in parallel
  -> inside each scope, run three discovery lenses in parallel
  -> run one cross-cutting scope with the same three lenses
  -> confirm/reject findings in code
  -> project .tickets/summary.md
```

The review plan contains:

- local slices: non-overlapping files or directories
- optional cross-cutting slice: one bounded pass across the selected area

---

## Stages

### 1. Discovery

Each review scope is handled by three parallel discovery lenses:

- `refactor-hunter`
- `type-system-purist`
- `app-logic-architecture`

Each lens returns findings directly, not candidates.

Each finding must include:

- `kind`
- `priority`
- `confidence`
- `summary`
- `evidence`
- `primaryFile`
- `lineRefs`
- `symbol`
- `pattern`
- `suggestedDiff`

Optional:

- `acceptIf`
- `dismissIf`
- `lens` is tracked at the task/output level so merged findings retain their source provenance

### 2. Validation Filter

This stage is pure code.

It:

- rejects low-confidence findings
- rejects findings missing summary, evidence, or file refs
- computes dedupe keys as `lens:kind:file:symbol:pattern`
- deduplicates collisions by preferring stronger confidence and priority
- emits one canonical `finding` entity with status `confirmed` or `rejected`

### 3. Materialization

Confirmed findings are persisted per scope. After all scope jobs finish, a single LLM-free merge/projection step:

- reads the persisted `finding` outputs
- merges overlapping findings across lenses and scopes deterministically
- writes `.tickets/summary.md` once

No scope pipeline writes human-facing ticket files directly.

---

## Data Model

The canonical entity is `finding`.

```ts
{
  id: string
  lens: "refactor-hunter" | "type-system-purist" | "app-logic-architecture"
  status: "draft" | "confirmed" | "projected" | "rejected"
  dedupeKey: string
  kind: "bug" | "security" | "simplification" | "architecture" | "test-gap"
  priority: "critical" | "high" | "medium" | "low"
  confidence: "high" | "medium" | "low"
  summary: string
  evidence: string
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

The `discovery_result` output exists only to persist the raw discoverer output before filtering.
The final summary is built from merged `finding` rows, not from per-scope file writes.

---

## Execution Shape

The workflow is coverage-based:

- all local slices run once
- the cross-cutting slice runs once
- the workflow ends

If the result quality is weak, improve prompts or scope. Do not add more passes.

---

## Projection

The final summary groups merged findings by priority and gives each one a display id:

```md
# Improvinho Review - 2026-03-16

## Critical (1)
### IMP-0001 - ...
...
```

Each entry includes:

- priority and confidence
- supporting lenses
- supporting scopes
- file refs
- evidence
- optional suggested diff

There is no per-ticket directory tree.

---

## Agent Use

`improvinho` currently uses three lens-specific discoverers:

- `refactor-hunter` via Codex
- `type-system-purist` via Claude
- `app-logic-architecture` via Codex

The old discoverer/auditor split was removed because it was compensating for poor discovery prompts with a second LLM stage. The current design expects each lens to meet the evidence bar directly, then lets code perform the lightweight filtering and dedupe work.
