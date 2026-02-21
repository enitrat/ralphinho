/**
 * Super Ralph - Reusable Ralph workflow pattern
 *
 * Encapsulates the ticket-driven development workflow with:
 * - Multi-agent code review
 * - TDD validation loops
 * - Automated ticket discovery and prioritization
 * - Stacked ticket processing with worktrees
 *
 * Extracted from Plue workflow, generalized for reuse.
 */

export * from "./selectors";
export type { Ticket } from "./selectors";
export * from "./components";
