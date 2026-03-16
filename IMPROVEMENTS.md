# Improvinho — Design Improvements

> Decisions from critical review of `IMPROVINHO.md`. Each section documents the original design, the problem with it, and the chosen improvement.

---

## 1. Preset Architecture — Keep Separate

**Original:** Separate preset alongside ralphinho.

**Challenge:** The core loop (decompose → parallel work → quality gate → output) is identical to ralphinho. A shared engine with adapters would reduce duplication.

**Decision:** Keep as a separate preset. The execution models diverge enough (review slices vs implementation units, tickets vs diffs) that coupling them risks polluting ralphinho's well-tested path. Code reuse can happen at the utility level without forcing a shared loop.

---

## 2. Pipeline Phases — Collapse from 5 to 3

**Original:** Slice Planning → Candidate Discovery → Evidence Audit → Ticket Materialization → Summary.

**Problem:** The separate "Evidence Audit" phase assumes discovery agents produce garbage requiring a second LLM pass to validate. This doubles token cost to compensate for bad prompts rather than writing good ones.

**Decision:** 3 phases:

1. **Discovery** — produces evidence-backed findings directly. The prompt must require concrete evidence (file refs, code snippets, logical argument). No separate "candidate" concept.
2. **Validation filter** — lightweight, non-LLM pass. Rejects low-confidence findings, deduplicates, applies threshold rules. This is code logic, not a second model call.
3. **Materialization** — writes confirmed findings to DB and projects the summary.

The quality gate is a programmatic filter, not an audit agent.

---

## 3. DB Model — Single Entity with Status Field

**Original:** Three entities: `candidate_issue` → `audited_issue` → `review_ticket`.

**Problem:** The distinction between `audited_issue` and `review_ticket` is unclear. The doc provides no criteria for when a confirmed finding wouldn't become a ticket. The middle entity exists to feel rigorous, not to serve a real purpose.

**Decision:** Single `finding` table with a status field:

```
draft → confirmed → projected → rejected
```

Query by status for any view. The status transition history is the audit trail. No need for three tables when one with an enum does the job.

Schema sketch:

```ts
{
  id: string,           // IMP-0001
  status: "draft" | "confirmed" | "projected" | "rejected",
  dedupeKey: string,    // kind:file:symbol:pattern
  kind: "bug" | "security" | "simplification" | "architecture" | "test-gap",
  priority: "critical" | "high" | "medium" | "low",
  confidence: "high" | "medium" | "low",
  summary: string,
  evidence: string,     // one concrete proof
  primaryFile: string,
  lineRefs: string[],
  suggestedDiff: string | null,  // inline fix for trivial findings
  rejectionReason: string | null,
  runId: string,
  discoveredAt: string
}
```

---

## 4. Dedupe Strategy — Symbol-Based Keys

**Original:** Dedupe key = kind + primaryFile + line anchor + failure pattern.

**Problem:** Line-based anchors are fragile. Adding a blank line shifts all keys. The doc treats symbol-based anchors as optional when they should be primary.

**Decision:** Symbol-based dedupe keys in the format:

```
kind:file:symbol:pattern
```

Examples:
- `bug:src/auth/login.ts:handleLogin:null-session`
- `simplification:src/utils/format.ts:formatDate:redundant-parse`
- `architecture:src/api/users/:handler-coupling:direct-db-access`

Symbols (function names, class names, export names) survive minor edits. Fall back to file-level keys only when no symbol anchor exists (e.g., module-level issues).

---

## 5. Output Format — Single Summary File

**Original:** `.tickets/` directory tree with `index.json`, individual ticket files, priority subdirectories.

**Problem:** This mimics a ticketing system (Jira, Linear) but worse. Nobody navigates a directory tree to triage findings. If findings matter, they belong in the team's real issue tracker. If they're ephemeral, a single file is faster to scan.

**Decision:** Single `.tickets/summary.md` file with findings grouped by priority:

```md
# Improvinho Review — 2026-03-16

## Critical (1)
### IMP-0003 — SQL injection in user search
...

## High (3)
### IMP-0001 — Null session in login handler
...

## Medium (5)
...

## Low (2)
...
```

Each finding in the summary includes: title, summary, evidence, file refs, and suggested diff (if applicable). One file, one scroll, done.

GitHub issue creation can be added later as an optional projection target.

---

## 6. Evidence Requirements — Minimal Bar

**Original:** Rigid per-kind templates requiring preconditions, triggering paths, expected/actual behavior, two alternatives, etc.

**Problem:** Strict templates generate padding. LLMs will hallucinate repro traces and filler alternatives to satisfy the format. The "at least two alternatives" requirement for simplification tickets guarantees one real idea and one invented one.

**Decision:** Every finding must include:

1. **Summary** — one sentence, what's wrong
2. **File references** — primary file + line refs
3. **One concrete piece of evidence** — a code snippet, execution trace, or logical argument proving the issue exists

That's it. No mandatory repro steps, no forced alternatives, no template sections that encourage verbosity. The kind of evidence naturally varies by finding type — a bug might show a trace, a simplification might show the complex code — but the system doesn't enforce a template.

Optional: `acceptIf` / `dismissIf` one-liners for fast triage, encouraged but not required.

---

## 7. Review Slices — File-Based + Cross-Cutting Pass

**Original:** Non-overlapping file-based slices only.

**Problem:** The most valuable findings are cross-cutting: duplicated logic across modules, inconsistent error handling, misused abstractions. File-based slices systematically miss these. Yet the doc lists "architecture" as a first-class ticket kind — those findings can't be discovered from a single file slice.

**Decision:** Two review modes in each run:

1. **Local slices** — file/directory-based, non-overlapping. Discover bugs, security issues, code smells, test gaps within bounded areas. Same as current design.
2. **Cross-cutting pass** — runs after local slices complete. Gets full-repo context (or at least dependency graph + key interfaces). Discovers architectural issues, inconsistencies, duplication patterns.

The cross-cutting pass should be explicitly scoped (e.g., "review the error handling strategy across all API handlers") rather than open-ended "review everything."

---

## 8. Stop Condition — Coverage-Based

**Original:** Stop after 2 consecutive passes with zero new confirmed tickets, or max passes reached.

**Problem:** This measures whether the LLM ran out of things to say, not review quality. Multiple passes over the same code with the same model produce diminishing returns fast and waste tokens.

**Decision:** Coverage-based stop:

- One discovery pass per local slice
- One cross-cutting pass
- Done when all slices + cross-cutting pass complete

No multi-pass loops. If a slice was reviewed with a good prompt and adequate context, re-reviewing it won't find substantially more. If the findings are insufficient, the fix is a better prompt or narrower slices, not more passes.

---

## 9. Trivial Findings — Inline Diffs

**Original:** No auto-fix. All findings are tickets only.

**Problem:** For trivial issues (dead code, unused imports, missing null checks), producing a 20-line ticket that says "add a null check at line 42" is pure overhead. The fix is obvious and mechanical.

**Decision:** Findings may include an optional `suggestedDiff` field — a code block showing the proposed fix:

```md
### IMP-0012 — Unused import in auth handler
**File:** src/auth/handler.ts:3
**Evidence:** `import { legacy } from './compat'` — `legacy` is not referenced anywhere in the file.

**Suggested fix:**
\`\`\`diff
- import { legacy } from './compat'
\`\`\`
```

The system does not apply the fix automatically. The human can copy-paste or apply it. This is strictly more useful than a description-only ticket, with zero risk of unwanted changes.

Graduate to auto-fix PRs in a later version when confidence in the suggestion quality is established.

---

## 10. Pipeline Shape — Batch Only

**Original:** Batch pipeline (point at codebase, dump findings).

**Challenge considered:** An incremental per-PR reviewer (0-3 findings per change) has better ergonomics — smaller blast radius, immediate relevance, built-in feedback loop.

**Decision:** Batch only for v1. The incremental model requires CI integration, PR webhook handling, and a feedback loop — all substantial infrastructure beyond the core discovery problem.

Batch mode solves the immediate need: "point at this code area and tell me what's wrong." If the batch mode works well, the same discovery engine can be wrapped in a CI trigger later, but that's not v1 scope.

---

## Summary of Changes from Original Design

| Area | Original | Improved |
|------|----------|----------|
| Preset | Separate | Separate (unchanged) |
| Phases | 5 (plan → discover → audit → materialize → summary) | 3 (discover → filter → materialize) |
| DB entities | 3 tables (candidate → audited → ticket) | 1 table with status field |
| Dedupe | Line-based keys | Symbol-based keys (kind:file:symbol:pattern) |
| Output | `.tickets/` directory tree | Single `summary.md` |
| Evidence | Rigid per-kind templates | Minimal bar (summary + refs + one proof) |
| Slices | File-based only | File-based + cross-cutting pass |
| Stop condition | Output-based (2 empty passes) | Coverage-based (all slices done) |
| Auto-fix | None | Inline suggested diffs |
| Shape | Batch | Batch (unchanged, no incremental in v1) |
