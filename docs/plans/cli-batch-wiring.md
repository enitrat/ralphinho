# CLI Batch Wiring: `--batch` + `runBatchFromLinear`

## Overview
This work changes observable CLI behavior and fixes an execution-path bug.

- Feature: add a new batch execution path for `ralphinho run --linear --batch` when no `.ralphinho/config.json` exists.
- Behavior change: instead of consuming one Linear ticket, consume all parseable tickets, group by file overlap, and run groups sequentially.
- Bug fix: `scheduled-work` preset currently ignores `config.landingMode`; batch mode requires `landingMode: "pr"` to reach PR creation path.
- Schema status: `scheduledWorkConfigSchema.landingMode` already exists in `src/config/types.ts`; no schema code change is required.

## TDD Applicability
TDD applies.

Justification:
- Adds a new CLI branch and new observable logs/side effects.
- Changes Linear status transitions (in-progress/done) at batch scope.
- Fixes a user-visible workflow behavior (`landingMode` not propagated into `ScheduledWorkflow`).

## Step-by-Step Plan (Tests First)
1. Add CLI-path tests for `--batch` routing before implementation.
- Create `src/cli/run.test.ts` with focused tests around the no-config Linear bootstrap branch.
- Mock dependencies (`consumeTicket`, `consumeAllTickets`, scheduler helpers, smithers launch helpers, `initScheduledWork`) to assert call routing only.
- Test cases:
  - `--linear --batch` + missing config invokes `runBatchFromLinear` path (batch fetch called, single-ticket fetch not called).
  - `--linear` without `--batch` keeps existing `runFromLinearTicket` path.

2. Add batch-behavior tests for orchestration decisions before implementation.
- In `src/cli/run.test.ts`, add tests for `runBatchFromLinear` behavior via dependency mocks:
  - returns early with "nothing to do" message when `consumeAllTickets().tickets` is empty.
  - logs unparseable ticket identifiers and excludes them from grouping.
  - logs each group plan (`group id`, `files`, `ticket identifiers`) before launch.
  - marks all parseable tickets in-progress before first group launch.
  - marks only successful-group tickets done; failed-group tickets remain in-progress.

3. Implement `--batch` flag wiring in `src/cli/run.ts`.
- Read `const linearBatch = flags.batch === true`.
- Change no-config Linear branch from:
  - `if (linearOpts && !existsSync(configPath)) return runFromLinearTicket(...)`
  to:
  - route to `runBatchFromLinear(...)` when `linearBatch` is true.
- Keep existing single-ticket path untouched for non-batch usage.

4. Implement `runBatchFromLinear()` in `src/cli/run.ts`.
- Signature:
  - `async function runBatchFromLinear(opts: { repoRoot: string; ralphDir: string; linearOpts: { teamId: string; label: string; minPriority?: "critical" | "high" | "medium" | "low" }; force: boolean; flags: ParsedArgs["flags"]; }): Promise<void>`
- Flow:
  - call `consumeAllTickets({ teamId, label })`.
  - if `tickets.length === 0`, log and return.
  - log unparseable ticket identifiers from `unparseable`.
  - call `groupByFileOverlap(tickets)`.
  - log grouping plan for each group (group id, files, ticket identifiers).
  - mark all parseable tickets in-progress on Linear before executing groups.
  - for each group, sequentially:
    - build plan with `groupToWorkPlan(group, repoConfig)`.
    - write group-specific work plan JSON under `.ralphinho`.
    - ensure run config used by preset has `landingMode: "pr"` (override persisted config value for this batch run).
    - launch Smithers for that group.
    - on success: mark that group’s tickets done.
    - on failure: do not mark that group’s tickets done (leave in-progress), continue to next group or stop based on selected failure policy (prefer continue; document in logs).

5. Implement the `landingMode` propagation bug fix in preset.
- Modify `src/workflows/ralphinho/preset.tsx` to pass `landingMode={config.landingMode}` into `<ScheduledWorkflow ... />`.
- This enables `PushAndCreatePR` path when config selects `"pr"`.

6. Add/adjust preset coverage for landingMode propagation.
- Extend `src/preset.test.ts` (or add a focused preset wiring test) to assert scheduled config with `landingMode: "pr"` is accepted and available to preset consumers.
- If practical, add a shallow render assertion that `ScheduledWorkflow` receives the `landingMode` prop from loaded config.

7. Optional UX/documentation alignment for CLI help text.
- Update `src/cli/ralphinho.ts` help text to document `--batch` under Linear integration and examples.
- Not required for parser correctness but reduces operator confusion.

8. Verification and regression checks.
- Run targeted tests for changed areas:
  - `bun test src/cli/run.test.ts`
  - `bun test src/preset.test.ts`
- Run required repo-wide check:
  - `bun run typecheck`
- Confirm acceptance criteria mapping via logs and mock-call assertions.

## Files To Modify
- `src/cli/run.ts`
  - add `--batch` branch logic.
  - add `runBatchFromLinear()`.
  - import and use `consumeAllTickets`, `groupByFileOverlap`, `groupToWorkPlan`.
- `src/workflows/ralphinho/preset.tsx`
  - pass `landingMode={config.landingMode}` to `ScheduledWorkflow`.
- `src/preset.test.ts`
  - extend coverage for scheduled preset handling of `landingMode` propagation.
- `src/cli/ralphinho.ts` (optional but recommended)
  - help text updates for `--batch`.

## Files To Create
- `src/cli/run.test.ts`
  - CLI routing + batch orchestration tests.

## Risks and Mitigations
- Risk: Side-effect heavy orchestration makes tests flaky.
- Mitigation: isolate with module mocks and dependency seams; assert call order and payloads rather than external process behavior.

- Risk: status transitions can become inconsistent if process exits mid-batch.
- Mitigation: mark all parseable tickets in-progress once, and mark done strictly per successful group completion.

- Risk: batch path may overwrite or conflict with existing `.ralphinho` artifacts.
- Mitigation: keep path constrained to no-config bootstrap branch; use deterministic group plan filenames and explicit logs.

- Risk: `landingMode` still not honored if only config changes but preset wiring omitted.
- Mitigation: explicit preset prop pass + test coverage.

## Acceptance Criteria Verification Matrix
1. `--batch` recognized without parser errors.
- Verify `flags.batch === true` branch in `runWorkflow` and help text (optional) no longer ambiguous.

2. `--linear --batch` + no config invokes `runBatchFromLinear`.
- Verify via routing test in `src/cli/run.test.ts`.

3. Group plan logging includes group ID, files, ticket identifiers.
- Verify via logger assertions in batch tests.

4. Unparseable tickets skipped and logged.
- Verify `consumeAllTickets` fixture with mixed parseable/unparseable and corresponding log/assertions.

5. Empty tickets returns early with message.
- Verify early-return test (no launch calls).

6. `landingMode` accepts `pr|merge`, defaults to `merge`.
- Already satisfied by `src/config/types.ts`; confirm with parse test if needed.

7. Existing consumers omitting `landingMode` still parse.
- Covered by default in schema; keep/extend existing preset tests to ensure parse success without explicit field.

8. `bun run typecheck` passes.
- Run as final gate.
