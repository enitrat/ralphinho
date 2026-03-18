# Smithers Nested `<Loop>` / `<Ralph>` Rejected Despite `<Sequence>` Separator

## Summary

Smithers rejects any `<Loop>` (aka `<Ralph>`) nested inside another `<Loop>`, even when separated by `<Sequence>` or other structural nodes. The guard checks a single `ralphId` flag that propagates through the entire subtree with no reset.

The author suggested this pattern should work, but it does not on the current version.

## Why this matters

A common orchestration pattern is an outer retry loop (e.g. "keep going until all units are done") containing an inner review loop per unit (e.g. "review → fix → re-review until LGTM"). This is the exact pattern Ralphinho uses:

```
<Loop id="outer-ralph-loop">          ← outer: iterate until all units landed
  <Sequence>
    <QualityPipeline>                  ← per-unit pipeline
      <ReviewLoop>
        <Loop id="review-loop">       ← inner: review/fix cycle
          ...
        </Loop>
      </ReviewLoop>
    </QualityPipeline>
  </Sequence>
</Loop>
```

## Current behavior

Relevant code:

- Extract-phase guard: `node_modules/smithers-orchestrator/src/dom/extract.ts:146-148`
- Scheduler-phase guard: `node_modules/smithers-orchestrator/src/engine/scheduler.ts:72-73`
- `Loop` component emits `smithers:ralph` tag: `node_modules/smithers-orchestrator/src/components/Ralph.ts:14`

Both `extract.ts` and `scheduler.ts` track a single `ralphId` / `inRalph` flag. Once set by an outer `<Loop>`, it propagates into all descendants. Any descendant `<Loop>` triggers the error unconditionally — `<Sequence>`, `<Parallel>`, custom components, etc. do not reset the flag.

### extract.ts (line 146)

```ts
if (node.tag === "smithers:ralph") {
  if (ralphId) {
    throw new Error("Nested <Ralph> is not supported.");
  }
  // ...
  ralphId = id;  // set for all descendants
}
```

### scheduler.ts (line 72)

```ts
if (ctx.inRalph && tag === "smithers:ralph") {
  throw new Error("Nested <Ralph> is not supported.");
}
// ...
const nextInRalph = ctx.inRalph || tag === "smithers:ralph";
```

## Expected behavior

The author's stated expectation:

> Direct nesting is unsupported (because it indicates a bug) but you can do this:
>
> ```tsx
> <Ralph id="outer" until={false}>
>   <Sequence>
>     <Ralph id="inner" until={innerFinished}>
>       <Task id="innerTask" output={outputs.outputA}>
>         {{ value: 1 }}
>       </Task>
>     </Ralph>
>   </Sequence>
> </Ralph>
> ```

This implies that nesting through a structural node like `<Sequence>` should be allowed. The current code does not distinguish between direct nesting (`<Ralph><Ralph>`) and indirect nesting (`<Ralph><Sequence><Ralph>`).

## Impact

- Prevents multi-level loop patterns (outer orchestration + inner review/retry)
- Forces workarounds like flattening loops into a single outer loop with manual iteration tracking
- Ralphinho's `ScheduledWorkflow` + `ReviewLoop` composition is broken by this

## MRE

### Save as `mre-nested-ralph.tsx`

```tsx
import React from "react";
import { z } from "zod";
import {
  createSmithers,
  Sequence,
  Loop,
  Task,
  runWorkflow,
  type AgentLike,
} from "smithers-orchestrator";

const { smithers, outputs, Workflow } = createSmithers(
  { outputA: z.object({ value: z.number() }) },
  { dbPath: "/tmp/mre-nested-ralph.db" },
);

const stubAgent: AgentLike = {
  id: "stub",
  generate: async () => ({ value: 1 }),
};

const workflow = smithers((ctx) => {
  const innerResult = ctx.latest("outputA", "innerTask");
  const innerFinished = innerResult != null;

  return (
    <Workflow name="nested-ralph-mre">
      <Loop id="outer" until={false} maxIterations={2} onMaxReached="return-last">
        <Sequence>
          <Loop id="inner" until={innerFinished} maxIterations={2} onMaxReached="return-last">
            <Task id="innerTask" output={outputs.outputA} agent={stubAgent}>
              Return a JSON object with a "value" field set to 1.
            </Task>
          </Loop>
        </Sequence>
      </Loop>
    </Workflow>
  );
});

const result = await runWorkflow(workflow, { input: {} });
console.log("status:", result.status);
```

### Run

```bash
rm -f /tmp/mre-nested-ralph.db
bun run mre-nested-ralph.tsx
```

### Observed output

```
level=ERROR  message="workflow run failed with unhandled error"  error="Nested <Ralph> is not supported."
```

The workflow fails immediately during the extract phase, before any task executes.

### What the MRE demonstrates

- Two `<Loop>` nodes with distinct `id`s
- Separated by a `<Sequence>` (not directly nested)
- Smithers still rejects this as "nested `<Ralph>`"
- The `ralphId` flag propagates through `<Sequence>` without reset

## Suggested fix

The simplest fix is to scope `ralphId` per loop level rather than using a single boolean/string flag:

**Option A — Allow nesting through structural nodes:**

In `extract.ts`, only reject when a `smithers:ralph` is a **direct child** of another `smithers:ralph` (no intervening structural node). Reset `ralphId` when entering structural nodes like `smithers:sequence` or `smithers:parallel`.

**Option B — Use a stack instead of a flag:**

Replace `ralphId: string | undefined` with `ralphStack: string[]`. Each `<Loop>` pushes its id. Tasks use the top of the stack for their iteration context. Direct nesting (stack depth increases by 2 without a structural node) can still be rejected.

Either approach preserves the "direct nesting = bug" invariant while enabling the outer-loop + inner-review-loop pattern.
