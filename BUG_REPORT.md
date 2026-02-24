# Bug Report: `ticket-scheduler` Fails with ZodError on First Run

**Severity:** Critical — workflow cannot start
**Affects:** upstream `evmts/super-ralph` and this fork
**Status:** Pre-existing upstream bug (not introduced by our RFC-001 changes)

---

## Symptom

```
Node: ticket-scheduler
State: failed
Error: ZodError — Invalid input: expected object, received string (path: [])
```

The `ticket-scheduler` node fails immediately on the first loop iteration. `monitor` stays in-progress. No tickets are ever discovered.

---

## Root Cause

**The CLI-generated `workflow.tsx` passes raw agents to `<SuperRalph>`, but `SuperRalph` expects agents wrapped in `{ agent, description, isScheduler? }` objects.**

### What the CLI generates (`src/cli/index.ts`)

```tsx
const planningAgent = choose("claude", "Plan and research next tickets.");
// planningAgent is a ClaudeCodeAgent instance

<SuperRalph
  agents={{
    planning: planningAgent,        // ← raw agent
    implementation: implementationAgent,
    testing: testingAgent,
    reviewing: reviewingAgent,
    reporting: reportingAgent,
  }}
/>
```

### What `SuperRalph.tsx` expects

```ts
agents: Record<string, {
  agent: any;           // ← wrapped under .agent key
  description: string;
  isScheduler?: boolean;
  isMergeQueue?: boolean;
}>
```

### What `resolveAgent` does

```ts
function resolveAgent(pool: AgentPool, agentId: string | undefined): AgentLike {
  if (agentId && pool[agentId]) return pool[agentId].agent; // .agent is undefined on a raw ClaudeCodeAgent
  return Object.values(pool)[0]?.agent;                     // also undefined
}
```

Since the pool entries are raw agent instances (not `{ agent, description }` objects), `pool['planning'].agent` is always `undefined`. `resolveAgent` returns `undefined` for all lookups, including `schedulerAgent`.

---

## How the ZodError Manifests

With `agent={undefined}` on `<Task id="ticket-scheduler">`, Smithers' DOM extractor sees `Boolean(agent) = false`:

```ts
// src/dom/extract.ts
const isAgent = kind === "agent" || Boolean(agent);  // → false
const prompt = isAgent ? String(raw.children ?? "") : undefined;  // → undefined
const staticPayload = isAgent || isCompute
  ? undefined
  : (raw.__smithersPayload ?? raw.__payload ?? raw.children);  // → the full prompt STRING
```

The scheduler prompt (a string) becomes `staticPayload` instead of `prompt`. In the engine:

```ts
} else {
  payload = desc.staticPayload;  // = the 3000-char prompt string
}
```

Then Zod validates the string against `ticketScheduleSchema` (which expects `{ jobs, reasoning, rateLimitedAgents }`):

```
ZodError: Invalid input: expected object, received string (path: [])
```

---

## Confirmation from DB

Querying `_smithers_attempts` for the failing run confirms:

```json
{
  "node_id": "ticket-scheduler",
  "state": "failed",
  "response_text": null,
  "meta_json": {
    "prompt": null,
    "staticPayload": "You are the **scheduler** for an AI-driven development workflow...",
    "outputTable": "ticket_schedule"
  }
}
```

- `prompt: null` — no LLM call was made
- `staticPayload: "You are the scheduler..."` — the prompt string was treated as static data
- `response_text: null` — confirms the agent never ran

The agent pool description in the prompt also reveals the problem:

```
| Agent ID       | Description |
|----------------|-------------|
| planning       | undefined   |   ← .description doesn't exist on a raw ClaudeCodeAgent
| implementation | undefined   |
```

---

## Scope

This affects **all** `bunx github:enitrat/super-ralph` invocations. The CLI path always generates raw agents. The same bug exists in `evmts/super-ralph` upstream.

The README's library usage example also shows raw agents:

```tsx
agents={{
  planning: new CodexAgent({ model: "gpt-5.3-codex", ... }),
  implementation: new ClaudeCodeAgent({ ... }),
  ...
}}
```

This would fail identically.

---

## Fix Options

### Option A — Fix `SuperRalph.tsx` to accept both formats (recommended)

Update `resolveAgent`, `buildAgentPoolDescription`, and the `AgentPool` type to detect whether each entry is a raw agent or a wrapped `{ agent, description }` object:

```ts
function unwrapAgent(entry: any) {
  if (entry && typeof entry === "object" && "agent" in entry) return entry;
  return { agent: entry, description: undefined };
}

function resolveAgent(pool: AgentPool, agentId: string | undefined): AgentLike {
  const entry = agentId ? pool[agentId] : undefined;
  return unwrapAgent(entry ?? Object.values(pool)[0]).agent;
}
```

This is backward compatible — both the CLI output and the README examples work without changes.

### Option B — Fix the CLI to wrap agents

Update `renderWorkflowFile` in `src/cli/index.ts` to wrap agents:

```ts
agents={{
  planning: { agent: planningAgent, description: "Plan and research tickets." },
  implementation: { agent: implementationAgent, description: "Implement with TDD." },
  ...
}}
```

This requires callers who use the library directly to also wrap, so it's more breaking.

### Option C — Fix the README to match the component

Update documentation to show the wrapped format. Still leaves the CLI broken.

---

## Recommendation

**Option A** is the minimal, non-breaking fix. It unblocks `bunx` usage immediately and aligns the component with what both the CLI and README already emit.
