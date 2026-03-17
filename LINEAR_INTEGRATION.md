# Linear Integration

> Optional glue layer that connects Improvinho (review) and Ralphinho (implementation) through Linear as a human-in-the-loop triage buffer.

Both workflows are fully standalone. Linear integration adds two capabilities: pushing review findings as Linear issues, and consuming approved issues as implementation work.

---

## The Loop

Improvinho discovers issues. Humans triage them in Linear. Ralphinho implements the approved ones.

```
  Improvinho                     Linear                      Ralphinho
+------------------+    +-------------------------+    +------------------+
| Scan repo paths  |    |                         |    | Fetch approved   |
| Run 3 lenses     |--->| Findings become issues  |    | ticket from      |
| Filter + merge   |    |                         |    | Linear           |
| Push to Linear   |    | Human triages:          |    |                  |
+------------------+    |   accept / reject / edit |--->| Convert to RFC   |
                        |   add "ralph-approved"   |    | Decompose + DAG  |
                        |   label                  |    | Run pipeline     |
                        |                         |    | Mark done        |
                        +-------------------------+    +------------------+
```

Each direction works independently. You can push findings without consuming them. You can consume tickets that were created manually.

---

## Improvinho -> Linear (Push Findings)

After a review run, pass `--linear` to push confirmed findings as Linear issues.

### Usage

```bash
# Run review and push all findings
ralphinho init review "Review auth layer" --paths src/auth
ralphinho run --linear --team <team-id>

# Only push high+ priority findings
ralphinho run --linear --team <team-id> --min-priority high
```

### What Gets Created

Each merged finding becomes one Linear issue with:

| Field | Source |
|-------|--------|
| Title | `[IMP-0001] <summary>` |
| Priority | Finding priority mapped to Linear levels (critical=1, high=2, medium=3, low=4) |
| Labels | Matched by finding `kind` (bug, security, etc.) against existing team labels |
| Description | Structured metadata + evidence + suggested diff |

The issue description includes:

```markdown
**Kind:** bug
**Priority:** high
**Confidence:** high
**File:** `src/auth/handler.ts`
**Lines:** `42`, `48`

## Evidence
User input is interpolated directly into the query string...

## Suggested Fix
```diff
- const query = `SELECT * FROM users WHERE name = '${input}'`
+ const query = `SELECT * FROM users WHERE name = $1`
```

---
*Detected by: refactor-hunter, type-system-purist*
*Scopes: src/auth/*
*Support count: 2*
```

### How It Works

1. Reads merged findings from the Improvinho workflow DB (SQLite)
2. Resolves the latest review run ID
3. Filters by `--min-priority` if specified
4. Creates one Linear issue per finding via the Linear SDK
5. Matches finding `kind` against existing team labels (no labels are created)

If a label matching the finding kind (e.g., "bug", "security") exists on the team, it is attached. Labels are matched case-insensitively. Missing labels are silently skipped.

---

## Linear -> Ralphinho (Consume Tickets)

When `--linear` is passed and no `.ralphinho/config.json` exists, Ralphinho fetches an approved ticket from Linear and runs it through the implementation pipeline.

### Single Ticket Mode

```bash
# Consume the highest-priority approved ticket and implement it
ralphinho run --linear --team <team-id>

# With a custom label filter
ralphinho run --linear --team <team-id> --label ready-for-ai
```

**What happens:**

1. Fetch issues with the specified label (default: `ralph-approved`) in "unstarted" state. Falls back to "started" if none found.
2. Sort by priority (urgent first) and take the highest.
3. Mark the ticket "In Progress" in Linear and add a comment.
4. Convert the issue to RFC-format markdown (title, description, context, acceptance criteria).
5. Run `ralphinho init` with the generated RFC to decompose into work units.
6. Execute the pipeline.
7. On success, mark the ticket "Done" in Linear with a completion comment.

### Batch Mode

```bash
# Consume all approved tickets and implement them in groups
ralphinho run --linear --batch --team <team-id>
```

Batch mode fetches all approved tickets at once, groups them by file overlap, and executes each group as a separate Smithers run.

**Grouping logic:**

Tickets that touch the same `primaryFile` (parsed from the Improvinho-formatted issue description) are grouped together using union-find. Within a group, tickets on the same file are chained sequentially (each depends on the previous). Tickets on different files run in parallel.

```
Ticket A: primaryFile = src/auth.ts    ─┐
Ticket B: primaryFile = src/auth.ts     ├─ Group 0 (A → B sequential)
                                        │
Ticket C: primaryFile = src/api.ts     ─┘─ Group 0 (C parallel with A,B)

Ticket D: primaryFile = src/utils.ts   ── Group 1 (independent)
```

**Execution:**

- Groups execute sequentially (one Smithers run per group)
- All tickets are marked "In Progress" before execution starts
- Each group uses `landingMode: "pr"` (pushes branches + creates GitHub PRs, does not merge directly)
- All work units default to tier `small` (implement, test, code-review, review-fix, final-review — no research or plan stages)
- On success, all tickets in the group are marked "Done"
- On failure, tickets remain "In Progress" for manual intervention

### Issue Metadata Parsing

When consuming tickets, the adapter parses structured metadata from the issue description using regex extraction:

| Field | Pattern |
|-------|---------|
| Kind | `**Kind:** value` |
| Priority | `**Priority:** value` |
| Confidence | `**Confidence:** value` |
| Primary file | `**File:** \`value\`` |
| Lines | `**Lines:** \`a\`, \`b\`` |
| Symbol | `**Symbol:** \`value\`` |

Tickets without a parseable `primaryFile` are skipped in batch mode (logged as "unparseable"). In single-ticket mode, metadata parsing is not required — the full description is converted to RFC markdown regardless.

---

## Ticket Lifecycle

```
               Improvinho pushes finding
                        |
                        v
               +------------------+
               |    Backlog       |  (Linear issue created)
               +--------+---------+
                        |
                   human adds label
                  "ralph-approved"
                        |
                        v
               +------------------+
               |    Unstarted     |  (ready for consumption)
               +--------+---------+
                        |
                ralphinho run --linear
                        |
                        v
               +------------------+
               |   In Progress    |  (comment: "Ralphinho is working on this")
               +--------+---------+
                        |
                   pipeline runs
                        |
               +--------+---------+
               |                  |
          success             failure
               |                  |
               v                  v
       +---------------+  +------------------+
       |     Done      |  |   In Progress    |  (stays for manual fix)
       +---------------+  +------------------+
       (comment with
        summary + PR url)
```

---

## Configuration

### Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `LINEAR_API_KEY` | Yes (when using `--linear`) | — | Linear API authentication |
| `LINEAR_TEAM_ID` | No | — | Fallback for `--team` flag |
| `LINEAR_LABEL` | No | `ralph-approved` | Fallback for `--label` flag |
| `ANTHROPIC_API_KEY` | Yes (for consume path) | — | AI decomposition during init |

### CLI Flags

| Flag | Scope | Purpose |
|------|-------|---------|
| `--linear` | Both directions | Enable Linear integration |
| `--team <id>` | Both directions | Linear team ID |
| `--label <name>` | Consume only | Label filter for ticket selection |
| `--min-priority <level>` | Push only | Only push findings at or above this priority |
| `--batch` | Consume only | Fetch all approved tickets instead of just one |

With `LINEAR_TEAM_ID` set, you can omit `--team`:

```bash
export LINEAR_TEAM_ID=your-team-id
ralphinho run --linear              # single ticket
ralphinho run --linear --batch      # all tickets
```

---

## Round-Trip Fidelity

Findings pushed by Improvinho carry structured metadata in the issue description. When Ralphinho consumes them in batch mode, it parses that metadata back to reconstruct file references and priority. This means:

- **Improvinho-originated tickets** get file-aware grouping in batch mode (tickets on the same file are chained)
- **Manually created tickets** work fine in single-ticket mode (the full description becomes the RFC) but may be flagged as "unparseable" in batch mode if they lack the structured metadata format

For best results in batch mode, ensure tickets include a `**File:** \`path\`` field in the description.
