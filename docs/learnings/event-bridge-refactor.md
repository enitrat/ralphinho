# Learnings: event-bridge-refactor

## Patterns

### [error-handling] Prefer try/catch over existsSync TOCTOU guards
When checking whether a file or database exists before opening it, using `existsSync` followed by the operation introduces a TOCTOU (Time-Of-Check-Time-Of-Use) race: the file could be deleted or created between the check and the operation. Prefer attempting the operation directly and catching `ENOENT` or the equivalent error instead.
Example: Replace `if (existsSync(path)) { readFile(path) }` with `try { readFile(path) } catch (e) { if (e.code !== 'ENOENT') throw e }`. Same applies to SQLite: `new Database(path)` already throws when file is absent — no guard needed.
Frequency: recurring

### [performance] Cache derived values at loop entry, not on each access
When iterating over rows and computing a derived value (e.g., `parseObjectArray(row.tickets_evicted)`) more than once inside the same iteration, compute and assign it once at the top of the loop body. Redundant calls are easy to miss because they look like cheap property accesses but may involve JSON.parse or other non-trivial work.
Example: `const evicted = parseObjectArray(row.tickets_evicted)` at the top of the loop, then reference `evicted` instead of calling `parseObjectArray(row.tickets_evicted)` again at line 315.
Frequency: recurring

### [code-quality] Use boolean state for boolean semantics
A numeric variable (e.g., a count) used only in a boolean context (`count === 0`) should be declared as a boolean from the start, or converted to one at assignment. Numeric-sentinel state misleads readers about its actual role and can mask bugs if the variable is later used arithmetically by mistake.
Example: `scheduledRowsCount` was used only as `scheduledRowsCount === 0` — prefer `const hasScheduledRows = rows.length > 0` or just inline the boolean expression.
Frequency: recurring

### [code-quality] Apply extracted helpers exhaustively — partial adoption is worse than none
When a helper is extracted to replace a repeated pattern (e.g., `queryRows` to replace inline try/catch + safeParse), it must be applied to every instance of that pattern in scope, not just the convenient ones. Partial adoption leaves the codebase in an inconsistent state: readers cannot tell whether the skipped blocks are intentional exceptions or oversights, and future contributors may copy the old pattern rather than the new one.
Example: `queryRows` was applied to 4 of 6 DB-poll blocks; `_smithers_nodes` and `_smithers_attempts` kept the old inline pattern, causing the final review to mark criterion 1 as materially unmet.
Frequency: recurring

### [code-quality] Trust type narrowing — don't add redundant coercions after filters
After a `.filter()` that narrows a property to a specific type, downstream code inside the same chain already has that type guarantee. Wrapping with `String(x)` or similar coercions after the filter is noise that undermines trust in the type system and can mislead reviewers into thinking the narrowing isn't happening.
Example: `.filter((unit) => typeof unit?.id === 'string')` narrows `unit.id` to `string`; the subsequent `name: String(unit.id)` should be `unit.id as string` (or just `unit.id` if TypeScript infers it correctly).
Frequency: recurring

### [architecture] Define refactoring scope exhaustively before implementation
When a task describes a pattern replacement (e.g., "replace all DB-polling try/catch blocks"), audit every occurrence of the pattern before writing any code. List each site explicitly in the plan and track which ones have been migrated. This prevents partial completion being marked as complete in self-review and avoids rejection at final review.
Example: The task referenced "5 DB-poll blocks + 3 parseObjectArray blocks" but only 4 blocks were migrated. An upfront grep/search for the pattern would have surfaced all 6 sites before implementation.
Frequency: recurring
