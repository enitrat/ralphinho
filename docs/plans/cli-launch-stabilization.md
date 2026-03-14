# Plan: CLI Launch Stabilization

**Unit:** cli-launch-stabilization
**Category:** large
**Date:** 2026-03-15

---

## Overview

This unit refactors the CLI launch and resume integration to remove fragile path guessing, eliminate direct SQLite coupling to Smithers internals, and consolidate launch logic into a dedicated module. The work is primarily **internal refactoring** — no user-facing behavior changes except better error messages and removing client-side resume compatibility checks (delegated to Smithers).

## Does TDD Apply?

**Partially.** TDD applies to the new `src/runtime/smithers-launch.ts` module since it introduces new public functions (`resolveSmithersCliPath`, `buildLaunchConfig`) with testable inputs/outputs. The rest is mechanical refactoring (deleting dead code, collapsing branches, moving functions) where the typecheck is the primary verification.

**TDD scope:** `resolveSmithersCliPath` and `buildLaunchConfig` — write tests first.
**Non-TDD scope:** Dead code removal from `shared.ts`, resume simplification in `run.ts`/`status.ts`, `importPrefix` cleanup.

---

## Step-by-Step Implementation

### Phase 1: New Module with Tests (TDD)

#### Step 1 — Write tests for `resolveSmithersCliPath`
**File:** `src/runtime/smithers-launch.test.ts` (CREATE)

Tests:
- Returns path when `smithers-orchestrator/package.json` is resolvable via `createRequire`
- Returns `null` when `smithers-orchestrator` is not installed
- Resolved path is `join(smithersPkgDir, bin.smithers)` matching the `bin` field from `package.json`
- Does NOT contain any path referencing `smithers-orchestrator/src/cli/index.ts` as a hardcoded string literal

#### Step 2 — Write tests for `buildLaunchConfig`
**File:** `src/runtime/smithers-launch.test.ts` (APPEND)

Tests:
- Returns correct `cmd` array for `mode: "run"` with all options
- Returns correct `cmd` array for `mode: "resume"` with `runId`
- Includes `--force` flag when `force: true`
- Sets `USE_CLI_AGENTS=1` in env
- Removes `CLAUDECODE` from env
- Computes correct `cwd` for source mode vs installed mode

#### Step 3 — Implement `src/runtime/smithers-launch.ts`
**File:** `src/runtime/smithers-launch.ts` (CREATE)

Exports:
```ts
export type LaunchMode = "run" | "resume";

export type LaunchOptions = {
  mode: LaunchMode;
  workflowPath: string;
  repoRoot: string;
  runId: string;
  maxConcurrency: number;
  smithersCliPath: string;
  force?: boolean;
};

export type LaunchConfig = {
  cmd: string[];
  cwd: string;
  env: Record<string, string>;
};

// Resolves smithers CLI path from node_modules via package.json bin field.
// Uses createRequire to resolve smithers-orchestrator/package.json, then
// reads pkg.bin.smithers to get the entry point.
export function resolveSmithersCliPath(fromDir?: string): string | null;

// Builds the full launch configuration (cmd, cwd, env) without spawning.
// Pure function — testable without side effects.
export function buildLaunchConfig(opts: LaunchOptions): LaunchConfig;

// Spawns the Smithers process and returns exit code.
// Thin wrapper: calls buildLaunchConfig then Bun.spawn.
export async function launchSmithers(opts: LaunchOptions): Promise<number>;
```

Implementation details:
- `resolveSmithersCliPath`: Use `createRequire(fromDir || import.meta.url)` to resolve `smithers-orchestrator/package.json`, read the `bin.smithers` field, return `join(dirname(resolved), bin.smithers)`. No hardcoded candidate paths.
- `buildLaunchConfig`: Port the args/env/cwd logic from current `launchSmithers` in `shared.ts`. Import `ralphSourceRoot` and `runningFromSource` from `shared.ts` (they remain there as they're used elsewhere).
- `launchSmithers`: Call `buildLaunchConfig`, then `Bun.spawn(config.cmd, { cwd, env, stdout/stderr/stdin: "inherit" })`, return `proc.exited`.

#### Step 4 — Run tests, verify green
```bash
bun test src/runtime/smithers-launch.test.ts
```

### Phase 2: Wire New Module and Remove Dead Code

#### Step 5 — Update `run.ts` to use new launch module
**File:** `src/cli/run.ts` (MODIFY)

Changes:
- Replace import of `findSmithersCliPath`, `launchSmithers` from `./shared` with imports from `../runtime/smithers-launch`
- Remove imports of `checkResumeCompatibility`, `getLatestRun` from `./shared`
- **Simplify explicit `--resume` path** (lines 82-116): Remove `checkResumeCompatibility` call. Keep `existsSync(dbPath)` check. Print a preflight message like "Attempting to resume run {runId}..." and delegate validation to Smithers. If Smithers exits non-zero, the existing `reportExit` handles error display.
- **Simplify `--force` resume path** (lines 119-148): Remove `checkResumeCompatibility` call. If `existsSync(dbPath)`, pass `--force` flag to Smithers and let it decide. Remove the "not resumable" fallback-to-fresh-run logic (Smithers handles this).
- **Simplify interactive resume path** (lines 150-194): Remove `getLatestRun` and `checkResumeCompatibility` calls. The "Resume previous run" option can check `existsSync(dbPath)` to know whether resume is possible. Pass a generic resume to Smithers without a specific run ID (let Smithers pick the latest). Alternatively, if Smithers requires a run-id, keep a minimal query or shell out to `smithers list --latest` if available.

> **Open question for implementation:** The interactive prompt currently shows `latestRunId` from SQLite. Two options:
> 1. Show "Resume previous run" without ID (simpler, acceptable UX)
> 2. Add a `smithers list --latest` call to get the ID without direct DB access
>
> **Recommended:** Option 1 for now. The run ID is visible in the Smithers output on resume.

#### Step 6 — Update `status.ts` to remove SQLite coupling
**File:** `src/cli/status.ts` (MODIFY)

Changes:
- Remove imports of `checkResumeCompatibility`, `getLatestRun` from `./shared`
- Replace the "Latest run" display section (lines 48-64) with a simpler check:
  - If `existsSync(dbPath)`: print `"  Database: exists"` (or similar)
  - Remove the resume compatibility check display
  - Optionally: shell out to `smithers list --latest` if we want to show run info

#### Step 7 — Delete dead code from `shared.ts`
**File:** `src/cli/shared.ts` (MODIFY)

Delete:
- `findSmithersCliPath` function (lines 332-352)
- `StoredRunMetadata` type (lines 354-362)
- `ResumeMetadata` type (lines 364-370)
- `ResumeCompatibility` type (lines 372-377)
- `loadRunMetadata` function (lines 463-502)
- `getLatestRun` function (lines 504-540)
- `checkResumeCompatibility` function (lines 542-591)
- `readCurrentResumeMetadata` function (lines 432-461)
- `launchSmithers` function (lines 593-659)

Keep:
- `sha256Hex`, `findVcsRoot`, `readWorkflowHash`, `runCaptured`, `getGitPointer`, `getJjPointer` — only if still used by remaining code. Check imports after deletion; if nothing references them, delete too.
- `ralphSourceRoot`, `runningFromSource` — still used by `render-scheduled-workflow.ts` and `init-scheduled.ts`
- `promptChoice` — still used by `run.ts`
- `getRalphDir`, `parseArgs`, `scanRepo`, `detectAgents`, etc. — unrelated, keep

Remove the `bun:sqlite` require (it should no longer be needed after deleting the SQLite functions).

### Phase 3: Clean Up importPrefix

#### Step 8 — Simplify `render-scheduled-workflow.ts` importPrefix
**File:** `src/cli/render-scheduled-workflow.ts` (MODIFY)

Change lines 17-29 from 3 branches to 2:

```ts
// Before:
const isLibRepo = existsSync(...) && existsSync(...);
let importPrefix: string;
if (isLibRepo) {
  importPrefix = "../../src";
} else if (runningFromSource) {
  importPrefix = ralphSourceRoot + "/src";
} else {
  importPrefix = "super-ralph";
}

// After:
let importPrefix: string;
if (runningFromSource) {
  importPrefix = ralphSourceRoot + "/src";
} else {
  importPrefix = "super-ralph";
}
```

This removes the fragile `"../../src"` relative path and the `isLibRepo` filesystem existence checks. When running from source (which includes the lib-repo case), the absolute path is used. The `existsSync` import can be removed if no longer needed.

### Phase 4: Verification

#### Step 9 — Typecheck
```bash
bun run typecheck
```
Must pass with no new errors.

#### Step 10 — Run all tests
```bash
bun test
```
Ensure no regressions.

#### Step 11 — Manual smoke test
```bash
# Verify findSmithersCliPath replacement works
bunx ralphinho run --help  # Should find smithers correctly
```

---

## Files Summary

| File | Action | Description |
|------|--------|-------------|
| `src/runtime/smithers-launch.ts` | CREATE | Bin resolution, launch config, process spawn |
| `src/runtime/smithers-launch.test.ts` | CREATE | Unit tests for bin resolution and launch config |
| `src/cli/shared.ts` | MODIFY | Delete 7 functions + 3 types + SQLite coupling |
| `src/cli/run.ts` | MODIFY | Simplify resume paths, use new launch module |
| `src/cli/status.ts` | MODIFY | Remove SQLite queries, simplify display |
| `src/cli/render-scheduled-workflow.ts` | MODIFY | Collapse 3 importPrefix branches to 2 |

---

## Acceptance Criteria Verification

| # | Criterion | How Verified |
|---|-----------|--------------|
| 1 | `findSmithersCliPath` contains no path referencing `smithers-orchestrator/src/cli/index.ts` | `resolveSmithersCliPath` uses `createRequire` + `package.json` bin field; grep for the old literal confirms absence |
| 2 | No code under `src/cli/` opens SQLite or queries `_smithers_runs` | All SQLite functions deleted from `shared.ts`; grep for `_smithers_runs` and `bun:sqlite` in `src/cli/` returns zero matches |
| 3 | `src/runtime/smithers-launch.ts` exports `launchSmithers` and `resolveSmithersCliPath` | File exists with correct exports; unit tests pass |
| 4 | `run.ts` resume path does not compare workflow hashes or VCS revisions | All `checkResumeCompatibility` calls removed; grep confirms no hash/revision comparison in `run.ts` |
| 5 | `render-scheduled-workflow.ts` importPrefix does not depend on source-layout existence checks beyond `runningFromSource` | `isLibRepo` and its `existsSync` calls removed; only `runningFromSource` flag remains |
| 6 | `bun run typecheck` passes | Run typecheck as Step 9 |

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Smithers resume fails silently when given invalid run-id | User sees generic non-zero exit code | Check Smithers behavior; add user-friendly message wrapping the exit code in `reportExit` |
| `createRequire` resolution fails in edge cases (monorepo, symlinks) | `resolveSmithersCliPath` returns `null` | Keep clear error message in `run.ts` telling user to install `smithers-orchestrator` |
| Interactive resume prompt loses run-id display | Minor UX regression | Show "Resume previous run" without ID; ID is printed by Smithers on start |
| `status.ts` loses "Latest run" info | Minor feature regression | Accept for now; can add `smithers list` integration later |
| Helper functions in `shared.ts` (`sha256Hex`, `findVcsRoot`, etc.) become orphaned | Dead code | Verify usage after deletion; remove if unused |

---

## Open Questions (from research)

1. **Smithers resume error codes:** Does Smithers exit with a specific code for "run not found" vs "incompatible"? If so, `reportExit` can show targeted messages. → Investigate during implementation.
2. **`smithers list` subcommand:** Does Smithers have a way to query run info without direct DB access? → Check `smithers --help` during implementation. If available, can restore run-id display in interactive prompt and `status.ts`.
