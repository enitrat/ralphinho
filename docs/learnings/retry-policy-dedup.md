# Learnings: retry-policy-dedup

## Patterns

### [code-quality] Shared object references create a mutation footgun when deduplicating constants
When refactoring duplicate literal objects into a shared base constant (e.g. `const BASE = {...}; export const A = BASE; export const B = BASE;`), all exported names point to the same object reference. Any consumer mutating a field (e.g. `A.retries = 0`) silently corrupts every alias. Fix by adding `as const` to the base literal or marking all fields `readonly` in the type, so TypeScript rejects mutations at compile time.
Example: `const FAIL_FAST_BASE = { retries: 0, ... } as const;` then `export const IMPLEMENT_RETRY_POLICY = FAIL_FAST_BASE;`
Frequency: recurring

### [code-quality] Prefer `as const` on shared config literals to prevent accidental mutation
Any time a plain object literal is shared across multiple export bindings, mark it `as const`. This both prevents mutation and gives TypeScript narrowed literal types, which improves type-safety downstream without any runtime cost.
Example: `const FAIL_FAST_BASE = { retries: 0, backoff: 'none' } as const;`
Frequency: recurring

### [other] Runtime validators may enforce stricter numeric types than JSON Schema declares
A schema typed as `number` may still be rejected at runtime if the consuming system performs an additional `int` check. When generating or returning numeric values that semantically should be integers (counts, scores, indices), always produce integer literals (e.g. `Math.round(x)` or `x | 0`) rather than floats, even when the schema alone would allow floats.
Example: `qualityScore: Math.round(score)` instead of `qualityScore: score` (which might be 4.7)
Frequency: recurring
