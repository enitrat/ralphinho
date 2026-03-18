# Smithers JJ Base-Branch Sync Bug

## Summary

Smithers auto-syncs existing JJ worktrees before task execution, but the sync target is hardcoded to `main` and the result is ignored.

This breaks workflows that use a different base branch such as `release/*`, `develop`, or any other non-`main` branch.

## Why this matters

Ralphinho already supports a configurable `baseBranch` and passes it into merge and PR logic.

However, the JJ worktree re-entry path in Smithers still does:

- `jj git fetch`
- `jj rebase -d main`

That means pipeline execution base and landing base can diverge.

## Current behavior

Relevant code:

- Existing-worktree sync: `node_modules/smithers-orchestrator/src/engine/index.ts`
- New JJ workspace creation: `node_modules/smithers-orchestrator/src/engine/index.ts`
- Ralphinho configurable base branch: `src/workflows/ralphinho/components/ScheduledWorkflow.tsx`

Observed behavior:

1. If a JJ worktree already exists, Smithers always attempts to rebase it onto literal `main`.
2. Smithers does not inspect the `runJj(...)` result before continuing.
3. If `main` is not the intended base branch, the worktree can be synced to the wrong base.
4. If `main` does not exist, the rebase fails, but the workflow still continues.
5. When creating a new JJ workspace, Smithers does not explicitly create it from the workflow's configured base revision.

## Expected behavior

For JJ worktrees, Smithers should:

1. Sync against the workflow's configured base revision, not hardcoded `main`.
2. Fail loudly if the sync step fails.
3. Create new worktrees from the configured base revision explicitly.

More concretely, existing JJ worktrees should do something like:

```bash
jj workspace update-stale
jj git fetch
jj rebase -b bookmark("<unit-branch>") -d <base-branch>
```

And task execution should stop if any of those steps fails.

## Impact

This can cause:

- silent sync failures
- inconsistent ancestry between pipeline execution and merge queue landing
- retries on a branch based on the wrong upstream branch
- confusing behavior in repos that do not use `main`

## Validated local observation

On a repository whose only base branch is `release`, this command fails:

```bash
jj rebase -d main
```

With:

```text
Error: Revision `main` doesn't exist
```

Exit code:

```text
1
```

That confirms the hardcoded Smithers sync can be invalid in a real JJ repo layout.

## Small MRE

This MRE is intentionally black-box. It does not require agents. It only demonstrates that:

- the repo base branch is `release`
- Smithers re-enters an existing JJ worktree
- the engine's built-in sync is still based on `main`
- the run continues even though `jj rebase -d main` would be invalid in this repo

### 1. Create a repo that uses `release`, not `main`

```bash
tmp="$(mktemp -d)"
git init --bare "$tmp/remote.git"
git init -b release "$tmp/repo"
cd "$tmp/repo"

git config user.email test@example.com
git config user.name test

echo base > README.md
git add README.md
git commit -m "init"

git remote add origin "$tmp/remote.git"
git push -u origin release

jj git init --colocate
```

### 2. Save this as `mre.tsx`

```tsx
import React from "react";
import { z } from "zod";
import { createSmithers, runWorkflow, Worktree, Task } from "smithers-orchestrator";

const wt = `${process.cwd()}/.mre-wt`;

const { smithers, outputs } = createSmithers(
  {
    probe: z.object({
      status: z.string(),
    }),
  },
  { dbPath: "./mre.db" },
);

const workflow = smithers(() => (
  <Worktree path={wt} branch="unit/demo">
    <Task id="probe" output={outputs.probe}>
      {async () => ({ status: "ok" })}
    </Task>
  </Worktree>
));

await runWorkflow(workflow, {
  input: {},
  rootDir: process.cwd(),
});

console.log("workflow run completed");
```

### 3. Run it twice

```bash
bun run ./mre.tsx
bun run ./mre.tsx
```

### 4. Validate the repo shape manually

This repo has no `main`, so the Smithers JJ re-entry sync target is invalid:

```bash
jj rebase -d main
```

Expected output:

```text
Error: Revision `main` doesn't exist
```

### What the MRE demonstrates

The second workflow run re-enters an existing JJ worktree. Smithers currently attempts a built-in sync to `main` for existing JJ worktrees. In this repo shape, that target is invalid, yet the workflow still completes because the engine does not fail the run on sync failure.

## Suggested fix

The simplest fix is to make worktree sync a real workflow invariant at the Smithers layer:

- add a JJ worktree sync target parameter, e.g. `baseBranch` or `baseRev`
- use that value instead of hardcoded `main`
- check `runJj(...)` results and abort on failure
- create new JJ workspaces from the configured base revision explicitly

That keeps branch hygiene in the worktree layer rather than pushing it into agent prompts.
