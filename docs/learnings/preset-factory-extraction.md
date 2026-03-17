# Learnings: preset-factory-extraction

## Patterns

### [code-quality] Don't leak internal building blocks through public factory interfaces
When extracting a shared factory, only expose what callers actually consume. Internal helpers like `buildSystemPrompt` that are used only inside the factory's closure should not appear on the returned object's type. Exposing them signals a public contract and invites misuse, while also bloating the interface.
Example: `AgentFactory` return type included `buildSystemPrompt` even though neither consumer preset destructured or called it — it was used only inside `createClaude`/`createCodex`.
Frequency: recurring

### [code-quality] Shared factory defaults should be neutral, not one caller's value
When a factory default only satisfies one of multiple consumers (and the other always overrides it), the default is misleading. Future callers may silently inherit the wrong value. Prefer making the parameter required when there is no safe neutral default, so callers are forced to be explicit.
Example: `createCodex` defaulted to `"gpt-5.3-codex"` which was ralphinho's specific model — improvinho always passed `"gpt-5.4"`. Removing the default and making `model` required was cleaner.
Frequency: recurring

### [code-quality] Fixing one issue can supersede another — check interaction before applying both
When multiple code review issues are raised, verify they don't interact. Applying fix #3 (remove misleading default) made fix #2 (remove redundant explicit arg) a false positive — the arg became required, not redundant. Always reason about combined effect before marking issues as independent.
Example: Issue #2 said ralphinho's explicit `"gpt-5.3-codex"` was redundant noise. Issue #3 removed the factory default. Applying #3 made #2's premise invalid; applying both would cause a type error.
Frequency: recurring

### [testing] New shared modules require unit tests — don't assume callers cover them
Extracting code into a shared module doesn't inherit test coverage from the callers' existing tests. The new module needs its own unit tests verifying its invariants: output correctness, per-caller configuration (e.g. idleTimeoutMs), and forwarded optional fields.
Example: `agentFactory.ts` was extracted without a test file, failing AC#6 (integration/unit smoke tests) and TDD compliance. The fix required a 9-test suite covering system prompt content, timeout propagation, model defaults, and reasoningEffort forwarding.
Frequency: recurring

### [architecture] Preserve caller-specific configuration differences when extracting shared code
When deduplicating two implementations into one factory, audit every parameter difference between them and ensure the factory exposes each as a distinct option. Silently merging differences breaks correctness for one caller.
Example: ralphinho uses `idleTimeoutMs: 10 min`, improvinho uses `15 min`; reasoningEffort is passed by improvinho but not ralphinho. Both differences had to be explicitly threaded through the factory interface.
Frequency: recurring
