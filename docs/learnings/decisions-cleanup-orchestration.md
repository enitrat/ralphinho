# Learnings: decisions-cleanup-orchestration

## Patterns

### [error-handling] Preserve all intermediate states when simplifying status mapping
When refactoring status/state mappings, a binary split (passed vs. rejected) incorrectly flattens multi-phase state machines. Non-terminal states (e.g., `pending`) must survive until the loop is actually exhausted or definitively resolved. Mapping `!passed → rejected` prematurely collapses in-progress iterations.
Example: `pollEventsFromDb` mapped any non-passed `review_loop_result` to `rejected`, but loops emit per-iteration results; non-passed and non-exhausted iterations should remain `pending` until the loop concludes.
Frequency: recurring

### [testing] Write a failing regression test before fixing a state machine regression
When a status-mapping bug is found, the first commit should be a failing test that reproduces the incorrect behavior. This pins the expected semantics explicitly and prevents the same regression from silently re-entering. Fix the implementation only after the red test exists.
Example: Add a test for `pollEventsFromDb` that asserts in-progress (non-exhausted) loop iterations produce `pending` status before updating the mapping logic.
Frequency: recurring

### [code-quality] Import shared enum/type from its canonical source; never re-declare locally
Re-declaring an existing type (e.g., `DecisionStatus`) inside a consuming module duplicates the source of truth and creates silent drift — the local copy can diverge without compiler errors. Always import from the module that owns the type, even if it means adding an export there.
Example: `DecisionStatus` was re-declared in `projections.ts` instead of being imported from `events.ts` where it was already defined.
Frequency: recurring

### [architecture] Cleanup units that delete files must audit every consumer for behavioral regressions
When a file is deleted and its callers are updated, the risk is not just missing imports but subtly wrong behavioral equivalents. Each replacement call site must be verified to preserve the original semantics — not just compile — especially for state machine branches and guard conditions.
Example: Deleting `decisions.ts` required replacing `isMergeEligible()` calls; the replacement introduced a regression in how non-passed, non-exhausted results were classified.
Frequency: recurring

### [other] Final review requires concrete evidence: diff, test output, and AC checklist
A review marked "cannot confirm completeness" stalls the unit regardless of how correct the code is. Always include: (1) the implementation diff or changed-files summary, (2) test output showing passing tests, and (3) an explicit acceptance-criteria checklist with pass/fail per item. Omitting these forces a rejection cycle even when the work is correct.
Example: The final review was rejected with "no implementation diff, test results, or acceptance-criteria verification evidence included."
Frequency: recurring
