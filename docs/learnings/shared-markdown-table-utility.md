# Learnings: Extract Shared Markdown Table Builder

## Patterns

### [testing] Shared pure-function modules must ship with unit tests
When extracting utility functions into a shared module, add unit tests in the same PR. Pure functions with multiple code paths (empty inputs, boundary conditions, formatting variants) are the highest-ROI test targets. Reviewers will consistently flag missing tests on shared code, so writing them upfront avoids a review round-trip.
Example: A markdown table builder with paths for empty rows, truncation, multi-column assembly, and index injection — all trivially testable yet shipped without tests.
Frequency: recurring

### [code-quality] Default cosmetic/presentational parameters instead of requiring them
When a parameter is cosmetic and has an obvious default (e.g., markdown separator widths, padding characters), make it optional with a sensible default. Requiring callers to specify values that are always the same adds noise to every call site and increases the chance of inconsistency.
Example: `MarkdownColumn.separator` required callers to manually write `'---'`, `'-----------'` etc. — making it optional with `'---'` default removed noise from all column definitions.
Frequency: recurring

### [code-quality] Extract shared helpers when two consumers duplicate collection logic
When refactoring shared utilities, audit all consumers for duplicated preparation logic (e.g., collecting inputs, normalizing data). If two call sites perform the same transformation before calling your utility, that transformation belongs in the shared module.
Example: Two components both spread `[...filesModified ?? [], ...filesCreated ?? []]` — extracted as `getAllFiles()` helper in the shared module.
Frequency: recurring
