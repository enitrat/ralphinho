# Learnings: Prometheus Endpoint and Agent Pre-flight Diagnostics

## Patterns

### [error-handling] Port binding requires graceful degradation
Network resources like Prometheus metric endpoints can fail to bind (port in use, permissions). Always wrap port binding in try/catch and degrade gracefully (e.g., log a warning and continue without metrics) rather than crashing the process.
Example: `try { server.listen(port) } catch { logger.warn("Metrics endpoint unavailable"); }`
Frequency: recurring

### [testing] Tests must contain real assertions, not just "doesn't throw"
A test that only checks a function doesn't throw provides near-zero confidence. For server lifecycle tests, verify observable side effects — e.g., after `stop()`, assert that connecting to the port is refused.
Example: After calling `server.stop()`, assert `fetch(url)` rejects with connection refused, not just that `stop()` didn't throw.
Frequency: recurring

### [code-quality] Extract shared parsing helpers instead of duplicating inline logic
When multiple modules parse the same config values (e.g., `maxConcurrency` from env vars), extract a single typed helper rather than scattering `parseInt` calls with fallback defaults across files.
Example: `parseIntWithDefault(process.env.MAX_CONCURRENCY, 4)` in a shared utils module.
Frequency: recurring

### [architecture] Register cleanup handlers for long-lived server resources
Background servers (metrics endpoints, health checks) must register cleanup on process exit signals. Otherwise, ports stay bound after the main process finishes, causing failures on restart.
Example: `process.on('exit', () => prometheusServer.close())`
Frequency: recurring

### [performance] Run independent diagnostics in parallel
Pre-flight diagnostic checks (connectivity, auth, resource availability) are typically independent. Use `Promise.all` rather than sequential awaits to reduce startup latency.
Example: `await Promise.all([checkDb(), checkRedis(), checkAuth()])` instead of sequential awaits.
Frequency: recurring

### [code-quality] Avoid unsafe type casts when filtering environment variables
Filtering `process.env` entries can produce `undefined` values. Use explicit type narrowing (e.g., `Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)`) rather than casting with `as`.
Example: Type guard filter instead of `as Record<string, string>`.
Frequency: recurring

### [testing] Feature flags and bypass paths need dedicated test coverage
When a feature has a skip/bypass flag (like `--skip-diagnostics`), write explicit tests verifying the bypass path. These are easy to forget because the "happy path" tests pass without them, but they catch regressions when the flag plumbing changes.
Example: Test that `runWorkflow({ skipDiagnostics: true })` skips diagnostic checks entirely.
Frequency: recurring

### [other] Verify tsconfig path mappings before flagging deep import errors
TS2307 "cannot find module" errors on deep imports (e.g., `smithers-orchestrator/src/agents/diagnostics`) may be false positives if tsconfig has path mappings that resolve them. Always run `bun run typecheck` to verify rather than assuming the import is broken from static analysis alone.
Example: `tsconfig.typecheck.json` with `"smithers-orchestrator/src/*": ["node_modules/smithers-orchestrator/src/*"]` resolves deep imports that look broken in IDE.
Frequency: recurring
