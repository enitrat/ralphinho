# Plan: MetricsPanel in Advanced Monitor UI

## Overview

Add a `MetricsPanel` to the right-side column of the advanced monitor UI that displays token usage metrics (input, output, cache read tokens), run duration, active agent count, and error count. The panel reads from PollData fields already provided by `observability-core`.

## Work Type Assessment

**TDD applies.** This adds a new visible feature:
- New UI panel with rendering logic
- New formatting helper (`fmtTokenCount`)
- New focus mode (`"metrics"`) changing keyboard navigation
- Conditional display logic (dashes vs. values)

The `renderMonitorSnapshot` function is a pure function (PollData → strings) that can be unit-tested. The panel layout itself is imperative OpenTUI code that will be verified via typecheck + visual inspection.

## Implementation Steps

### Step 1: Write Tests (TDD — Red Phase)

**File:** `src/__tests__/metrics-panel.test.ts` (new)

Tests to write:

1. **`fmtTokenCount` formats large numbers with commas** — e.g., `1234567` → `"1,234,567"`
2. **`fmtTokenCount` returns dash for zero** — `0` → `"—"`
3. **`metricsContent` returns dashes when all token fields are zero** — given PollData with `inputTokensTotal: 0, outputTokensTotal: 0, cacheReadTokensTotal: 0, runDurationMs: 0`, all metric lines show `—`
4. **`metricsContent` formats token counts when data is present** — given PollData with nonzero token fields, output contains formatted numbers
5. **`metricsContent` shows active agent count from activeJobs.length** — with 3 active jobs, shows `"3"`
6. **`metricsContent` shows error count** — tracks cumulative error count
7. **`metricsContent` formats duration as `Xm YYs`** — `runDurationMs: 754000` → `"12m34s"`

### Step 2: Extract `fmtTokenCount` Helper

**File:** `src/advanced-monitor-ui.ts` (modify)

```typescript
function fmtTokenCount(n: number): string {
  if (n === 0) return "—";
  return n.toLocaleString("en-US");
}
```

Add near existing helpers (`fmtElapsed`, `fmtTime`) around line 104-112.

### Step 3: Extract `metricsContent` Pure Function

**File:** `src/advanced-monitor-ui.ts` (modify)

```typescript
export function metricsContent(data: PollData, errorCount: number): string {
  const tokensAvailable = data.inputTokensTotal > 0
    || data.outputTokensTotal > 0
    || data.cacheReadTokensTotal > 0;

  const inTok  = fmtTokenCount(data.inputTokensTotal);
  const outTok = fmtTokenCount(data.outputTokensTotal);
  const cache  = fmtTokenCount(data.cacheReadTokensTotal);
  const dur    = data.runDurationMs > 0 ? fmtElapsed(data.runDurationMs) : "—";
  const agents = String(data.activeJobs.length);
  const errors = String(errorCount);

  return [
    `Tokens In:  ${inTok.padStart(12)}   Out: ${outTok}`,
    `Cache Read: ${cache.padStart(12)}`,
    `Duration:   ${dur.padStart(12)}`,
    `Agents:     ${agents.padStart(12)}   Errors: ${errors}`,
  ].join("\n");
}
```

Export this so tests can import it.

### Step 4: Add `"metrics"` to `MonitorFocus` Type

**File:** `src/advanced-monitor-ui.ts` (modify)

```typescript
// Line 123
type MonitorFocus = "pipeline" | "jobs" | "events" | "logs" | "snapshots" | "metrics";
```

### Step 5: Fix Initial PollData Defaults

**File:** `src/advanced-monitor-ui.ts` (modify)

Add missing token field defaults to the initial state at line 286-290:

```typescript
let data: PollData = {
  tickets: [], activeJobs: [], discovered: 0, landed: 0, semanticallyComplete: 0, evicted: 0,
  inPipeline: 0, maxConcurrency: 0, phase: "starting",
  mergeQueueActivity: null, schedulerReasoning: null, discoveryCount: 0,
  inputTokensTotal: 0, outputTokensTotal: 0, cacheReadTokensTotal: 0, runDurationMs: 0,
};
```

### Step 6: Create MetricsPanel Renderables

**File:** `src/advanced-monitor-ui.ts` (modify)

Insert **before** the Active Jobs panel (after rightCol creation, ~line 365) so it appears at the top of the right column as a summary:

```typescript
// Panel 0: Metrics (compact, no scroll needed — content is 4 lines)
const metricsBox = new BoxRenderable(renderer, {
  id: "metricsBox", border: true, title: " Metrics ", flexGrow: 0,
  flexDirection: "column", borderColor: c.border, height: 6,
});
rightCol.add(metricsBox);

const metricsText = new TextRenderable(renderer, {
  id: "metricsText", content: metricsContent(data, 0),
});
metricsBox.add(metricsText);
```

Using `flexGrow: 0` with fixed `height: 6` (4 content lines + 2 border lines) ensures it doesn't steal space from other panels.

### Step 7: Add Error Counter State

**File:** `src/advanced-monitor-ui.ts` (modify)

Add a local counter near line 296:

```typescript
let errorCount = 0;
```

Increment in the poll error handler (~line 615):

```typescript
} catch (err) {
  errorCount++;
  lastError = `Poll failed: ${err instanceof Error ? err.message : "unknown"}`;
```

### Step 8: Update `update()` Function

**File:** `src/advanced-monitor-ui.ts` (modify)

Add border color toggle for metricsBox (after line 431):

```typescript
metricsBox.borderColor = focus === "metrics" ? c.selected : c.border;
```

Add metrics panel content update (after snapshots panel update, ~line 513):

```typescript
// ── Metrics panel ──
metricsText.content = metricsContent(data, errorCount);
```

### Step 9: Update Focus Cycling

**File:** `src/advanced-monitor-ui.ts` (modify)

Add `"metrics"` to the modes array at line 642:

```typescript
const modes: Array<MonitorFocus> = ["pipeline", "metrics", "jobs", "events", "logs", "snapshots"];
```

No scroll map entry needed since the metrics panel has no ScrollBoxRenderable (content is static 4 lines).

### Step 10: Make Tests Pass (TDD — Green Phase)

Run tests to verify all pass:

```bash
bun test src/__tests__/metrics-panel.test.ts
```

### Step 11: Typecheck

```bash
bun run typecheck
```

## Files to Create

| File | Purpose |
|------|---------|
| `src/__tests__/metrics-panel.test.ts` | Unit tests for `fmtTokenCount` and `metricsContent` |

## Files to Modify

| File | Changes |
|------|---------|
| `src/advanced-monitor-ui.ts` | Add `fmtTokenCount`, export `metricsContent`, add MetricsPanel renderables, extend `MonitorFocus`, update `update()`, update focus cycling, fix initial PollData defaults, add error counter |

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Fixed height (6) for metrics panel may clip on narrow terminals | Visual glitch | Use `height: 6` which fits 4 content lines + 2 border; content is controlled |
| Adding 5th panel to right column may squeeze others | Layout overflow | MetricsPanel uses `flexGrow: 0` with fixed height — steals minimal space |
| `toLocaleString("en-US")` may behave differently in CI | Wrong formatting | Test with explicit expectations; fallback to manual formatting if needed |
| `observability-core` not merged yet | PollData fields missing | Fields verified present on PollData interface already; initial defaults added |

## Verification Against Acceptance Criteria

1. **MetricsPanel renders in right column without overflow** → Fixed height `6`, `flexGrow: 0`, inserted before other panels. Typecheck confirms layout. Visual test confirms no overflow.
2. **When PollData.inputTokensTotal > 0, displays formatted count** → `metricsContent` test with nonzero values asserts formatted output.
3. **When PollData fields all zero/undefined, shows dashes** → `metricsContent` test with zero values asserts `"—"` for each metric.
4. **`bun run typecheck` passes** → Run as final verification step.
