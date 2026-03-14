# Research: Event-Driven Monitor

**Unit:** `event-driven-monitor`
**Phase:** Phase 4 — Replace SQLite-Polling Monitor with Event-Driven Projection
**Date:** 2026-03-15

---

## Summary

This unit replaces the direct SQLite table dependencies in `advanced-monitor-ui.ts`. The `poll()` function currently queries `_smithers_attempts`, `_smithers_nodes`, `scheduled-tasks.db`, `pass_tracker`, and `merge_queue` by column names. The goal is to replace this with an event-derived approach:

1. **`src/runtime/events.ts`** — TypeScript types for `SmithersEvent` variants + NDJSON log reader adapter
2. **`src/runtime/projections.ts`** — Pure `projectEvents(events: SmithersEvent[]): PollData` function
3. **`src/runtime/observability.ts`** — OTLP span exporter + Prometheus-compatible metrics counter
4. **Update `advanced-monitor-ui.ts`** — consume the projection instead of polling tables
5. **Update `Monitor.tsx` and `monitor-standalone.ts`** — use the new event source
6. **Tests** — for the projection function with synthetic event sequences

---

## Files Analyzed

### `src/advanced-monitor-ui.ts` (PRIMARY TARGET)

The entire file is the polling-based monitor. Key sections:

#### `PollData` interface (lines 86-98)
```typescript
interface PollData {
  tickets: TicketView[];
  activeJobs: ActiveJob[];
  discovered: number;
  landed: number;
  evicted: number;
  inPipeline: number;
  maxConcurrency: number;
  phase: WorkflowPhase;
  mergeQueueActivity: MergeQueueActivity | null;
  schedulerReasoning: string | null;
  discoveryCount: number;
}
```

#### `WorkflowPhase` type (lines 40-46)
```typescript
type WorkflowPhase =
  | "starting"      // Before anything has run
  | "interpreting"  // Initial setup before unit execution
  | "discovering"   // Plan loading phase (legacy label)
  | "pipeline"      // Tickets being processed through stages
  | "merging"       // Merge queue actively landing tickets
  | "done";         // All tickets landed
```

#### `TicketView` interface (lines 63-70)
```typescript
interface TicketView {
  id: string;
  title: string;
  tier: string;
  priority: string;
  stages: StageView[];
  landStatus: "landed" | "evicted" | null;
}
```

#### `ActiveJob` interface (lines 72-77)
```typescript
interface ActiveJob {
  jobType: string;
  agentId: string;
  ticketId: string | null;
  elapsedMs: number;
}
```

#### `MergeQueueActivity` interface (lines 79-84)
```typescript
interface MergeQueueActivity {
  ticketsLanded: Array<{ ticketId: string; summary: string }>;
  ticketsEvicted: Array<{ ticketId: string; reason: string }>;
  ticketsSkipped: Array<{ ticketId: string; reason: string }>;
  summary: string | null;
}
```

#### The `poll()` function (lines 551-757)
Queries 5 data sources in sequence:
1. `pass_tracker WHERE run_id = ?` → determines `hasWorkflowOutput`
2. `work-plan.json` file → builds `ticketMap` with unit metadata
3. `_smithers_nodes WHERE run_id = ?` → builds `nodeState: Map<string, string>`
4. `scheduled-tasks.db::scheduled_tasks` (or fallback `_smithers_attempts`) → builds `activeJobs`
5. `merge_queue WHERE run_id = ?` → builds `landMap` + `mergeQueueActivity`
6. `pass_tracker` again → `maxConcurrency` and `schedulerReasoning`

#### `detectPhase()` function (lines 534-548)
Pure function taking `(hasWorkflowOutput, tickets, activeJobs, landed, mergeQueueActive)` → `WorkflowPhase`.

#### SQLite tables accessed (with column names)
| Table | Columns | DB File |
|-------|---------|---------|
| `pass_tracker` | `run_id`, `summary`, `iteration` | `workflow.db` |
| `_smithers_nodes` | `run_id`, `node_id`, `state`, `iteration` | `workflow.db` |
| `_smithers_attempts` | `run_id`, `node_id`, `state`, `started_at_ms` | `workflow.db` |
| `merge_queue` | `run_id`, `tickets_landed`, `tickets_evicted`, `tickets_skipped`, `summary`, `iteration` | `workflow.db` |
| `scheduled_tasks` | `job_type`, `agent_id`, `ticket_id`, `created_at_ms` | `scheduled-tasks.db` |

---

### `src/components/Monitor.tsx`

The Smithers workflow component that wraps `runMonitorUI()`. Key points:
- Accepts `{ dbPath, runId, config, prompt, repoRoot }` props
- Skips if `SUPER_RALPH_SKIP_MONITOR=1`
- Fires `runMonitorUI(...)` without awaiting — fire-and-forget
- Returns `{ started: true, status: "running" }` immediately

Must be updated to pass an event source (e.g., log file path or NDJSON stream) instead of/in addition to `dbPath`.

---

### `src/cli/monitor-standalone.ts`

CLI entry point for standalone monitor:
```typescript
runMonitorUI({
  dbPath,
  runId,
  projectName: projectName || "Workflow",
  prompt: prompt || "",
  logFile: join(dirname(dbPath), "monitor.log"),
})
```

Must be updated to pass an event source path.

---

### `src/workflow/contracts.ts`

Defines stage names and TIER_STAGES used by the monitor:
```typescript
export type StageName = "research"|"plan"|"implement"|"test"|"prd-review"|"code-review"|"review-fix"|"final-review";
export const TIER_STAGES: Record<ScheduledTier, readonly StageName[]> = { small: [...], large: [...] };
export const DISPLAY_STAGES = [...];
export function stageNodeId(unitId: string, stage: StageName): string;
```

The `stageNodeId` function produces `${unitId}:${stageName}` (e.g., `"my-unit:implement"`).

---

### `src/workflow/state.ts`

Pure selector functions over `OutputSnapshot`. This file is analogous to what `projections.ts` will be for events. Key pattern to follow:
- Accept typed data structure (not DB/ctx) as input
- Return computed view
- Fully testable without database

The `OutputSnapshot` pattern here (pure functions over a data structure) is exactly what `projectEvents` should follow.

---

### `src/workflow/__tests__/state.test.ts`

Shows the test pattern using `bun:test`:
```typescript
import { describe, expect, test } from "bun:test";
// Use factory functions to build test data
function snapshot(overrides: Partial<OutputSnapshot> = {}): OutputSnapshot { ... }
// Test with synthetic data
test("returns true when...", () => { ... });
```

This pattern should be followed for projection tests.

---

### `src/scheduled/schemas.ts`

Zod schemas defining the exact shapes of data stored in SQLite tables. Key schemas relevant to events:

- `merge_queue`: `ticketsLanded`, `ticketsEvicted`, `ticketsSkipped`, `summary`, `nextActions`
- `pass_tracker`: `totalIterations`, `unitsRun`, `unitsComplete`, `summary`
- `implement`: `whatWasDone`, `filesCreated`, `filesModified`, `believesComplete`, `summary`
- `test`: `buildPassed`, `testsPassed`, `testsPassCount`, `testsFailCount`, `failingSummary`
- `final_review`: `readyToMoveOn`, `reasoning`, `approved`, `qualityScore`

---

## Implementation Plan

### `src/runtime/events.ts`

Define a discriminated union `SmithersEvent` covering all the state transitions that the current `poll()` derives from DB queries:

```typescript
export type SmithersEvent =
  | { type: "workflow:started"; runId: string; timestamp: number }
  | { type: "workflow:output-detected"; runId: string; timestamp: number }
  | { type: "workplan:loaded"; units: Array<{ id: string; name: string; tier: string; priority: string }>; timestamp: number }
  | { type: "node:state-changed"; runId: string; nodeId: string; state: "in-progress" | "completed" | "failed"; timestamp: number }
  | { type: "job:started"; jobType: string; agentId: string; ticketId: string | null; startedAtMs: number; timestamp: number }
  | { type: "job:completed"; jobType: string; agentId: string; ticketId: string | null; timestamp: number }
  | { type: "merge-queue:result"; ticketsLanded: Array<{ ticketId: string; summary: string }>; ticketsEvicted: Array<{ ticketId: string; reason: string; details: string }>; ticketsSkipped: Array<{ ticketId: string; reason: string }>; summary: string | null; timestamp: number }
  | { type: "pass-tracker:update"; summary: string; maxConcurrency?: number; timestamp: number };

// NDJSON log reader adapter
export type EventSource =
  | { kind: "ndjson-file"; path: string }
  | { kind: "db-poll"; dbPath: string; runId: string; scheduledDbPath?: string; workPlanPath?: string };

export async function readEventsFromNdjson(path: string): Promise<SmithersEvent[]>;
export function watchNdjsonLog(path: string, onEvent: (event: SmithersEvent) => void): () => void;
```

The NDJSON format allows appending one JSON object per line, making it easy to tail.

---

### `src/runtime/projections.ts`

Pure function mapping events to PollData:

```typescript
import type { SmithersEvent } from "./events";
import type { PollData } from "../advanced-monitor-ui"; // or inline the type here

export function projectEvents(events: SmithersEvent[], now?: number): PollData;
```

Implementation approach:
1. Fold over the event array, maintaining accumulated state
2. `workplan:loaded` → populates tickets with pending stages
3. `node:state-changed` → updates ticket stage statuses
4. `job:started` / `job:completed` → updates activeJobs list (with elapsed = now - startedAtMs)
5. `merge-queue:result` → updates landMap + mergeQueueActivity
6. `pass-tracker:update` → updates maxConcurrency + schedulerReasoning
7. `workflow:output-detected` → sets `hasWorkflowOutput = true`

Phase detection reuses the existing `detectPhase()` logic (or imports it if extracted).

---

### `src/runtime/observability.ts`

OTLP + Prometheus metrics, all behind env vars:

```typescript
// Environment variables:
// SMITHERS_OTEL_ENABLED=1 — enable all telemetry
// OTEL_EXPORTER_OTLP_ENDPOINT — OTLP HTTP endpoint (default: http://localhost:4318)
// OTEL_SERVICE_NAME — service name (default: "smithers")

export function createObservabilityContext(): ObservabilityContext;

export interface ObservabilityContext {
  // OTLP span
  startSpan(name: string, attributes?: Record<string, string | number>): Span;
  // Prometheus-compatible counter (exported as text/plain on demand)
  counter(name: string, labels?: Record<string, string>): Counter;
  // Export metrics as Prometheus text format
  metricsText(): string;
}

export interface Span {
  setAttribute(key: string, value: string | number): void;
  end(status?: "ok" | "error"): void;
}

export interface Counter {
  inc(amount?: number): void;
  get(): number;
}
```

Key metrics to track:
- `smithers_units_total` — counter of units discovered
- `smithers_units_landed_total` — counter of units landed
- `smithers_units_evicted_total` — counter of units evicted
- `smithers_jobs_active` — gauge of active jobs
- `smithers_phase_changes_total` — counter of phase transitions

If `SMITHERS_OTEL_ENABLED` is not set, all operations are no-ops. No runtime dependency on `@opentelemetry/*` packages required — can use native HTTP fetch for OTLP export (JSON format).

---

### Update `advanced-monitor-ui.ts`

Key changes:
1. Add `eventLogPath?: string` to `MonitorUIOptions` (NDJSON file path)
2. In main loop: if `eventLogPath` exists, read events + call `projectEvents()` instead of `poll()`
3. Keep `poll()` as fallback when no event log exists (backward compat)
4. Import `projectEvents` from `./runtime/projections`
5. Wire observability: call `createObservabilityContext()` at start, increment counters on phase transitions

---

### Update `Monitor.tsx`

Add `eventLogPath` prop (optional, derived from `dirname(dbPath)`):
```typescript
export type MonitorProps = {
  dbPath: string;
  runId: string;
  config: any;
  prompt: string;
  repoRoot: string;
  eventLogPath?: string; // New: path to NDJSON event log
};
```

Pass through to `runMonitorUI()`.

---

### Update `monitor-standalone.ts`

Add event log path as 5th CLI argument (after `logFile`):
```typescript
const [dbPath, runId, projectName, prompt, eventLogPath] = process.argv.slice(2);
runMonitorUI({
  ...,
  eventLogPath: eventLogPath || join(dirname(dbPath), "events.ndjson"),
});
```

---

### Tests

File: `src/runtime/__tests__/projections.test.ts`

Test scenarios using synthetic `SmithersEvent[]` sequences:

| Scenario | Events | Expected PollData |
|----------|--------|-------------------|
| Empty events | `[]` | `{ tickets: [], activeJobs: [], phase: "starting", ... }` |
| Workflow output detected | `[workflow:output-detected]` | `phase: "interpreting"` |
| Work plan loaded | `[workflow:output-detected, workplan:loaded({units: [u1, u2]})]` | `tickets.length === 2`, `phase: "pipeline"` |
| Node in progress | `[...workplan, node:state-changed(u1:implement, in-progress)]` | `tickets[0].stages.find(s=>s.key==="implement").status === "running"` |
| Node completed | `[...workplan, node:state-changed(u1:implement, completed)]` | stage status `"completed"` |
| Job started | `[job:started({jobType:"ticket:implement", ticketId:"u1"})]` | `activeJobs.length === 1` |
| Job elapsed | `[job:started({startedAtMs: now-5000})]` | `activeJobs[0].elapsedMs ≈ 5000` |
| Merge queue landed | `[...pipeline, merge-queue:result({ticketsLanded:[{ticketId:"u1"}]})]` | `tickets[0].landStatus === "landed"`, `landed === 1` |
| Merge queue evicted | `[...pipeline, merge-queue:result({ticketsEvicted:[{ticketId:"u1"}]})]` | `tickets[0].landStatus === "evicted"`, `evicted === 1` |
| All landed → done | all units landed, no active jobs | `phase: "done"` |
| Merge queue active | node `merge-queue:X` in progress | `phase: "merging"` |
| Pass tracker | `[pass-tracker:update({summary: "3/6 units", maxConcurrency: 6})]` | `maxConcurrency === 6`, `schedulerReasoning` set |

---

## Key Insights

### 1. The Poll Function Is Already Structured for Event Derivation

The `poll()` function constructs `PollData` from 5 DB queries, but the logic is actually a fold over state transitions:
- `_smithers_nodes` is a monotonic log of `(nodeId, state)` changes
- `merge_queue` is a log of batch landing decisions
- `pass_tracker` is a log of scheduler iterations
- `scheduled_tasks` is a current snapshot of active jobs

This maps cleanly to event types.

### 2. Phase Detection Is Already Pure

`detectPhase()` at lines 534-548 takes explicit parameters and has no side effects. It can be imported into `projections.ts` directly, or its logic can be inlined.

### 3. NDJSON Is the Right Wire Format

The existing `monitor.log` file is already being written. Adding a parallel `events.ndjson` file where each workflow state change is written as a JSON line enables:
- Tail-able streaming
- Testable without DB
- Language-agnostic

### 4. No OTEL Package Required

The `package.json` has no `@opentelemetry/*` dependencies. The observability module should use native `fetch()` with the [OTLP/JSON over HTTP](https://opentelemetry.io/docs/specs/otlp/) protocol, avoiding new dependencies. If `SMITHERS_OTEL_ENABLED` is unset, all calls are no-ops.

### 5. Backward Compatibility

The `MonitorUIOptions.dbPath` is still needed for the `fetchDetail()` function which queries stage-specific summary columns. Event projection can be additive — `projectEvents()` handles the main polling loop, while `fetchDetail()` retains its DB query for drill-down detail.

### 6. Test Pattern

Follow the existing pattern from `src/workflow/__tests__/state.test.ts`:
- Use `bun:test` (`describe`, `test`, `expect`)
- Factory functions for synthetic event sequences
- No DB, no file I/O, pure function tests

---

## Open Questions

1. **Event emission point:** Who writes the NDJSON event log? The monitor currently only reads. Events need to be emitted by Smithers (or a hook) as it transitions node states. If Smithers doesn't natively emit events, the NDJSON adapter may need to be a DB-change-watcher that converts DB changes into events — effectively recreating the poll but with event sourcing indirection. Clarify whether the NDJSON log is written by:
   a. Smithers itself (ideal — native event stream)
   b. A polling adapter that converts DB changes to events (acceptable)
   c. Workflow components themselves via direct writes

2. **`fetchDetail()` remains DB-coupled:** The drill-down detail view at lines 485-531 still queries stage-specific columns. Should this also be event-derived, or is the DB coupling acceptable for on-demand detail queries?

3. **`NDJSON` vs event subscription:** The description mentions both "event subscription" and "NDJSON log reader." Are both needed? The NDJSON approach is simpler and more testable. Event subscription (via EventEmitter or similar) would be needed only for in-process use within the same Node/Bun process.

4. **Observability sink:** Should the OTLP export happen from the monitor process or from within Smithers task execution? The description says "without requiring changes to workflow components," which implies the monitor process is the right place.

5. **`StageStatus` type mapping:** The current `nodeState` map uses raw Smithers state strings (`"in-progress"`, `"completed"`, `"failed"`). The `SmithersEvent` `node:state-changed` should use the same strings to avoid a translation layer.

---

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/runtime/events.ts` | CREATE | SmithersEvent discriminated union + NDJSON adapter |
| `src/runtime/projections.ts` | CREATE | `projectEvents()` pure function |
| `src/runtime/observability.ts` | CREATE | OTLP + Prometheus metrics (no-op when disabled) |
| `src/runtime/__tests__/projections.test.ts` | CREATE | Tests for projection function |
| `src/advanced-monitor-ui.ts` | MODIFY | Use `projectEvents()` instead of `poll()` |
| `src/components/Monitor.tsx` | MODIFY | Pass `eventLogPath` to `runMonitorUI()` |
| `src/cli/monitor-standalone.ts` | MODIFY | Accept and pass `eventLogPath` argument |
