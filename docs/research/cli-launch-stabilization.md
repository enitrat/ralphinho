# Research: CLI Launch Stabilization

**Unit:** cli-launch-stabilization
**Phase:** Phase 1 — Stabilize CLI Launch and Resume Integration

---

## Summary

This unit aims to harden the Smithers CLI launch path and resume integration in `super-ralph-lite`. The key goals are:

1. Replace fragile source-tree path guessing in `findSmithersCliPath` with stable `bin`/`package.json` resolution.
2. Remove direct `_smithers_runs` SQLite queries from `shared.ts` and `run.ts` (functions: `checkResumeCompatibility`, `loadRunMetadata`, `getLatestRun`, `readCurrentResumeMetadata`).
3. Extract all Smithers process-launch logic into a new `src/runtime/smithers-launch.ts` module.
4. Simplify resume in `run.ts` to a thin preflight that delegates validity to Smithers.
5. Clean up `importPrefix` detection logic in `render-scheduled-workflow.ts`.
6. Write unit tests for bin resolution and launch config building.

---

## RFC Specification

**NOTE:** `/Users/msaug/zama/super-ralph-lite/UPDATE_PLAN.md` does not exist on disk. The unit description above (from the workflow ticket) serves as the specification. No external RFC document was found.

---

## Relevant Files

### `src/cli/shared.ts` — Core problem file

**Path:** `/Users/msaug/zama/super-ralph-lite/src/cli/shared.ts`

**Current issues:**

#### `findSmithersCliPath` (lines 332–352)
Guesses the CLI path by trying 3 hard-coded candidates:
```ts
const candidates = [
  join(repoRoot, "node_modules/smithers-orchestrator/src/cli/index.ts"),
  resolve(dirname(import.meta.path), "../../node_modules/smithers-orchestrator/src/cli/index.ts"),
  join(process.env.HOME || "", "smithers/src/cli/index.ts"),  // HOME-relative dev path
];
```
The third candidate (`~/smithers/src/cli/index.ts`) is a developer-local path that will never work in a user install.

**Stable alternative:** Read `node_modules/smithers-orchestrator/package.json` → `bin.smithers` field. The installed package already declares:
```json
"bin": { "smithers": "src/cli/index.ts" }
```
So the correct path is always `join(smithersPkgDir, pkg.bin.smithers)`.

#### SQLite `_smithers_runs` queries (lines 463–591)
Four functions query Smithers' internal SQLite DB directly:
- `loadRunMetadata(dbPath, runId)` — queries `_smithers_runs` by run_id
- `getLatestRun(dbPath)` — queries `_smithers_runs ORDER BY rowid DESC LIMIT 1`
- `readCurrentResumeMetadata(opts)` — reads current VCS state + workflow hash
- `checkResumeCompatibility(opts)` — compares stored vs current metadata

These functions re-implement durability checks that Smithers itself owns. They create tight coupling to Smithers' internal DB schema.

#### `launchSmithers` (lines 593–659)
Launches `bun --no-install -r <preload> <smithersCli> run|resume ...`.
Uses `ralphSourceRoot` / `runningFromSource` to determine `execCwd`.
This logic is entangled with shared.ts and should live in a dedicated `src/runtime/smithers-launch.ts`.

#### Supporting types (lines 354–377)
`StoredRunMetadata`, `ResumeMetadata`, `ResumeCompatibility` — will be deleted or moved when SQLite queries are removed.

---

### `src/cli/run.ts` — Resume logic file

**Path:** `/Users/msaug/zama/super-ralph-lite/src/cli/run.ts`

**Current issues:**

- Imports and calls `checkResumeCompatibility`, `getLatestRun`, `loadRunMetadata` from `shared.ts` (lines 14–21).
- The resume path (lines 82–116) does a full preflight check against `_smithers_runs` before delegating to Smithers.
- The `--force` resume path (lines 119–148) also calls `checkResumeCompatibility`.
- The interactive resume path (lines 160–186) also calls `checkResumeCompatibility`.

**Target behavior:** The resume preflight in `run.ts` should be a thin pass-through that either:
- Verifies the run-id looks valid (format check only), OR
- Delegates validity checks entirely to Smithers (let Smithers return non-zero exit code if incompatible).

The `launchAndReport` helper (lines 233–250) calls `launchSmithers` — this import should come from the new `src/runtime/smithers-launch.ts`.

---

### `src/cli/render-scheduled-workflow.ts` — importPrefix logic

**Path:** `/Users/msaug/zama/super-ralph-lite/src/cli/render-scheduled-workflow.ts`

**Current issues (lines 17–29):**
```ts
const isLibRepo =
  existsSync(join(repoRoot, "src/components/ScheduledWorkflow.tsx")) &&
  existsSync(join(repoRoot, "src/scheduled/schemas.ts"));

let importPrefix: string;
if (isLibRepo) {
  importPrefix = "../../src";
} else if (runningFromSource) {
  importPrefix = ralphSourceRoot + "/src";
} else {
  importPrefix = "super-ralph";
}
```

Three branches collapsed to two:
- `isLibRepo` is true only when the *target repo* happens to be `super-ralph-lite` itself (i.e., during library development). This is essentially the same as `runningFromSource`.
- The two source-mode branches can be collapsed: if either `isLibRepo` or `runningFromSource`, use the absolute source path.
- Otherwise (normal user install), use `"super-ralph"` package name.

The relative path `"../../src"` is fragile — it depends on the generated file being written to `.ralphinho/generated/workflow.tsx` (two levels deep). Using the absolute `ralphSourceRoot + "/src"` path is safer.

---

### `package.json` — bin field

**Path:** `/Users/msaug/zama/super-ralph-lite/package.json`

```json
{
  "bin": { "ralphinho": "src/cli/ralphinho.ts" }
}
```

The `super-ralph` package itself exposes a single binary: `ralphinho`. The `smithers-orchestrator` peer dep exposes `smithers: src/cli/index.ts`.

---

### `node_modules/smithers-orchestrator/package.json` — stable bin path

```json
{
  "bin": { "smithers": "src/cli/index.ts" }
}
```

When `smithers-orchestrator` is installed, its `bin` field provides the stable, canonical path to the CLI entry point. Resolution:

```ts
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const smithersPkg = require.resolve("smithers-orchestrator/package.json");
const smithersDir = dirname(smithersPkg);
const smithersCliPath = join(smithersDir, pkg.bin.smithers);
```

Or using `import.meta.resolve`:
```ts
const smithersPkgJson = await import("smithers-orchestrator/package.json", { assert: { type: "json" } });
```

---

## Architecture for New Module: `src/runtime/smithers-launch.ts`

This module should consolidate:

1. **`findSmithersCliPath`** — stable bin resolution via `package.json`
2. **`buildLaunchConfig`** — construct `bun` args + env from options
3. **`launchSmithers`** — spawn the process and return exit code

The module should NOT contain any SQLite queries.

**Proposed API:**
```ts
// src/runtime/smithers-launch.ts

export type LaunchMode = "run" | "resume";

export type LaunchOptions = {
  mode: LaunchMode;
  workflowPath: string;
  repoRoot: string;
  runId: string;
  maxConcurrency: number;
  force?: boolean;
};

export type LaunchConfig = {
  cmd: string[];          // ["bun", "--no-install", ...]
  cwd: string;
  env: Record<string, string>;
};

export function resolveSmithersCliPath(fromDir?: string): string | null;
export function buildLaunchConfig(opts: LaunchOptions & { smithersCliPath: string }): LaunchConfig;
export async function launchSmithers(opts: LaunchOptions & { smithersCliPath: string }): Promise<number>;
```

---

## Simplified Resume Flow in `run.ts`

After the refactor, the resume path in `run.ts` should:

1. Check that `workflowPath` and `dbPath` exist (filesystem check only).
2. Pass `runId` directly to Smithers via `launchSmithers({ mode: "resume", runId, ... })`.
3. Let Smithers validate the run ID and return non-zero if incompatible.

The `--force` flag becomes a Smithers-level flag passed through, not a client-side re-check.

No SQLite queries should remain in `run.ts`.

---

## Unit Tests to Write

Per the ticket, tests should cover:
1. **Bin resolution** — `resolveSmithersCliPath` with mocked filesystem
2. **Launch config building** — `buildLaunchConfig` with various option combinations
3. **Test file location:** `src/runtime/smithers-launch.test.ts` or `test/smithers-launch.test.ts`

Test framework: Bun test (`bun:test`).

---

## File Change Summary

| File | Change |
|------|--------|
| `src/cli/shared.ts` | Remove: `findSmithersCliPath`, `loadRunMetadata`, `getLatestRun`, `readCurrentResumeMetadata`, `checkResumeCompatibility`, `launchSmithers`, and related types |
| `src/cli/run.ts` | Remove SQLite resume checks; simplify resume to thin preflight; import launch from `src/runtime/smithers-launch` |
| `src/cli/render-scheduled-workflow.ts` | Collapse `isLibRepo` + `runningFromSource` branches in `importPrefix` detection |
| `src/runtime/smithers-launch.ts` | **NEW**: bin resolution, launch config building, process launch |
| `src/runtime/smithers-launch.test.ts` | **NEW**: unit tests for bin resolution and launch config |

---

## Open Questions

1. **UPDATE_PLAN.md not found**: The RFC spec path referenced in the ticket (`/Users/msaug/zama/super-ralph-lite/UPDATE_PLAN.md`) does not exist. The unit description itself serves as the spec.
2. **Resume without DB**: If SQLite queries are removed, how does `run.ts` determine whether to show the "found existing run" prompt? Possibly check for existence of `workflow.db` only (not query it).
3. **Smithers resume API**: Does Smithers' `resume` subcommand accept a run-id it can't find and exit with a specific non-zero code that `run.ts` can detect and format usefully?
4. **getLatestRun removal**: The interactive "resume previous run" prompt currently shows the `latestRunId`. If we stop querying SQLite, this display is lost. Is there an alternative (e.g., Smithers `list` subcommand)?
5. **`runningFromSource` in render-scheduled-workflow**: After the `importPrefix` simplification, should `runningFromSource` be exported from `src/runtime/smithers-launch.ts` instead of `shared.ts`?
