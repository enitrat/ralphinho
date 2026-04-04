# Research: MetricsPanel in Advanced Monitor UI

## Summary

Add a MetricsPanel component to `src/advanced-monitor-ui.ts` that displays token usage and run metrics from PollData fields already implemented by the `observability-core` unit.

## Key Findings

### 1. PollData Already Has Token Fields (✓ VERIFIED)

`src/runtime/projections.ts:50-67` — The `PollData` interface already includes:
- `inputTokensTotal: number` — accumulated input tokens
- `outputTokensTotal: number` — accumulated output tokens
- `cacheReadTokensTotal: number` — accumulated cache read tokens
- `runDurationMs: number` — wall-clock duration from earliest event timestamp

These are populated in `projectEvents()` (line 100-298) by processing `token-usage-reported` events.

### 2. Current Right-Column Layout (✓ VERIFIED)

`src/advanced-monitor-ui.ts:358-412` — The right column (`rightCol`) currently has 4 stacked panels:
1. **Active Jobs** (`jobsBox`) — flexGrow: 1
2. **Event Log** (`eventsBox`) — flexGrow: 2
3. **Logs** (`logsBox`) — flexGrow: 1
4. **Snapshots** (`snapshotsBox`) — flexGrow: 1

All use `BoxRenderable` → `ScrollBoxRenderable` → `TextRenderable` pattern.

### 3. OpenTUI Renderable Pattern (✓ VERIFIED)

Every panel follows the same pattern:
```typescript
const box = new BoxRenderable(renderer, {
  id: "...", border: true, title: " Title ", flexGrow: N,
  flexDirection: "column", borderColor: c.border,
});
rightCol.add(box);

const scroll = new ScrollBoxRenderable(renderer, { id: "...", flexGrow: 1, scrollY: true });
box.add(scroll);
const text = new TextRenderable(renderer, { id: "...", content: "..." });
scroll.add(text);
```

### 4. Focus Cycling (✓ VERIFIED)

`src/advanced-monitor-ui.ts:123` — `MonitorFocus` type: `"pipeline" | "jobs" | "events" | "logs" | "snapshots"`

`src/advanced-monitor-ui.ts:642` — Tab cycles through `["pipeline", "jobs", "events", "logs", "snapshots"]`.

Adding a new panel requires:
- Adding `"metrics"` to `MonitorFocus` type union
- Adding `"metrics"` to the `modes` array in the Tab handler
- Adding border color toggle in `update()` function
- Adding scroll map entry for arrow key scrolling

### 5. Poll Cadence (✓ VERIFIED)

`src/advanced-monitor-ui.ts:691` — Main loop uses 1500ms when jobs active, 3000ms when idle. The metrics panel will auto-update with every `update()` call since it reads from the shared `data: PollData` state.

### 6. Initial PollData State (✓ VERIFIED)

`src/advanced-monitor-ui.ts:286-290` — Default PollData is initialized without token fields. After `observability-core` landed, this initialization needs `inputTokensTotal: 0, outputTokensTotal: 0, cacheReadTokensTotal: 0, runDurationMs: 0`.

### 7. Display Format for Unavailable Data

Per the ticket: "If token data is unavailable (e.g., zero-value PollData), display dashes rather than zeros." This means checking if all token values are 0 and showing `—` instead.

### 8. Active Agent Count and Error Count

PollData provides:
- `activeJobs.length` for active agent count
- No dedicated `errorCount` field — the monitor tracks `lastError` locally (line 296). Error count could be derived from `node-failed` events or tracked as a local counter in the monitor.

The `data.tickets` array contains stage statuses — tickets with `"failed"` stages can be counted. Alternatively, a simple counter incremented in the poll error handler.

## Files to Modify

| File | Changes |
|------|---------|
| `src/advanced-monitor-ui.ts` | Add MetricsPanel (BoxRenderable+TextRenderable), add "metrics" to MonitorFocus, update focus cycling, update `update()` function, add initial PollData token fields |

## Implementation Approach

1. **Add "metrics" to MonitorFocus type** — extend the union type
2. **Create MetricsPanel renderables** — Insert a new `metricsBox` into `rightCol` (at the top, before Active Jobs, since it's a summary panel)
3. **Update the `update()` function** — Add rendering logic that formats token counts, duration, active agents, and error count. Show dashes when values are zero.
4. **Update focus cycling** — Add "metrics" to the Tab cycle array and scroll map
5. **Update border color toggling** — Add metricsBox to the focus border logic
6. **Fix initial PollData** — Add missing token fields to the default state

## Rendering Format

Suggested compact display:
```
Tokens In:  123,456   Out: 45,678
Cache Read: 98,765
Duration:   12m34s
Agents:     3         Errors: 0
```

When all token values are 0:
```
Tokens In:  —         Out: —
Cache Read: —
Duration:   —
Agents:     0         Errors: 0
```

## Dependencies

- **observability-core** unit must be merged first (provides `inputTokensTotal`, `outputTokensTotal`, `cacheReadTokensTotal`, `runDurationMs` on PollData)
- ✓ VERIFIED: These fields already exist on `PollData` interface and are populated in `projectEvents()`

## Open Questions

1. Should the MetricsPanel be at the top or bottom of the right column? (Top makes sense for summary data)
2. Should error count track poll errors only, or also count failed stages across all tickets?
3. Should the panel use a ScrollBoxRenderable or just a fixed-height TextRenderable (since content is small)?
4. The initial `data: PollData` default (line 286-290) is missing the token fields — is this already handled by the observability-core unit or does this unit need to add them?
