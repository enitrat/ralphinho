# Learnings: Workflow Layer Cleanup

## Patterns

### [code-quality] Avoid redundant lookups when the item is already in scope
When iterating with `.map()` or `.forEach()`, the callback parameter _is_ the current element. Searching the same array to find it again (e.g., `items.find(x => x.id === current.id)`) is both an unnecessary O(n) scan and a readability hazard — readers wonder if the lookup targets a _different_ collection.
Example: `units.find((x) => x.id === u.id)?.deps ?? []` inside a `.map(u => ...)` — `u.deps ?? []` is equivalent and clearer.
Frequency: recurring

### [code-quality] Verify library defaults before adding defensive fallbacks
Before sprinkling `?? []` or `|| {}` fallbacks, check whether the library already guarantees a safe default. Redundant fallbacks add noise and can mask real bugs (e.g., if the library changes to return `undefined` to signal an error, the fallback silently swallows it).
Example: `ctx.outputs()` in smithers already returns `[]` for missing tables, making `ctx.outputs(table) ?? []` redundant.
Frequency: recurring

### [code-quality] Inline trivial wrappers that add no abstraction value
Single-use wrapper functions that just forward arguments to another function add indirection without benefit. When removing dead code, audit whether remaining wrappers still justify their existence or can be inlined at all call sites.
Example: Removing a wrapper in ScheduledWorkflow and inlining the logic at all 7 call sites simplified the code with no behavioral change.
Frequency: recurring

### [testing] Prefer behavioral tests over type-export tests
Tests that only verify a type is exported or a function signature matches provide no value — the TypeScript compiler already enforces this. Focus test effort on edge-case behaviors (eviction, dependency blocking, invalidated state transitions).
Example: State tests covering eviction, dependency blocking, invalidated approvals, and semantic completion are high-value; a test asserting `typeof getDecisionAudit === 'function'` is waste.
Frequency: recurring

### [architecture] Tighten row types by removing optional modifiers on required fields
When fields are always present at runtime, marking them optional (`field?: T`) in the type definition hides bugs — callers add unnecessary null checks or skip validation. During cleanup passes, audit whether optional modifiers reflect true optionality or are just legacy caution.
Example: Row types updated to have required fields without optional modifiers, eliminating a class of "possibly undefined" false alarms.
Frequency: recurring
