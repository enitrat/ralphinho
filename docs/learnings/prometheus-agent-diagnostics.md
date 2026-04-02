# Learnings: Prometheus Endpoint and Agent Pre-flight Diagnostics

## Patterns

### [error-handling] Port binding needs try/catch with graceful degradation
Server endpoints (Prometheus, health checks, etc.) that bind to ports must wrap binding in try/catch and degrade gracefully rather than crashing the process. A port conflict should log a warning and continue, not abort the entire agent workflow.
Example: Prometheus HTTP server start wrapped in try/catch, falling back to no-metrics mode if port is already in use.
Frequency: recurring

### [testing] Verify side effects with real assertions, not just "no throw"
Tests that only check a function doesn't throw miss actual behavior. For server lifecycle tests (start/stop), assert the real side effect — e.g., verify the port is no longer accepting connections after stop(), rather than just asserting stop() resolved.
Example: After `server.stop()`, attempt a fetch to the port and assert it throws `ECONNREFUSED`.
Frequency: recurring

### [code-quality] Extract shared parsing helpers instead of inline coercion
When multiple modules parse the same config values (e.g., `maxConcurrency` from env vars), extract a shared helper rather than duplicating `parseInt`/validation logic. Inline `as` casts on `process.env` are unsafe — use typed filtering instead.
Example: Shared `parseIntEnv(key, defaultValue)` helper in utils instead of `parseInt(process.env.MAX_CONCURRENCY as string)` scattered across files.
Frequency: recurring

### [performance] Run independent diagnostics in parallel
Pre-flight diagnostic checks (connectivity, auth, config validation) that don't depend on each other should run via `Promise.all` rather than sequentially. This is easy to miss when adding checks incrementally.
Example: `await Promise.all([checkPrometheus(), checkAuth(), checkConfig()])` instead of three sequential awaits.
Frequency: recurring

### [architecture] Register cleanup handlers for server resources on process exit
Long-running server resources (HTTP servers, DB connections, file watchers) must register cleanup on `process.exit`/`SIGTERM`. Without this, ports stay bound after crashes, causing the very port-conflict errors that graceful degradation handles.
Example: `process.on('exit', () => prometheusServer.close())` registered immediately after successful server start.
Frequency: recurring

### [testing] Test flag-based bypass paths, not just happy paths
When a feature has a skip/disable flag (e.g., `--skip-diagnostics`), write explicit tests that the flag actually bypasses the feature. These paths are often untested because they seem trivial, but regressions in flag parsing silently re-enable expensive operations.
Example: Unit test asserting `runWorkflow({ skipDiagnostics: true })` does not invoke any diagnostic check functions.
Frequency: recurring

### [architecture] Verify deep imports resolve under tsconfig path mappings
When importing from a package's internal paths (e.g., `smithers-orchestrator/src/agents/diagnostics`), ensure tsconfig path mappings cover the pattern. Deep imports that work at runtime (via bundler/Node resolution) can fail typecheck without explicit path mapping — and reviewers may flag this as a real error when it's already fixed.
Example: `"smithers-orchestrator/src/*": ["node_modules/smithers-orchestrator/src/*"]` in tsconfig.typecheck.json.
Frequency: recurring
