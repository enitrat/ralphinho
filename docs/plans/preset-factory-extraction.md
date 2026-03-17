# Plan: Extract Shared Agent Factory from Duplicate Preset Files

**Unit**: `preset-factory-extraction`
**Ticket**: IMP-0006
**Category**: large

---

## Work Type Assessment

This is **mechanical refactoring** — extracting duplicate code into a shared factory without changing observable behavior. No new features, no bug fixes, no API surface changes. The TypeScript compiler already enforces correctness through `bun run typecheck`.

**TDD does NOT apply.** Justification:
- The three functions being extracted (`buildSystemPrompt`, `createClaude`, `createCodex`) have identical logic before and after the refactor
- No new code paths are introduced — only indirection through a factory closure
- The compiler enforces that the refactored presets call the factory with correct types
- The existing test suite (`src/preset.test.ts`) exercises `loadReviewPreset`/`loadScheduledPreset` which are unaffected
- Runtime behavior of agent instantiation is unchanged (same constructor args, same option values)

Verification strategy: **typecheck passes, existing tests pass, no behavioral delta.**

---

## Current State (✓ VERIFIED)

### `src/workflows/ralphinho/preset.tsx` (lines 24–60)
- Defines `WORKSPACE_POLICY`, `EXECUTION_POLICY` as module-level consts
- Defines `buildSystemPrompt(role)`, `createClaude(role, model?)`, `createCodex(role)` locally
- `idleTimeoutMs: 10 * 60 * 1000` (10 min)
- Codex model hard-coded as `"gpt-5.3-codex"` (no default param)
- No `reasoningEffort` param in `createCodex`

### `src/workflows/improvinho/preset.tsx` (lines 22–63)
- Defines same three functions locally (identical structure, different policy text)
- `idleTimeoutMs: 15 * 60 * 1000` (15 min)
- Codex default model `"gpt-5.4-codex"` with optional `reasoningEffort?: string` param
- `createCodex` spreads `config: { model_reasoning_effort: reasoningEffort }` when truthy

### Key Differences

| Parameter | ralphinho | improvinho |
|-----------|-----------|------------|
| `WORKSPACE_POLICY` | "Uncommitted changes … dirty git state" | "review-only by default" |
| `EXECUTION_POLICY` | "Complete the assigned task fully" | "Return only structured output" |
| `idleTimeoutMs` | `10 * 60 * 1000` | `15 * 60 * 1000` |
| `createCodex` default model | `"gpt-5.3-codex"` (no param) | `"gpt-5.4-codex"` |
| `createCodex` `reasoningEffort` | absent | optional `string` |

### Type Environment (✓ VERIFIED)
- `ClaudeCodeAgent` from `smithers-orchestrator` — constructor takes `ClaudeCodeAgentOptions`
- `CodexAgent` from `smithers-orchestrator` — constructor takes `Record<string, unknown>`
- `src/workflows/shared/` directory does **not** yet exist

---

## Files to Create

### `src/workflows/shared/agentFactory.ts` (NEW)

```ts
import { ClaudeCodeAgent, CodexAgent } from "smithers-orchestrator";

export interface AgentFactoryOptions {
  workspacePolicy: string;
  executionPolicy: string;
  repoRoot: string;
  idleTimeoutMs: number;
}

export interface AgentFactory {
  buildSystemPrompt(role: string): string;
  createClaude(role: string, model?: string): ClaudeCodeAgent;
  createCodex(role: string, model?: string, reasoningEffort?: string): CodexAgent;
}

export function createAgentFactory(options: AgentFactoryOptions): AgentFactory {
  const { workspacePolicy, executionPolicy, repoRoot, idleTimeoutMs } = options;

  function buildSystemPrompt(role: string): string {
    return ["# Role: " + role, workspacePolicy, executionPolicy].join("\n\n");
  }

  function createClaude(role: string, model = "claude-sonnet-4-6"): ClaudeCodeAgent {
    return new ClaudeCodeAgent({
      model,
      systemPrompt: buildSystemPrompt(role),
      cwd: repoRoot,
      dangerouslySkipPermissions: true,
      timeoutMs: 60 * 60 * 1000,
      idleTimeoutMs,
    });
  }

  function createCodex(role: string, model = "gpt-5.4-codex", reasoningEffort?: string): CodexAgent {
    return new CodexAgent({
      model,
      systemPrompt: buildSystemPrompt(role),
      cwd: repoRoot,
      yolo: true,
      timeoutMs: 60 * 60 * 1000,
      idleTimeoutMs,
      ...(reasoningEffort && {
        config: { model_reasoning_effort: reasoningEffort },
      }),
    });
  }

  return { buildSystemPrompt, createClaude, createCodex };
}
```

**Design notes:**
- `createCodex` defaults to `"gpt-5.4-codex"` (improvinho's version, the newer one)
- ralphinho callers that need `"gpt-5.3-codex"` must pass it explicitly at call sites
- The `reasoningEffort` param is always present in the factory signature — ralphinho simply never passes it
- `.ts` extension (not `.tsx`) — no JSX in this file

---

## Files to Modify

### `src/workflows/ralphinho/preset.tsx`

**Remove** (lines 24–60):
- `const WORKSPACE_POLICY = ...`
- `const EXECUTION_POLICY = ...`
- `function buildSystemPrompt(...)`
- `function createClaude(...)`
- `function createCodex(...)`

**Add** (after imports):
```ts
import { createAgentFactory } from "../shared/agentFactory";
```

**Add** (after config constants, before `chooseAgent`):
```ts
const WORKSPACE_POLICY = `
## WORKSPACE POLICY
Uncommitted changes in the worktree are expected and normal.
Do NOT refuse to work because of dirty git state. Proceed with implementation regardless.
`;

const EXECUTION_POLICY = `
## EXECUTION POLICY
Complete the assigned task fully before concluding.
Rely on the task prompt's schema/output instructions; do not invent alternate output wrappers or code-fenced JSON unless the task explicitly asks for them.
`;

const { buildSystemPrompt, createClaude, createCodex } = createAgentFactory({
  workspacePolicy: WORKSPACE_POLICY,
  executionPolicy: EXECUTION_POLICY,
  repoRoot: REPO_ROOT,
  idleTimeoutMs: 10 * 60 * 1000,
});
```

**Update** `chooseAgent` — the `codex` call site must now explicitly pass `"gpt-5.3-codex"`:
```ts
// Before:
const codex = () => createCodex(role);

// After:
const codex = () => createCodex(role, "gpt-5.3-codex");
```

### `src/workflows/improvinho/preset.tsx`

**Remove** (lines 22–63):
- `const WORKSPACE_POLICY = ...`
- `const EXECUTION_POLICY = ...`
- `function buildSystemPrompt(...)`
- `function createClaude(...)`
- `function createCodex(...)`

**Add** (after imports):
```ts
import { createAgentFactory } from "../shared/agentFactory";
```

**Add** (after config constants, before `createOverrideAgent`):
```ts
const WORKSPACE_POLICY = `
## WORKSPACE POLICY
This workflow is review-only by default.
Do not implement fixes unless the task explicitly asks for them.
`;

const EXECUTION_POLICY = `
## EXECUTION POLICY
Return only the structured output that matches the task schema.
Keep evidence concrete, scoped, and fast for humans to triage.
`;

const { buildSystemPrompt, createClaude, createCodex } = createAgentFactory({
  workspacePolicy: WORKSPACE_POLICY,
  executionPolicy: EXECUTION_POLICY,
  repoRoot: REPO_ROOT,
  idleTimeoutMs: 15 * 60 * 1000,
});
```

`createOverrideAgent` and all other call sites of `createClaude`/`createCodex` in improvinho remain unchanged — they already pass explicit model and reasoningEffort args.

---

## Step-by-Step Implementation

1. **Create `src/workflows/shared/` directory** (implicit when creating the file)

2. **Create `src/workflows/shared/agentFactory.ts`** with the factory implementation above

3. **Refactor `src/workflows/ralphinho/preset.tsx`**:
   - Add import for `createAgentFactory`
   - Replace local `buildSystemPrompt`/`createClaude`/`createCodex` definitions with factory invocation
   - Update `chooseAgent`'s `codex` call to pass `"gpt-5.3-codex"` explicitly

4. **Refactor `src/workflows/improvinho/preset.tsx`**:
   - Add import for `createAgentFactory`
   - Replace local `buildSystemPrompt`/`createClaude`/`createCodex` definitions with factory invocation

5. **Run `bun run typecheck`** — must pass with no new errors

6. **Run `bun test`** — existing tests must still pass

---

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| ralphinho callers use `gpt-5.3-codex` implicitly | Medium | Explicitly update `codex = () => createCodex(role, "gpt-5.3-codex")` in `chooseAgent` |
| `buildSystemPrompt` is used in other files | Low | Grep for any external callers before removing — search shows it's file-local in both presets |
| TypeScript can't resolve `../shared/agentFactory` | Low | The `tsconfig.typecheck.json` path coverage must include `src/workflows/shared/**` — standard path resolution will work |
| Factory closure captures stale `repoRoot` | None | `REPO_ROOT` is a module-level `const` read once at load time; closure captures the value correctly |

---

## Acceptance Criteria Verification

| # | Criterion | Verification |
|---|-----------|-------------|
| 1 | New shared factory module exists and exports factory function | File created at `src/workflows/shared/agentFactory.ts` |
| 2 | Neither preset contains local `buildSystemPrompt`, `createClaude`, `createCodex` | Read both files after refactor — confirm no local function definitions |
| 3 | `idleTimeoutMs` difference preserved | ralphinho passes `10 * 60 * 1000`, improvinho passes `15 * 60 * 1000` |
| 4 | `improvinho`'s `createCodex` still accepts optional `reasoningEffort` | Factory's `createCodex(role, model?, reasoningEffort?)` — existing call sites unchanged |
| 5 | `bun run typecheck` passes | Run after each file change |
| 6 | Integration smoke test confirms correct instantiation | Existing `bun test` passes; typecheck confirms agent constructors receive correct option shapes |
