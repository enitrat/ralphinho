# Research: Preset Factory Extraction (IMP-0006)

## Unit: preset-factory-extraction

**Ticket**: IMP-0006 — Extract shared agent factory from duplicate preset files

---

## Objective

Create `src/workflows/shared/agentFactory.ts` that accepts `{ workspacePolicy, executionPolicy, repoRoot, idleTimeoutMs }` and returns `{ buildSystemPrompt, createClaude, createCodex }`. Refactor both `ralphinho/preset.tsx` and `improvinho/preset.tsx` to call this factory.

---

## Files to Read

| File | Purpose |
|------|---------|
| `src/workflows/ralphinho/preset.tsx` | Current ralphinho preset with duplicated agent factory code |
| `src/workflows/improvinho/preset.tsx` | Current improvinho preset with duplicated agent factory code |
| `src/types/smithers-orchestrator.d.ts` | Type definitions for `ClaudeCodeAgent`, `CodexAgent`, `AgentLike` |
| `src/config/types.ts` | Config types (`ReviewAgentOverride`) |

---

## Current Implementation Analysis

### ralphinho/preset.tsx (lines 24–60) ✓ VERIFIED

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

function buildSystemPrompt(role: string): string {
  return ["# Role: " + role, WORKSPACE_POLICY, EXECUTION_POLICY].join("\n\n");
}

function createClaude(role: string, model = "claude-sonnet-4-6") {
  return new ClaudeCodeAgent({
    model,
    systemPrompt: buildSystemPrompt(role),
    cwd: REPO_ROOT,
    dangerouslySkipPermissions: true,
    timeoutMs: 60 * 60 * 1000,
    idleTimeoutMs: 10 * 60 * 1000,   // 10 min
  });
}

function createCodex(role: string) {
  return new CodexAgent({
    model: "gpt-5.3-codex",
    systemPrompt: buildSystemPrompt(role),
    cwd: REPO_ROOT,
    yolo: true,
    timeoutMs: 60 * 60 * 1000,
    idleTimeoutMs: 10 * 60 * 1000,   // 10 min
    // NOTE: no reasoningEffort param
  });
}
```

### improvinho/preset.tsx (lines 22–63) ✓ VERIFIED

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

function buildSystemPrompt(role: string): string {
  return ["# Role: " + role, WORKSPACE_POLICY, EXECUTION_POLICY].join("\n\n");
}

function createClaude(role: string, model = "claude-sonnet-4-6") {
  return new ClaudeCodeAgent({
    model,
    systemPrompt: buildSystemPrompt(role),
    cwd: REPO_ROOT,
    dangerouslySkipPermissions: true,
    timeoutMs: 60 * 60 * 1000,
    idleTimeoutMs: 15 * 60 * 1000,   // 15 min (DIFFERENT)
  });
}

function createCodex(role: string, model = "gpt-5.4-codex", reasoningEffort?: string) {
  return new CodexAgent({
    model,
    systemPrompt: buildSystemPrompt(role),
    cwd: REPO_ROOT,
    yolo: true,
    timeoutMs: 60 * 60 * 1000,
    idleTimeoutMs: 15 * 60 * 1000,   // 15 min (DIFFERENT)
    ...(reasoningEffort && {
      config: { model_reasoning_effort: reasoningEffort },
    }),
    // NOTE: optional reasoningEffort param present
  });
}
```

---

## Key Differences Between Presets

| Parameter | ralphinho | improvinho |
|-----------|-----------|------------|
| `WORKSPACE_POLICY` text | "Uncommitted changes ... dirty git state" | "review-only by default" |
| `EXECUTION_POLICY` text | "Complete assigned task fully" | "Return only structured output" |
| `idleTimeoutMs` | `10 * 60 * 1000` (10 min) | `15 * 60 * 1000` (15 min) |
| `createCodex` default model | `"gpt-5.3-codex"` | `"gpt-5.4-codex"` |
| `createCodex` `reasoningEffort` | absent | optional `string` param |

---

## Factory Interface Design

Based on IMP-0006 spec and the RFC diff suggestion:

```ts
// src/workflows/shared/agentFactory.ts

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

  function createClaude(role: string, model = "claude-sonnet-4-6") {
    return new ClaudeCodeAgent({
      model,
      systemPrompt: buildSystemPrompt(role),
      cwd: repoRoot,
      dangerouslySkipPermissions: true,
      timeoutMs: 60 * 60 * 1000,
      idleTimeoutMs,
    });
  }

  function createCodex(role: string, model = "gpt-5.4-codex", reasoningEffort?: string) {
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

**Note on ralphinho default Codex model**: ralphinho currently uses `"gpt-5.3-codex"` as the default for `createCodex`, while improvinho uses `"gpt-5.4-codex"`. The factory should use `"gpt-5.4-codex"` as the default (improvinho's version), and ralphinho should explicitly pass `"gpt-5.3-codex"` at call sites — OR the factory's `createCodex` default model should be left as a factory option too. Since the RFC ticket says "only code remaining in each preset should be policy constants and factory invocation", the simplest approach is to keep `"gpt-5.3-codex"` as a call-site override in ralphinho.

---

## Refactored Preset Shapes

### ralphinho/preset.tsx (after refactor)

```ts
import { createAgentFactory } from "../shared/agentFactory";

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

### improvinho/preset.tsx (after refactor)

```ts
import { createAgentFactory } from "../shared/agentFactory";

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

---

## Implementation Notes

1. **`src/workflows/shared/` directory does not exist** — must be created.
2. **`reasoningEffort` support**: The factory's `createCodex` must accept an optional `reasoningEffort?: string` parameter. ralphinho never uses it; improvinho's `createCodex` calls use it (e.g., `createCodex(role, "gpt-5.4", "medium")`).
3. **Codex default model difference**: ralphinho uses `"gpt-5.3-codex"`, improvinho uses `"gpt-5.4-codex"`. The factory should default to `"gpt-5.4-codex"` (the newer version). ralphinho callers that want `"gpt-5.3-codex"` should pass it explicitly. Alternatively, the default can be omitted from the factory and always passed explicitly — but this would add noise. Best: default to `"gpt-5.4-codex"`, pass `"gpt-5.3-codex"` explicitly in ralphinho.
4. **`buildSystemPrompt` usage**: It's used within `createClaude`/`createCodex` internally AND returned from the factory (since ralphinho uses it indirectly through the agent constructors). The factory should return `buildSystemPrompt` for potential direct use.
5. **TypeScript types**: `ClaudeCodeAgent` and `CodexAgent` are from `smithers-orchestrator`. `CodexAgent` constructor takes `Record<string, unknown>` per type def.
6. **No `.tsx` needed**: The new factory file has no JSX — use `.ts` extension.

---

## RFC Compliance Checklist

- [ ] Create `src/workflows/shared/agentFactory.ts`
- [ ] `createAgentFactory` accepts `{ workspacePolicy, executionPolicy, repoRoot, idleTimeoutMs }`
- [ ] Returns `{ buildSystemPrompt, createClaude, createCodex }`
- [ ] `createCodex` return value supports optional `reasoningEffort` parameter
- [ ] `ralphinho/preset.tsx` reduced to: policy constants + factory invocation + remaining workflow code
- [ ] `improvinho/preset.tsx` reduced to: policy constants + factory invocation + remaining workflow code
- [ ] No behavioral changes (same agent options, same prompts)
