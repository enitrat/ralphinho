# Changelog

## Unreleased

### Improved
- Scoped scheduled-work unit worktrees and unit bookmark prefixes by Smithers `runId`, preventing collisions between concurrent runs of the same plan.
- Added resume preflight checks in the `ralphinho` CLI to mirror Smithers `v0.10.0` durability rules before attempting `resume`.
- Extended `ralphinho status` to report whether the latest run is still resume-compatible from the current workflow file and repository revision.
- Strengthened merge-queue verification so both pre-land and post-land checks now run the full configured build and test command set, not just tests after landing.
- Fixed merge-queue prompt inconsistencies so it consistently targets the configured base branch rather than hardcoded `main`, and so cleanup instructions reference real worktree paths instead of placeholder workspace names.
- Renamed workflow/component branch props from `mainBranch` to `baseBranch` to match `.ralphinho/config.json`.

### Changed
- Simplified generated agent system prompts to align with Smithers task-schema output handling.
- Removed stale instructions telling agents to emit fenced JSON or use `TaskOutput`; generated prompts now defer to each task's schema/output contract.
- Tightened scheduled-work config validation so `rfcPath` is required rather than optional.
- Renamed the generated workflow template constant from `BASE_BRANCH` to `CONFIG_BASE_BRANCH` for full terminology consistency with `baseBranch`.

### Notes
- This repo is being aligned with Smithers `v0.10.0` semantics around resumability, concurrent runs, and agent-task output contracts.
