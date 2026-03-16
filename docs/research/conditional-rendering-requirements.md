# Conditional Rendering Requirements

## Purpose

This note captures the requirements behind the old Ralph-style conditional rendering model and why we did **not** use the Smithers Effect/builder pattern for that specific behavior.

## What We Needed

The old workflow relied on these properties:

1. The workflow tree had to be able to change after prior steps completed.
2. Later steps had to appear only when earlier outputs existed.
3. Gating had to work naturally inside Ralph loops and multi-pass workflows.
4. A skipped branch needed to be absent from the rendered graph, not merely present with ad hoc runtime checks.
5. The workflow authoring model needed to support per-unit subpipelines being mounted from current durable state.

In practice, that meant we needed:

- Render-time branching.
- Re-render after persisted outputs land.
- `ctx.outputMaybe(...)`-style same-render gating.
- Natural conditional mounting of subtrees like `<Branch>`, `{condition ? <Task /> : null}`, and mapped per-unit pipelines.

## What The Old Workflow Was Doing

The old JSX workflow was not a fixed static graph.

It:

- Read the work plan.
- Classified units as done, blocked, or active.
- Mounted quality-pipeline subtrees only for active units.
- Skipped or re-mounted stages depending on current outputs and pass state.
- Re-rendered after outputs were written, so newly satisfied conditions could mount new tasks.

That is the core behavior people were referring to when they talked about Ralph conditional rendering.

## Why We Did Not Use The Effect Pattern Here

The Effect/builder path is explicit and static enough that it is the wrong fit for this requirement set.

### 1. We needed render-time subtree mounting, not only explicit state reads

The JSX renderer gives us a component tree that can be re-rendered against durable state. That makes patterns like:

- `const x = ctx.outputMaybe(...)`
- `x ? <Task ... /> : null`
- `<Branch if={...} then={...} else={...} />`

first-class.

The builder pattern is better when the graph is known up front and you want explicit imperative composition. It does not give the same “re-render and mount newly valid nodes” model as the JSX tree.

### 2. Our gating was based on output existence, not just booleans computed ahead of time

The old behavior depended on the fact that a task could be absent on the first render, then appear on a later render once an upstream output existed.

That is exactly what `ctx.outputMaybe(...)` is good at. It is not just a convenience API; it is tied to the JSX renderer’s render/re-render model.

The builder approach can read prior state explicitly, but that is a different abstraction:

- more manual
- less local
- less natural for conditional subtree expression
- worse fit for authoring branchy pipelines inline

### 3. We needed dynamic per-unit pipeline generation from current workflow state

The old workflow effectively mapped current active units into mounted subpipelines.

That is straightforward in JSX:

- iterate units
- return `null` for inactive ones
- mount `<QualityPipeline />` for active ones

In the builder model, that becomes explicit graph construction logic rather than render-time conditional composition. That is possible, but it is not the same pattern, and it is not the pattern we were trying to preserve.

### 4. We wanted control-flow semantics to stay close to the author’s mental model

For this class of workflow, the author thinks in terms of:

- “if this output exists, mount this task”
- “if this review approved, skip that fix step”
- “for each currently active unit, render a pipeline”

JSX matches that mental model directly. The Effect/builder pattern makes those same behaviors feel like explicit orchestration code rather than declarative conditional structure.

## Why This Was Not Just A TOON Problem

TOON was the clearest mismatch because its step structure is static and declarative.

But the underlying reason was broader: the behavior we wanted was specifically tied to the JSX renderer’s render-time branching model, not merely to “using TypeScript” or “using Effect”.

So the issue was not:

- “Effect is bad”

It was:

- “this requirement depends on JSX-style re-rendered conditional subtree mounting”

and that is not the natural model of the builder path.

## Decision

For workflows that depend on Ralph-style conditional rendering, prefer the JSX renderer.

Use the Effect/builder pattern when the workflow benefits more from:

- explicit graph construction
- explicit historical-state reads
- static or mostly static orchestration shape
- direct imperative control over workflow assembly

Do **not** choose the Effect/builder pattern when the key requirement is:

- “nodes should materialize only after prior outputs exist, via render-time branching”

because that is precisely the use case where the JSX renderer is the better fit.
