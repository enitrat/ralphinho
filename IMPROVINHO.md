# Improvinho

> Review-driven AI workflow for code simplification, bug discovery, architectural critique, and fast human triage.

`ralphinho` is currently optimized for spec-driven implementation work:

- read an RFC
- decompose it into work units
- implement units in parallel
- test, review, and land them

`improvinho` is a different preset.

Its output is not code changes by default. Its output is a reviewed, deduplicated, prioritized set of findings stored canonically in the workflow DB, with selected human-facing tickets projected into `.tickets/` for rapid review.

---

## Goal

Given a focused review instruction such as:

> Review components `XYZ` and highlight any bugs, security issues, code smells, or bad architectural decisions that could be simplified.

`improvinho` should:

1. scope the review to bounded slices of the codebase and specific things to focus on.
2. discover candidate issues in parallel
3. validate each candidate with concrete evidence
4. classify and prioritize the confirmed tickets
5. project human-reviewable tickets into `.tickets/`
6. avoid re-discovering the same issue repeatedly across passes

This is an auto-improvement workflow over the current codebase baseline.

---

## Non-Goals

- Do not auto-implement fixes in the first version.
- Do not merge directly to the base branch.
- Do not produce vague "cleanup" suggestions with no evidence.
- Do not run overlapping reviewers on the same area without deterministic dedupe.
- Do not force every finding into the same format; bug tickets and architecture tickets need different proof.

Implementation and remediation can be a later preset that consumes accepted tickets.

---

## Core Product

The core product of an `improvinho` run is:

- Smithers runtime state in SQLite for resumability, audit history, dedupe, and ticket lifecycle
- a human-facing `.tickets/` projection for findings that require quick review
- a compact summary for fast human triage

Suggested projection layout:

```text
.tickets/
  index.json
  summary.md
  open/
    critical/
    high/
    medium/
    low/
  accepted/
  archived/
```

The DB is the source of truth. The `.tickets/` directory is a user-facing projection layer that can be regenerated from DB state.

---

## Why This Must Be A Separate Preset

`scheduled-work` in this repo assumes:

- units are implementation tasks
- the quality pipeline leads to code changes
- the merge queue is part of the happy path

`improvinho` has a different execution model:

- units are review slices, not implementation tasks
- the main artifact is a ticket, not a diff
- the happy path ends with validated evidence and persisted DB records, plus optional projected review tickets
- merge queue is out of scope

This should therefore be a sibling preset, not a mutation of `scheduled-work`.

---

## High-Level Workflow

### Entry

Example:

```bash
ralphinho init review "Review components XYZ and identify bugs, security issues, code smells, and simplification opportunities" \
  --paths src/components/xyz src/lib/foo
```

This should create:

- `.ralphinho/config.json` with `mode: "review-discovery"`
- `.ralphinho/review-plan.json` with the review slices and scope metadata

Then:

```bash
ralphinho run
```

loads the `improvinho` preset and executes the review loop.

---

## Outer Ralph Loop

The outer loop should still use a Smithers `<Ralph>` component, but the loop unit is a bounded code slice.

Each pass:

1. selects the next review slices
2. discovers candidate issues in parallel
3. validates candidates with an evidence gate
4. deduplicates findings and materializes human-review tickets
5. tracks pass progress
6. exits when no new confirmed tickets are produced or all slices are exhausted or MAX_ITERATIONS is reached.

Suggested stop conditions:

- all review slices are complete
- or 2 consecutive passes produce zero new confirmed tickets
- or max passes reached

---

## Review Slice Model

The workflow should not review the repo as one giant blob.

It should operate on bounded, non-overlapping slices:

- explicit user-provided paths
- inferred related files around those paths
- optionally grouped by module or feature boundary

Good slices:

- `src/components/xyz/`
- `src/lib/security/token.ts`
- `src/api/users/`

Bad slices:

- `src/`
- `architecture`
- `general cleanup`

The Super Ralph rule applies here too:

> Every issue should be discoverable from exactly one review slice, with a predictable dedupe key.

Without that, the workflow will create duplicates across passes and reviewers.

---

## Phase Design

### Phase 1: Slice Planning

Input:

- user review instruction
- explicit paths or focus areas
- repo structure

Output:

- `review-plan.json`
- non-overlapping slices
- optional per-slice risk score

Planning heuristics:

- prioritize explicit user focus
- prioritize security-sensitive code
- prioritize complex files or folders
- prioritize heavily imported modules
- optionally prioritize weakly tested areas

### Phase 2: Candidate Discovery

One reviewer agent per slice scans for:

- bugs
- security issues
- simplification opportunities, removing code smells, enforcing best practices, etc.
- architectural problems
- test gaps

This phase should emit candidates, not final tickets.

Each candidate should include:

- `kind`
- `priority`
- `confidence`
- `summary`
- `dedupeKey`
- `primaryFile`
- `lineRefs`
- `whyItMayMatter`

### Phase 3: Evidence Audit

This is the main quality gate.

Every candidate must be either:

- confirmed and promotable to a ticket
- or rejected with a reason

The evidence requirements depend on the ticket kind.

### Phase 4: Ticket Materialization

Confirmed findings are:

- deduplicated
- normalized
- assigned stable IDs
- stored canonically in the DB
- projected into `.tickets/` only when they require human review
- indexed in `.tickets/index.json`

### Phase 5: Summary And Exit

At the end of each pass:

- update pass tracker
- update `.tickets/summary.md`
- decide whether another review pass is useful

---

## Ticket Kinds

Suggested first-version taxonomy:

- `bug`
- `security`
- `simplification`
- `architecture`
- `test-gap`

The taxonomy should stay small. If the system produces too many classes, triage gets slower.

---

## State Model

The workflow should distinguish between internal findings and user-facing review tickets.

Canonical DB entities:

- `candidate_issue`: raw discovery output
- `audited_issue`: validated or rejected finding with evidence
- `review_ticket`: confirmed finding that is eligible for human review

Projection rule:

- not every `audited_issue` becomes a projected file
- only `review_ticket` rows marked as requiring human review should be rendered into `.tickets/`
- rejected, duplicate, low-signal, and internal-only findings stay in the DB only

If `.tickets/` is deleted, it should be reconstructable from the DB.

---

## Evidence Contract By Ticket Kind

### Bug

A bug ticket must include one of:

- a minimal reproducible example
- or a precise execution trace showing how the bug can occur

Required:

- preconditions
- triggering path
- expected behavior
- actual behavior
- file and line references

### Security

A security ticket must include:

- threat description
- exploit or abuse path
- required attacker capability
- impact
- file and line references

Do not accept hand-wavy "this feels unsafe" findings.

### Simplification

A simplification ticket must include:

- what is unnecessarily complex
- why the current shape is costly
- at least two high-level alternatives

Alternatives should stay high-level:

- public API shape
- data flow
- ownership model
- rough skeleton

They should not turn into a full implementation plan at this stage.

### Architecture

An architecture ticket must include:

- the design problem
- current coupling or boundary failure
- why it causes maintenance or correctness risk
- at least two alternatives
- tradeoff notes

### Test Gap

A test-gap ticket must include:

- missing behavior or invariant
- why current tests miss it
- the smallest test shape that would catch it

---

## Fast Triage Contract

Every ticket must be optimized for fast human review.

Required sections:

- `Summary`
- `Why It Matters`
- `Evidence`
- `Repro Or Trace`
- `Alternatives` for recommendation-style tickets
- `Quick Triage`
- `Accept If`
- `Dismiss If`

The most important section is `Quick Triage`.

Example:

- Accept if `loadUser()` is callable before `session` is initialized.
- Dismiss if an upstream invariant guarantees `session` is never null at this call site.

This keeps the workflow from generating tickets that require a full archaeology session to evaluate.

---

## Ticket File Contract

Ticket files are projection artifacts, not the canonical store.

Suggested frontmatter:

```yaml
id: IMP-0142
status: open
kind: bug
priority: high
confidence: high
area: src/components/XYZ/
primary_file: src/components/XYZ/Foo.tsx
line_refs:
  - src/components/XYZ/Foo.tsx:42
  - src/lib/bar.ts:118
dedupe_key: bug:foo-tsx:42:stale-cache
discovered_at: 2026-03-16T12:00:00.000Z
run_id: rv-abc123
```

Suggested body shape:

```md
# IMP-0142 - Stale cache causes incorrect user rendering

## Summary
...

## Why It Matters
...

## Evidence
...

## Repro Or Trace
...

## Alternatives
...

## Quick Triage
...

## Accept If
...

## Dismiss If
...
```

---

## Priority Model

Suggested first-version priorities:

- `critical`
- `high`
- `medium`
- `low`

Priority should be based on impact first, not just confidence.

Suggested guidance:

- `critical`: exploitable security risk, data corruption, production crash, auth bypass
- `high`: user-visible bug, strong correctness issue, severe maintainability hazard
- `medium`: clear code smell or simplification opportunity with measurable downside
- `low`: useful cleanup with limited operational risk

Confidence should be a separate field:

- `high`
- `medium`
- `low`

Low confidence findings can still exist, but they should be clearly marked and usually deprioritized.

---

## Dedupe Rules

Duplicate ticket generation is the main failure mode of automated review systems.

`improvinho` should dedupe using a stable key derived from:

- ticket kind
- primary file
- canonicalized line anchor or symbol name
- normalized failure pattern or design problem

The dedupe pass should check:

- candidates from the current pass
- already open tickets
- previously rejected tickets
- accepted tickets already queued for implementation

If a ticket is re-discovered, the workflow should update metadata and evidence instead of creating a second file.

---

## Suggested Smithers Components

Suggested new modules:

```text
src/review/
  types.ts
  schemas.ts
  plan.ts
  tickets.ts
  projection.ts

src/components/
  ReviewDiscoveryWorkflow.tsx
  ReviewSlicePipeline.tsx
  TicketWriter.tsx

src/prompts/
  DiscoverIssues.mdx
  AuditEvidence.mdx
  WriteTicket.mdx
  ReviewSummary.mdx
```

Suggested runtime flow:

- `ReviewDiscoveryWorkflow`
  - owns the outer Ralph loop
  - selects slices
  - aggregates candidate and ticket state
- `ReviewSlicePipeline`
  - runs discovery and evidence audit for one slice
- `TicketWriter`
  - writes or updates `.tickets/` projection artifacts deterministically from DB-backed review tickets

---

## Suggested Schemas

At minimum:

- `slice_plan`
- `candidate_issue`
- `audited_issue`
- `review_ticket`
- `ticket_write`
- `pass_tracker`
- `completion_report`

Important schema rules:

- use `.nullable()`, not `.optional()`
- store stable IDs and dedupe keys explicitly
- keep evidence fields structured enough to support deterministic ticket rendering

Suggested audited issue shape:

```ts
{
  candidateId: string,
  dedupeKey: string,
  kind: "bug" | "security" | "simplification" | "architecture" | "test-gap",
  priority: "critical" | "high" | "medium" | "low",
  confidence: "high" | "medium" | "low",
  confirmed: boolean,
  summary: string,
  whyItMatters: string,
  evidence: string[],
  lineRefs: string[],
  reproOrTrace: string | null,
  alternatives: string[] | null,
  acceptIf: string[],
  dismissIf: string[],
  rejectionReason: string | null
}
```

---

## Suggested CLI Shape

First version:

```bash
ralphinho init review "<instruction>" --paths <path>...
ralphinho run
ralphinho status
ralphinho monitor
```

Later extensions:

```bash
ralphinho tickets list
ralphinho tickets accept IMP-0142
ralphinho tickets reject IMP-0142
ralphinho tickets archive IMP-0142
ralphinho remediate --from .tickets/open/high/
```

The remediation path should be a separate workflow, not folded into discovery.

---

## Exit Criteria

An `improvinho` run is successful when:

- all planned review slices were processed
- all confirmed findings were stored canonically in the DB
- all human-reviewable findings were projected into `.tickets/`
- no duplicate open tickets were created
- each open ticket contains enough evidence for a human to accept or dismiss it quickly

The run does not need to modify code to be considered successful.

---

## First Implementation Slice

The first slice should stay narrow:

1. add a new `review-discovery` mode to config loading
2. create `review-plan.json` generation from user instruction plus explicit paths
3. implement the outer Smithers review loop
4. persist validated findings into DB-backed review-ticket rows and project triage-worthy ones into `.tickets/`
5. skip remediation entirely

Do not build ticket acceptance commands or automatic fix workflows in v1.

---

## Design Principles

- Evidence over intuition
- Human triage speed over agent cleverness
- Non-overlapping review slices
- Stable dedupe keys
- Separate discovery from remediation
- Resumable Smithers state plus filesystem-visible tickets
- Small taxonomy, strict contracts

---

## Relationship To Ralphinho

`ralphinho` answers:

> What should we implement from this spec, and how do we land it safely?

`improvinho` answers:

> What is wrong or unnecessarily complex in this code area, and what should humans review first?

The two presets should compose well:

1. `improvinho` discovers and prioritizes issues
2. humans accept or reject tickets
3. a later remediation preset consumes accepted tickets

That separation keeps discovery honest and prevents the system from inventing work just to keep itself busy.
