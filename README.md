# super-ralph

> Reusable Ralph workflow pattern - ticket-driven development with multi-agent review loops

Encapsulates the proven workflow pattern extracted from Plue:
- **Ticket discovery** from codebase reviews and AI agents
- **Stacked ticket processing** with isolated worktrees
- **TDD validation loops** (Research → Plan → Implement → Test → Review → Fix)
- **Multi-agent code review** (Claude + Codex + Gemini consensus)
- **Automated priority sorting** and deduplication

## Installation

```bash
bun add @evmts/super-ralph smithers-orchestrator
```

## Usage

```typescript
import { selectAllTickets, selectReviewTickets } from "@evmts/super-ralph";
import { smithers } from "./your-smithers-setup";

export default smithers((ctx) => {
  const { completed, unfinished } = selectAllTickets(ctx, categories, outputs);

  // Use selectors to build your workflow
  // ...
});
```

## Selectors

Selectors extract data from SmithersCtx without tight coupling to your schema:

- `selectAllTickets()` - Get all tickets (merged, deduplicated, sorted)
- `selectReviewTickets()` - Get tickets from codebase reviews
- `selectDiscoverTickets()` - Get tickets from AI discovery
- `selectCompletedTicketIds()` - Get IDs of completed tickets
- `selectProgressSummary()` - Get latest progress summary
- `selectTicketReport()` - Get ticket completion report
- `selectResearch()` - Get research context
- `selectPlan()` - Get implementation plan
- `selectImplement()` - Get implementation output
- `selectTestResults()` - Get test results
- `selectSpecReview()` - Get spec review
- `selectCodeReviews()` - Get merged code reviews (Claude + Codex + Gemini)

## Pattern

The Ralph pattern is:

```
Ralph (infinite loop)
  ├─ Parallel
  │  ├─ UpdateProgress (summarize completed work)
  │  ├─ CodebaseReview (identify issues → tickets)
  │  ├─ Discover (identify new work → tickets)
  │  ├─ IntegrationTest (run category-level tests)
  │  └─ TicketPipeline (for each unfinished ticket)
  │     └─ Worktree (isolated git worktree)
  │        ├─ Research (gather context)
  │        ├─ Plan (TDD plan)
  │        ├─ ValidationLoop (until reviews pass)
  │        │  ├─ Implement (TDD: tests first)
  │        │  ├─ Test (run all tests)
  │        │  ├─ BuildVerify (check compilation)
  │        │  ├─ Parallel
  │        │  │  ├─ SpecReview (check against specs)
  │        │  │  └─ CodeReview (multi-agent review)
  │        │  └─ ReviewFix (fix issues if any)
  │        └─ Report (mark complete)
  └─ (repeat until no work remains)
```

## License

MIT
