# Smithers Rendering Patterns

> Distilled knowledge on the three rendering systems (JSX, Effect Builder, TOON) and how they map to our workflow requirements.

## Architecture Overview

All three APIs compile to the **same internal graph** and execute through the same durable engine loop:

```
Build graph → Materialize state from SQLite → Select ready steps → Execute as Effects → Commit → Re-render → Repeat
```

Branch conditions are evaluated at render time. Only the selected branch's tasks appear in the mounted task set. Non-selected branches are **absent from the graph**, not merely skipped at runtime.

Step states: `pending → ready → running → completed | failed | cancelled | skipped`

---

## 1. JSX API

### Setup

```tsx
/** @jsxImportSource smithers-orchestrator */
import {
  createSmithers, Task, Sequence, Parallel,
  Branch, Loop, Worktree, MergeQueue, Approval,
} from "smithers-orchestrator";

const { Workflow, smithers, outputs } = createSmithers({ schemaKey: zodSchema });

export default smithers((ctx) => (
  <Workflow name="my-workflow">...</Workflow>
));
```

### Components

| Component | Key Props | Purpose |
|-----------|-----------|---------|
| `<Task>` | `id`, `output`, `agent`, `skipIf`, `needs`, `dependsOn`, `retries`, `retryPolicy`, `continueOnFail`, `cache`, `timeoutMs`, `needsApproval`, `fallbackAgent`, `label`, `meta` | Unit of work |
| `<Sequence>` | `skipIf` | Sequential execution (implicit in `<Workflow>`) |
| `<Parallel>` | `maxConcurrency`, `skipIf`, `id` | Concurrent execution |
| `<Branch>` | `if` (required), `then` (required), `else`, `skipIf` | Conditional branching |
| `<Loop>` | `until` (required), `maxIterations` (default 5), `onMaxReached`, `id`, `skipIf` | Iterative execution |
| `<Approval>` | `id`, `output`, `request: {title, summary?, metadata?}`, `onDeny` | Durable approval gate |
| `<MergeQueue>` | `maxConcurrency` (default 1), `id`, `skipIf` | Serialized patch application |
| `<Worktree>` | `path` (required), `branch`, `id`, `skipIf` | Isolated JJ worktree for parallel agents |

### Task Modes

```tsx
// Agent mode: agent + string/JSX children = prompt
<Task id="fix" output={outputs.fix} agent={coder}>Fix the bug.</Task>

// Compute mode: no agent + function children
<Task id="calc" output={outputs.calc}>{() => computeResult()}</Task>

// Static mode: no agent + value children
<Task id="config" output={outputs.config}>{staticValue}</Task>
```

### Context API

| Method | Behavior | Use When |
|--------|----------|----------|
| `ctx.output(schema, { nodeId })` | Returns output or **throws** | Certain the task completed |
| `ctx.outputMaybe(schema, { nodeId })` | Returns output or `undefined` | Conditional rendering gates |
| `ctx.latest(table, nodeId)` | Most recent output across iterations | Inside loops |
| `ctx.latestArray(value, zodSchema)` | Parses JSON array through Zod | Extracting structured arrays |
| `ctx.input` | Validated workflow input | Always available |
| `ctx.iteration` | Current loop iteration (0-indexed) | Inside loops |
| `ctx.iterations` | Map of loop IDs to current iteration | Multi-loop workflows |
| `ctx.iterationCount(table, nodeId)` | Count of completed iterations | Loop completion checks |

**Caveat:** `ctx.latest(table, nodeId)` takes the **schema key** (camelCase, e.g. `"finalOutput"`), NOT the SQLite table name (snake_case `"final_output"`).

### Conditional Rendering

#### Inline ternary (simplest)

```tsx
const analysis = ctx.outputMaybe(outputs.analysis, { nodeId: "analyze" });

<Workflow name="code-review">
  <Task id="analyze" output={outputs.analysis} agent={analyst}>Analyze the code.</Task>
  {analysis ? (
    <Task id="fix" output={outputs.fix} agent={coder}>
      Fix issues found: {JSON.stringify(analysis)}
    </Task>
  ) : null}
</Workflow>
```

#### `<Branch>` component

```tsx
<Branch
  if={ctx.output(outputs.triage, { nodeId: "triage" }).severity === "critical"}
  then={
    <Sequence>
      <Task id="hotfix" output={outputs.hotfix} agent={coder}>Apply hotfix.</Task>
      <Task id="deploy" output={outputs.deploy}>Emergency deploy.</Task>
    </Sequence>
  }
  else={
    <Task id="backlog" output={outputs.backlog}>Add to backlog.</Task>
  }
/>
```

#### `skipIf` (on any component)

```tsx
<Sequence key={ticket.id} skipIf={ticketComplete}>
  <Task id={`${ticket.id}:implement`} ...>...</Task>
  <Task id={`${ticket.id}:validate`} ...>...</Task>
</Sequence>
```

#### Dynamic per-unit pipelines (array mapping)

```tsx
{activeUnits.map((unit) => (
  <Sequence key={unit.id}>
    <Task id={`${unit.id}:implement`} output={outputs.implement} agent={coder}>
      Implement {unit.description}
    </Task>
    <Task id={`${unit.id}:validate`} output={outputs.validate} agent={reviewer}>
      Validate implementation of {unit.id}
    </Task>
  </Sequence>
))}
```

---

## 2. Effect Builder API

### Setup

```ts
const MyWorkflow = Smithers.workflow({
  name: "my-workflow",
  input: InputSchema,
}).build(($) => {
  // return a BuilderNode
});

await Effect.runPromise(
  MyWorkflow.execute(new Input({...})).pipe(Effect.provide(AppLive))
);
```

### Builder Primitives

| Primitive | Returns | Purpose |
|-----------|---------|---------|
| `$.step(id, opts)` | `BuilderStepHandle` | Define a task |
| `$.sequence(...nodes)` | `BuilderNode` | Sequential composition |
| `$.parallel(...nodes, opts?)` | `BuilderNode` | Concurrent; `opts: { maxConcurrency? }` |
| `$.loop(opts)` | `BuilderNode` | `{ id?, children, until, maxIterations?, onMaxReached? }` |
| `$.approval(id, opts)` | `BuilderStepHandle` | `{ needs?, request, onDeny? }` |
| `$.match(source, opts)` | `BuilderNode` | Conditional branching on step output |
| `$.component(instanceId, def, params)` | `BuilderNode` | Reusable component reference |

### Step Configuration

```ts
const analyze = $.step("analyze", {
  output: AnalysisSchema,
  run: async ({ input, executionId, stepId, attempt, signal, iteration }) => {
    return { severity: "high", issues: [...] };
  },
  needs: { config: configStep },  // dependency injection
  retry: 3,                        // or Effect Schedule
  retryPolicy: { backoff: "exponential", initialDelayMs: 1000 },
  timeout: 30_000,
  cache: true,
  skipIf: () => false,
});
```

### Conditional Branching: `$.match()`

```ts
const classify = $.step("classify", {
  output: ClassificationSchema,
  run: async ({ input }) => ({ severity: "high" }),
});

return $.match(classify, {
  when: (result) => result.severity === "high",
  then: () => $.step("escalate", {
    output: EscalationSchema,
    run: async (ctx) => ({ action: "page oncall" }),
  }),
  else: () => $.step("auto-fix", {
    output: AutoFixSchema,
    run: async (ctx) => ({ patch: "..." }),
  }),
});
```

`then`/`else` are **lazy thunks** — only the selected branch is evaluated and mounted. Internally compiles to a `MatchNode` that renders via `<Branch>`.

### Internal Types

```ts
type MatchNode  = { kind: "match";  source: BuilderStepHandle; when: (v: any) => boolean; then: () => BuilderNode; else?: () => BuilderNode }
type BranchNode = { kind: "branch"; condition: (ctx: Record<string, unknown>) => boolean; needs?: Record<string, BuilderStepHandle>; then: BuilderNode; else?: BuilderNode }
```

`BranchNode` is created internally when compiling TOON `kind: branch` nodes. `$.match()` creates `MatchNode`. Both render via the same `<Branch>` component.

### Reusable Components

```ts
const ReviewCycle = Smithers.component({
  name: "ReviewCycle",
  params: { content: z.string(), reviewer: z.string() },
}).build(($, params) => {
  const review = $.step("review", { output: ReviewSchema, run: ... });
  return $.match(review, {
    when: (r) => r.approved,
    then: () => $.step("publish", { ... }),
    else: () => $.step("revise", { ... }),
  });
});

// Usage
const techReview = $.component("tech-review", ReviewCycle, {
  content: draftStep,
  reviewer: "senior",
});
```

---

## 3. TOON (Token-Oriented Object Notation)

### Format

Line-oriented, YAML-like indentation. **Not YAML.** Uses explicit array lengths (`[N]`) and tabular `{field}` headers.

### Structure

```toon
name: my-workflow

agents:
  analyst:
    type: claude-code
    model: claude-sonnet-4-20250514
    tools[2]: read,grep
  coder:
    type: claude-code
    model: claude-sonnet-4-20250514
    tools[5]: read,grep,bash,edit,write

input:
  repoPath: string
  targetFile: string

steps[3]:
  - id: analyze
    agent: analyst
    prompt: "Analyze {input.targetFile} for issues."
    output:
      severity: "low" | "medium" | "high"
      issues: string

  - kind: branch
    condition: "{analyze.severity} == 'high'"
    then[1]:
      - id: escalate
        agent: coder
        prompt: "Escalate: {analyze.issues}"
        output:
          action: string
    else[1]:
      - id: auto-fix
        agent: coder
        prompt: "Auto-fix: {analyze.issues}"
        output:
          patch: string

  - id: report
    prompt: "Summarize outcome."
    output:
      summary: string
```

### Control Flow Nodes

```toon
# Parallel
- kind: parallel
  children[2]:
    - id: task-a
      ...
    - id: task-b
      ...

# Loop
- kind: loop
  until: "{review.approved} == true"
  maxIterations: 3
  children[2]:
    - id: implement
      ...
    - id: review
      ...

# Branch
- kind: branch
  condition: "{triage.severity} == 'high'"
  then[1]:
    - id: escalate
      ...
  else[1]:
    - id: auto-fix
      ...

# Approval
- kind: approval
  id: deploy-gate
  request:
    title: "Approve deployment?"
    summary: "Changes affect production."
  onDeny: fail
```

### Agent Types

`claude-code`, `codex`, `gemini`, `pi`, `kimi`, `forge`, `api`

### Running

```bash
smithers run workflow.toon --input '{"repoPath": ".", "targetFile": "src/main.ts"}'
```

Or from TypeScript:
```ts
const workflow = Smithers.loadToon("./workflow.toon");
```

Compiles to the same internal graph as the Effect builder. No runtime difference.

---

## Comparison Matrix

| Feature | JSX | Effect Builder | TOON |
|---------|-----|----------------|------|
| **Conditional branching** | `{cond ? <A/> : null}`, `<Branch>` | `$.match(step, {when, then, else})` | `kind: branch` + `condition:` |
| **Render-time re-evaluation** | Yes (each frame) | Yes (each frame) | Yes (each frame) |
| **Dynamic array mapping** | `array.map(x => <Task>)` | Manual step generation | Not supported |
| **Output gating** | `ctx.outputMaybe()` | Step `needs` dependency | `{step.field}` interpolation |
| **Reusable components** | React components | `Smithers.component()` | Not supported |
| **skipIf** | All components | Step-level | Step-level |
| **Loops** | `<Loop until={...}>` | `$.loop({until, children})` | `kind: loop` |
| **Approval gates** | `<Approval>` | `$.approval()` | `kind: approval` |
| **Worktrees** | `<Worktree path={...}>` | `WorktreeNode` | Not documented |
| **MDX prompts** | Native support | Via run function | Inline strings only |
| **Best for** | Dynamic/branchy workflows, per-unit pipelines | Explicit graph construction, typed composition | Quick prototyping, non-dev authors |

---

## Choosing the Right System

### Use JSX when:

- The workflow tree changes shape based on prior outputs (conditional subtree mounting)
- You need dynamic per-unit pipeline generation via array mapping
- Prompts benefit from MDX with embedded components
- The author thinks in terms of "if this output exists, mount this task"

### Use Effect Builder when:

- You want explicit, typed graph construction
- The workflow is mostly static with isolated branch points (`$.match()`)
- You're building reusable workflow components (`Smithers.component()`)
- You prefer imperative composition over declarative tree structure

### Use TOON when:

- Non-developers need to author or review workflows
- The workflow is straightforward with minimal dynamic branching
- Quick prototyping before graduating to JSX or Effect builder

---

## Historical Correction

The original `conditional-rendering-requirements.md` concluded that the Effect/builder path could not support render-time branching. This was accurate at the time but is **now outdated**.

The `$.match()` API provides the same render-time branching semantics as JSX conditionals — only the selected branch is mounted, and conditions are re-evaluated each render frame. The choice between JSX and Effect builder is now about **authoring ergonomics**, not capability:

- JSX is more natural for highly dynamic, branchy workflows with array mapping
- Effect builder is more natural for explicit, typed, component-oriented composition
- Both support conditional rendering through the same underlying engine

---

## Project Structure (recommended)

```
workflow/
  workflow.tsx          # Main workflow definition
  agents.ts             # Agent declarations
  schemas.ts            # Zod output schemas
  prompts/              # MDX prompt files
    Analyze.mdx
    Fix.mdx
  components/           # Reusable JSX workflow components
    QualityPipeline.tsx
  lib/                  # Shared utilities
```
