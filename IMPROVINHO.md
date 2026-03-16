# Improvinho

> Review-driven workflow for simplification, bug discovery, architectural critique, and fast human triage.

`ralphinho` is built for spec-driven implementation work. `improvinho` is the sibling preset for review-driven discovery work.

Its job is simple:

- review bounded code slices
- produce evidence-backed findings
- filter and dedupe them in code
- persist them in the workflow DB
- project a single human-readable summary file

It does not implement fixes by default.

---

## Goal

Given a review instruction such as:

> Review these components and identify bugs, security issues, code smells, architectural problems, and simplification opportunities.

`improvinho` should:

1. create bounded local review slices from explicit repo paths
2. run three parallel discovery lenses per review scope
3. run one scoped cross-cutting pass after the local slices complete
4. filter, dedupe, and classify findings without a second LLM audit stage
5. persist findings canonically in the workflow DB
6. write one `.tickets/summary.md` file for human triage

---

## Non-Goals

- Do not auto-implement fixes in v1.
- Do not create a fake issue tracker in the filesystem.
- Do not run multi-pass loops over the same slice.
- Do not emit vague cleanup advice with no proof.
- Do not depend on a second model call to decide whether the first model was useful.

---

## Core Product

An `improvinho` run produces:

- Smithers runtime state in SQLite
- one canonical `finding` record shape with status transitions
- one projected `.tickets/summary.md` file for humans

The DB is the source of truth. The summary is a regenerated projection.

---

## Why This Stays A Separate Preset

`scheduled-work` assumes implementation units, code changes, testing, review-fix loops, and merge queue handling.

`improvinho` assumes review scopes, findings, and human triage.

Those are different execution models. Reusing utilities is fine; forcing them into one loop is not.

---

## Workflow

### Entry

```bash
ralphinho init review "Review components XYZ for bugs, security issues, simplification opportunities, and architectural problems" \
  --paths src/components/xyz src/lib/foo
```

This creates:

- `.ralphinho/config.json` with `mode: "review-discovery"`
- `.ralphinho/review-plan.json` with the bounded review scopes

Then:

```bash
ralphinho run
```

loads the `improvinho` preset and executes the review workflow.

---

## Pipeline Shape

`improvinho` is a 3-stage pipeline:

1. **Discovery**
   Three agents per review scope produce findings directly, each with a different lens:
   - `refactor-hunter`
   - `type-system-purist`
   - `app-logic-architecture`

   Each finding must include:
   - summary
   - primary file and line refs
   - one concrete piece of evidence
   - symbol/pattern hints for dedupe when available

2. **Validation filter**
   Pure code, not another LLM call.
   It:
   - rejects low-confidence or weakly evidenced findings
   - computes stable per-lens dedupe keys
   - deduplicates collisions within each slice/lens output
   - marks findings as `confirmed` or `rejected`

3. **Materialization**
   Confirmed findings are persisted per slice.
   After all slices complete, one LLM-free merge/projection step reads the persisted findings, merges them deterministically across lenses and scopes, and writes a single summary file once.

No candidate stage. No audit stage. No repeated passes.

---

## Review Scope Model

The repo is reviewed through explicit, bounded scopes.

### Local scopes

Local scopes are non-overlapping files or directories derived from the provided paths.

Good scopes:

- `src/components/xyz/`
- `src/lib/security/token.ts`
- `src/api/users/`

Bad scopes:

- `src/`
- `architecture`
- `general cleanup`

### Cross-cutting scope

After local scopes complete, `improvinho` runs one scoped cross-cutting pass over the selected area.

This pass exists to catch:

- duplication across modules
- inconsistent abstractions
- architectural boundary problems
- repeated test gaps or error-handling mismatches

It must still be bounded by the explicit paths selected for the run.

---

## Stop Condition

Coverage-based, not output-based:

- each local scope runs once
- the cross-cutting scope runs once
- then the workflow ends

If the results are weak, the fix is better prompts or better scoping, not more passes.

---

## Canonical Finding Model

`improvinho` uses one entity with a status field:

```ts
{
  id: string
  status: "draft" | "confirmed" | "projected" | "rejected"
  dedupeKey: string
  lens: "refactor-hunter" | "type-system-purist" | "app-logic-architecture"
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

The canonical dedupe key is:

```text
lens:kind:file:symbol:pattern
```

When no symbol exists, the fallback symbol is `module`.

The final summary projection uses a separate merge key that ignores lens identity so the same underlying issue can collapse across multiple lenses and across local vs cross-cutting scopes.

---

## Evidence Bar

Every finding must include only three required things:

1. a one-sentence summary
2. file references
3. one concrete proof

That proof can be:

- a code snippet
- a trace
- a direct logical argument based on the code

Optional fast-triage hints such as `acceptIf`, `dismissIf`, or `suggestedDiff` are allowed, but they are not mandatory.

---

## Projection Format

The workflow projects one file:

```text
.tickets/
  summary.md
```

Example:

```md
# Improvinho Review — 2026-03-16

## Critical (1)
### IMP-0003 — SQL injection in user search
...

## High (2)
### IMP-0001 — Null session in login handler
...
```

Each finding in the summary includes:

- title
- priority and confidence
- file refs
- evidence
- optional suggested diff

No `index.json`. No per-ticket folder tree. If a finding matters long-term, move it into the real issue tracker.

---

## Trivial Findings

Small mechanical issues may carry an inline `suggestedDiff` block.

Example:

```md
### IMP-0012 — Unused import in auth handler
**File:** src/auth/handler.ts:3
**Evidence:** `legacy` is imported but never referenced in the file.

**Suggested fix:**
```diff
- import { legacy } from "./compat"
```
```

This is still review-only. The workflow does not apply the diff automatically.

---

## Summary

The intended shape of `improvinho` is:

- separate preset
- one pass over local scopes
- one bounded cross-cutting pass
- three parallel discovery lenses per scope
- discover → filter → materialize
- one canonical finding model
- one summary file for humans

Anything more complicated than that needs clear evidence that the extra machinery is buying signal rather than just more tokens and more state.
