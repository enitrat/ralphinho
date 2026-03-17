# Research: Refactor decompose.ts — Remove CLI Concerns from Domain Layer

## Ticket
IMP-0011 — decompose.ts mixes CLI presentation (spinner) and raw HTTP calls into a domain module, bypassing the Smithers agent abstraction.

## Problem Summary

`src/workflows/ralphinho/decompose.ts` has two concerns that don't belong in a domain module:

1. **CLI spinner** (lines 91-97): `setInterval` + `process.stdout.write` inside `decomposeRFC()` — pure presentation leaked into domain logic.
2. **Raw HTTP / CLI calls** (lines 157-218): `callAI()` uses direct `fetch()` to `api.anthropic.com` and falls back to `Bun.spawn("claude", ...)` — the only AI call in the codebase that bypasses the Smithers agent abstraction.

## Files to Modify

| File | Role | Lines of Interest |
|------|------|------------------|
| `src/workflows/ralphinho/decompose.ts` | Domain module — RFC decomposition logic | 91-97 (spinner), 157-218 (`callAI`) |
| `src/cli/init-scheduled.ts` | CLI caller — should own presentation | Line 97 (`decomposeRFC` call) |
| `src/cli/plan.ts` | CLI caller — should own presentation | Line 53 (`decomposeRFC` call) |

## Callers of `decomposeRFC`

1. **`src/cli/init-scheduled.ts:97`** — `const { plan, layers } = await decomposeRFC(rfcContent, repoConfig);`
2. **`src/cli/plan.ts:53`** — `const { plan, layers } = await decomposeRFC(rfcContent, repoConfig);`
3. **Re-exported** from `src/workflows/ralphinho/index.ts:29`

Both callers are CLI entry points that already do their own `console.log` presentation. They are the natural home for the spinner.

## Current Architecture

### decompose.ts Structure

```
decomposeRFC(rfcContent, repoConfig) → { plan, layers }
  ├─ buildDecomposePrompt() — pure function, builds prompt string
  ├─ spinner (setInterval + process.stdout.write) — CLI concern
  ├─ callAI(prompt) → string — raw HTTP/CLI concern
  │    ├─ fetch("https://api.anthropic.com/v1/messages") with ANTHROPIC_API_KEY
  │    └─ fallback: Bun.spawn("claude", "--print", ...)
  ├─ JSON parsing + validation
  ├─ DAG validation (validateDAG)
  └─ Schema validation (workPlanSchema.parse)

printPlanSummary(plan, layers) — pure presentation (already separate)
```

### Smithers Agent Pattern (used everywhere else)

From `src/workflows/ralphinho/preset.tsx`:

```typescript
import { ClaudeCodeAgent, CodexAgent, type AgentLike } from "smithers-orchestrator";

// Agents are created with:
new ClaudeCodeAgent({ model, systemPrompt, cwd, ... })
new CodexAgent({ model, systemPrompt, cwd, ... })

// Then passed as props to workflow components
<Task agent={agent} prompt={...} />
```

Key: The Smithers runtime manages agent lifecycle, retries, and output storage. `decompose.ts` bypasses all of this.

### Why decompose.ts is Different

`decompose.ts` runs **before** the Smithers workflow starts. The call chain is:
1. CLI (`ralphinho init ./rfc.md`) → `init-scheduled.ts`
2. `decomposeRFC()` produces a `WorkPlan` (JSON)
3. WorkPlan is written to `.ralphinho/work-plan.json`
4. User reviews, then runs `ralphinho run`
5. **Only then** does Smithers start (via `preset.tsx` → `createSmithers()`)

This means `decomposeRFC` cannot use `SmithersCtx`, `Task`, or the JSX workflow components — those don't exist yet. However, it **can** use the agent classes directly (`ClaudeCodeAgent`) since those are standalone.

## Proposed Refactoring

### 1. Extract Spinner to CLI Callers

Remove the spinner from `decomposeRFC()`. The function becomes a pure async function.

Each caller wraps the call with its own spinner:

```typescript
// In init-scheduled.ts and plan.ts:
const spinner = createSpinner("Decomposing RFC into work units...");
spinner.start();
try {
  const { plan, layers } = await decomposeRFC(rfcContent, repoConfig);
} finally {
  spinner.stop();
}
```

Or inline the raw spinner logic if no spinner utility exists.

### 2. Replace `callAI()` with Smithers Agent Abstraction

**Option A: Use `ClaudeCodeAgent` directly**

```typescript
import { ClaudeCodeAgent } from "smithers-orchestrator";

async function callAI(prompt: string): Promise<string> {
  const agent = new ClaudeCodeAgent({
    model: "claude-sonnet-4-6",
    systemPrompt: DECOMPOSE_SYSTEM_PROMPT,
    cwd: process.cwd(),
    dangerouslySkipPermissions: true,
    timeoutMs: 5 * 60 * 1000,
  });
  return agent.run(prompt);
}
```

**Option B: Accept an `AgentLike` parameter (dependency injection)**

```typescript
export async function decomposeRFC(
  rfcContent: string,
  repoConfig: RepoConfig,
  agent: AgentLike,  // caller provides the agent
): Promise<{ plan: WorkPlan; layers: WorkUnit[][] }>
```

This is cleaner but requires updating callers.

**Option C: Keep raw fetch but document the decision**

If `decompose.ts` should intentionally avoid Smithers dependency (e.g., to stay lightweight for CLI use), add a clear comment:

```typescript
/**
 * NOTE: This module intentionally uses raw fetch() instead of Smithers agents.
 * decompose.ts runs before the Smithers runtime is initialized (during `ralphinho init`),
 * and must remain a lightweight CLI tool without the full Smithers dependency graph.
 */
```

### Recommendation

**Option A** is the best balance: it uses the existing abstraction without requiring a full Smithers runtime. The `ClaudeCodeAgent` class is a standalone wrapper around the `claude` CLI — it doesn't need `createSmithers()` or a database. This aligns with how `preset.tsx` creates agents before the workflow starts.

If `ClaudeCodeAgent` requires features not available pre-workflow (needs investigation), fall back to **Option C** with clear documentation.

## Key Questions to Resolve During Implementation

1. Can `ClaudeCodeAgent.run()` (or equivalent method) be called standalone without a Smithers context? Need to check the smithers-orchestrator API.
2. Does `ClaudeCodeAgent` support returning raw text output (not structured), or does it always write to a Smithers output table?
3. Should `callAI` support the `CodexAgent` fallback pattern (like `chooseAgent` in preset.tsx), or is Claude-only sufficient for decomposition?

## RepoConfig Type Reference

```typescript
// src/cli/shared.ts
export interface RepoConfig {
  projectName: string;
  runner: "bun" | "pnpm" | "yarn" | "npm";
  buildCmds: Record<string, string>;
  testCmds: Record<string, string>;
  packageScripts: Record<string, string>;
}
```

## Files Read

- `src/workflows/ralphinho/decompose.ts` — target file
- `src/cli/init-scheduled.ts` — caller 1
- `src/cli/plan.ts` — caller 2
- `src/workflows/ralphinho/preset.tsx` — Smithers agent pattern reference
- `src/workflows/ralphinho/components/ScheduledWorkflow.tsx` — AgentLike usage
- `src/workflows/ralphinho/types.ts` — WorkPlan/WorkUnit schemas
- `src/cli/shared.ts` — RepoConfig type
- `.tickets/summary.md` — IMP-0011 specification
