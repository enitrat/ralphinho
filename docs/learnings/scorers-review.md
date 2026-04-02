# Learnings: scorers-review

## Patterns

### [architecture] Never import from deep internal paths of sibling packages
When one package needs functionality from another, import from the package's public API (barrel exports) or extract the shared utility into a common/shared module. Deep imports like `smithers-orchestrator/src/cli/find-db` bypass the package boundary, break TypeScript module resolution, and create fragile coupling to internal file structure. This was the last remaining blocker in the review cycle.
Example: Replace `import { findDb } from "smithers-orchestrator/src/cli/find-db"` with a shared helper like `import { withSmithersDb } from "./shared"` that encapsulates the DB-access pattern.
Frequency: recurring

### [code-quality] Match established cleanup patterns in the codebase
When writing resource-cleanup code (DB handles, file descriptors, etc.), search the codebase for the existing convention before inventing your own. Inconsistent patterns (`if (cleanup) cleanup()` vs `cleanup?.()`, `let cleanup: Function` vs `let cleanup: (() => void) | undefined`) create review churn and confuse future readers. A quick grep for the pattern in the repo takes seconds and prevents a review round-trip.
Example: The codebase convention was `let cleanup: (() => void) | undefined` with `cleanup?.()` — initial implementation used a different pattern and required a revision.
Frequency: recurring

### [architecture] Wire new CLI subcommands into the router immediately
When adding a new CLI subcommand (e.g., `scores`), the switch/case routing in the CLI entry point must be updated in the same commit as the handler implementation. Missing the routing wire-up means the feature is unreachable despite being fully implemented — a critical defect that's easy to overlook because the handler code compiles and tests pass in isolation.
Example: `case "scores"` was missing from the CLI switch statement in `ralphinho.ts` while `runScores()` was fully implemented and tested.
Frequency: recurring

### [testing] Integration tests must cover the full invocation path, not just the handler
Unit-testing only the handler function (e.g., `runScores()`) doesn't catch wiring issues like missing CLI routes or incorrect argument forwarding. Include at least one integration test that exercises the entry point with realistic arguments to verify the full path from CLI input to handler execution.
Example: Adding tests for `runScores` that verify DB opening, argument forwarding, and cleanup invocation caught issues that handler-only tests would have missed.
Frequency: recurring

### [code-quality] Separate trusted and untrusted input validation paths
When a function accepts both typed (already-validated) data and raw external input, don't validate everything uniformly. Create separate entry points: a typed path that trusts the compiler and an untrusted path with runtime validation. This avoids redundant checks on typed data and makes the trust boundary explicit.
Example: `writeEventLog` was stripped of redundant validation for typed events; a separate `writeUntrustedEventLog` was created to handle raw input with full runtime checks.
Frequency: recurring
