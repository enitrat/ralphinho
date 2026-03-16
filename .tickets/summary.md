# Improvinho Review - 2026-03-16

## Critical (0)
No findings.

## High (0)
No findings.

## Medium (1)
### IMP-0001 - Redundant runtime null-check after schema validation already guarantees non-null shape
- Kind: simplification
- Confidence: medium
- Seen by: type-system-purist
- Scopes: src/adapters/linear
- Support count: 1
- Files: src/adapters/linear/mapLinearIssue.ts, src/adapters/linear/mapLinearIssue.ts:42
- Evidence: In mapLinearIssue(), the adapter checks `if (!issue.identifier)` at runtime even though the Zod schema marks `identifier` as `z.string()` (non-optional). Any data reaching this function has already been validated; the guard is unreachable and signals distrust of the validated boundary.
- Accept if: The schema actually marks `identifier` as optional or the function is called from an unvalidated path.

```diff
- if (!issue.identifier) return null;
  // identifier is z.string() — guaranteed non-null by schema; remove guard
```

## Low (1)
### IMP-0002 - Test suite asserts TypeScript export shape rather than observable runtime behaviour
- Kind: test-gap
- Confidence: medium
- Seen by: type-system-purist
- Scopes: src/adapters/linear
- Support count: 1
- Files: src/adapters/linear/linearAdapter.test.ts, src/adapters/linear/linearAdapter.test.ts:15, src/adapters/linear/linearAdapter.test.ts:16
- Evidence: linearAdapter.test.ts contains assertions like `expect(typeof linearAdapter.fetchIssues).toBe('function')` which only verify that a symbol is exported with the right JS type — a guarantee the TypeScript compiler already provides at build time. These tests add no runtime behaviour coverage.
- Dismiss if: If those lines are part of a larger integration test that also asserts return values.

