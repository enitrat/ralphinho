# Plan: Replace SQLite-Polling Monitor with Event-Driven Projection

## Overview

Replace the direct SQLite table queries in `advanced-monitor-ui.ts`'s `poll()` function (lines 551-757) with an event-driven projection layer. The `poll()` function currently queries 5 SQLite tables (`_smithers_nodes`, `_smithers_attempts`, `scheduled_tasks`, `merge_queue`, `pass_tracker`) by column names. This plan introduces:

1. **`src/runtime/events.ts`** — TypeScript types for `SmithersEvent` discriminated union
2. **`src/runtime/projections.ts`** — Pure `projectEvents()` function: events → `PollData`
3. **`src/runtime/observability.ts`** — OTLP span exporter + Prometheus metrics via native `fetch()`
4. Updated `advanced-monitor-ui.ts` consuming projections instead of raw SQL
5. Updated `Monitor.tsx` and `monitor-standalone.ts` to pass event source config

**Key constraint:** `fetchDetail()` (lines 485-531) still needs DB access for stage-specific summary columns. The event projection is *additive* — it replaces `poll()` but not detail queries. `merge_queue` output rows are still accessed through the projection layer.

## TDD Applicability

**TDD applies.** This work introduces new public APIs (`projectEvents`, `SmithersEvent` types) and changes the data flow of the monitor. The projection function is a pure function — ideal for test-first development. The observability module has new env-var-gated behavior that should be tested.

## Step-by-Step Implementation

### Phase 1: Types & Event Definitions (test-first)

#### Step 1.1: Create `src/runtime/events.ts`

Define the `SmithersEvent` discriminated union covering all events the monitor needs:

```typescript
// src/runtime/events.ts
export type SmithersEvent =
  | NodeStartedEvent
  | NodeCompletedEvent
  | NodeFailedEvent
  | JobScheduledEvent
  | JobCompletedEvent
  | MergeQueueLandedEvent
  | MergeQueueEvictedEvent
  | MergeQueueSkippedEvent
  | PassTrackerUpdateEvent
  | WorkPlanLoadedEvent;

export interface NodeStartedEvent {
  type: "node-started";
  timestamp: number;
  runId: string;
  nodeId: string;        // e.g. "my-unit:implement"
  unitId: string;
  stageName: string;
}

export interface NodeCompletedEvent {
  type: "node-completed";
  timestamp: number;
  runId: string;
  nodeId: string;
  unitId: string;
  stageName: string;
}

export interface NodeFailedEvent {
  type: "node-failed";
  timestamp: number;
  runId: string;
  nodeId: string;
  unitId: string;
  stageName: string;
  error?: string;
}

export interface JobScheduledEvent {
  type: "job-scheduled";
  timestamp: number;
  jobType: string;
  agentId: string;
  ticketId: string | null;
  createdAtMs: number;
}

export interface JobCompletedEvent {
  type: "job-completed";
  timestamp: number;
  jobType: string;
  agentId: string;
  ticketId: string | null;
}

export interface MergeQueueLandedEvent {
  type: "merge-queue-landed";
  timestamp: number;
  runId: string;
  ticketId: string;
  mergeCommit: string | null;
  summary: string;
}

export interface MergeQueueEvictedEvent {
  type: "merge-queue-evicted";
  timestamp: number;
  runId: string;
  ticketId: string;
  reason: string;
  details: string;
}

export interface MergeQueueSkippedEvent {
  type: "merge-queue-skipped";
  timestamp: number;
  runId: string;
  ticketId: string;
  reason: string;
}

export interface PassTrackerUpdateEvent {
  type: "pass-tracker-update";
  timestamp: number;
  runId: string;
  summary: string;
  maxConcurrency: number;
}

export interface WorkPlanLoadedEvent {
  type: "work-plan-loaded";
  timestamp: number;
  units: Array<{
    id: string;
    name: string;
    tier: string;
    priority: string;
  }>;
}
```

#### Step 1.2: Create `src/runtime/__tests__/projections.test.ts` (TESTS FIRST)

Write tests before the implementation. Follow the pattern from `src/workflow/__tests__/state.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { projectEvents } from "../projections";
import type { SmithersEvent } from "../events";

// Factory helpers
function nodeStarted(unitId: string, stage: string, ts = Date.now()): SmithersEvent {
  return { type: "node-started", timestamp: ts, runId: "run-1", nodeId: `${unitId}:${stage}`, unitId, stageName: stage };
}
function nodeCompleted(unitId: string, stage: string, ts = Date.now()): SmithersEvent { ... }
function nodeFailed(unitId: string, stage: string, ts = Date.now()): SmithersEvent { ... }
function mqLanded(ticketId: string, ts = Date.now()): SmithersEvent { ... }
function workPlanLoaded(units: Array<{id: string; name: string; tier: string; priority: string}>, ts = Date.now()): SmithersEvent { ... }
```

**Test cases (AC 3):** `projectEvents` with node-started → node-completed → merge-queue-landed → produces `phase='done'`, `landed=N`, `evicted=0`

**Test cases (AC 4):** `projectEvents` with node-failed → produces `phase='pipeline'` and failed stage status

Additional tests:
- Empty events → `phase='starting'`
- Work plan loaded but no nodes → `phase='discovering'`
- Multiple units, partial completion → correct `inPipeline` count
- Job scheduled/completed → `activeJobs` tracking
- Pass tracker update → `maxConcurrency` and `schedulerReasoning`

#### Step 1.3: Create `src/runtime/projections.ts`

Implement the pure `projectEvents` function:

```typescript
// src/runtime/projections.ts
import type { SmithersEvent } from "./events";
import { DISPLAY_STAGES, TIER_STAGES, stageNodeId } from "../workflow/contracts";

// Re-export PollData types (moved from advanced-monitor-ui.ts)
export interface PollData { ... }  // same shape as current
export interface TicketView { ... }
export interface ActiveJob { ... }
export interface MergeQueueActivity { ... }
export type WorkflowPhase = "starting" | "interpreting" | "discovering" | "pipeline" | "merging" | "done";

export function projectEvents(events: SmithersEvent[]): PollData {
  // Walk events in order, building up:
  // - ticketMap: unit metadata from work-plan-loaded events
  // - nodeStates: Map<nodeId, "running"|"completed"|"failed">
  // - activeJobs: Set of currently active jobs
  // - landMap: Map<ticketId, "landed"|"evicted">
  // - mergeQueueActivity: latest merge queue summary
  // - maxConcurrency, schedulerReasoning from pass-tracker
  // Then build TicketView[] from ticketMap + nodeStates + landMap
  // Then call detectPhase() (moved here as pure function)
}
```

**Key:** `detectPhase()` already exists as a pure function at lines 534-548 of `advanced-monitor-ui.ts` — move it into `projections.ts`.

### Phase 2: Event Source Adapter

#### Step 2.1: Add NDJSON event log reader to `src/runtime/events.ts`

```typescript
// Append to events.ts
export async function readEventLog(path: string): Promise<SmithersEvent[]> {
  // Read NDJSON file, parse each line as SmithersEvent
  // Gracefully handle missing file (return [])
}
```

#### Step 2.2: Add SQLite-to-event adapter (bridge for migration)

Create `src/runtime/event-bridge.ts` — reads existing SQLite tables and synthesizes `SmithersEvent[]` from them. This allows the monitor to work with existing DB-based workflows while the event log is not yet emitted by the engine.

```typescript
// src/runtime/event-bridge.ts
export function pollEventsFromDb(dbPath: string, runId: string, workPlanPath: string): Promise<SmithersEvent[]> {
  // Read _smithers_nodes → NodeStarted/Completed/Failed events
  // Read scheduled_tasks → JobScheduled events
  // Read merge_queue → MergeQueueLanded/Evicted/Skipped events
  // Read pass_tracker → PassTrackerUpdate events
  // Read work-plan.json → WorkPlanLoaded event
}
```

This bridge preserves backward compatibility — the monitor works with both legacy DB and future event logs.

### Phase 3: Update Monitor UI

#### Step 3.1: Refactor `advanced-monitor-ui.ts`

1. **Remove**: Direct SQLite queries from `poll()` (lines 551-757)
2. **Remove**: Local type definitions for `PollData`, `TicketView`, `ActiveJob`, etc. — import from `projections.ts`
3. **Remove**: `detectPhase()` — imported from `projections.ts`
4. **Import**: `TIER_STAGES` already imported from `contracts.ts` (line 17) — AC 7 already satisfied ✓
5. **Replace `poll()`** with:
   ```typescript
   async function poll() {
     lastError = null;
     try {
       const events = await pollEventsFromDb(dbPath, runId, workPlanPath);
       const newData = projectEvents(events);
       // Phase transition logging (existing logic, lines 732-744)
       // ...
       data = newData;
     } catch (err) {
       lastError = `Poll failed: ${err instanceof Error ? err.message : "unknown"}`;
     }
   }
   ```
6. **Keep `fetchDetail()`** — it still needs DB access for summary columns (per research context). This is the only remaining DB read.

#### Step 3.2: Update `MonitorUIOptions` interface

```typescript
export interface MonitorUIOptions {
  dbPath: string;
  runId: string;
  projectName: string;
  prompt: string;
  logFile?: string;
  eventLogPath?: string;  // NEW: optional NDJSON event log path
}
```

When `eventLogPath` is provided and the file exists, prefer reading events from it over the DB bridge.

#### Step 3.3: Update `Monitor.tsx`

Pass `eventLogPath` through to `runMonitorUI`:

```typescript
const eventLogPath = join(dirname(dbPath), "events.ndjson");
runMonitorUI({
  dbPath,
  runId,
  projectName: config.projectName || "Workflow",
  prompt,
  logFile,
  eventLogPath,
})
```

#### Step 3.4: Update `monitor-standalone.ts`

Accept optional 5th arg:

```typescript
const [dbPath, runId, projectName, prompt, eventLogPath] = process.argv.slice(2);
```

### Phase 4: Observability

#### Step 4.1: Create `src/runtime/__tests__/observability.test.ts` (TESTS FIRST)

```typescript
import { describe, expect, test, beforeEach, afterEach } from "bun:test";

describe("observability", () => {
  test("SMITHERS_OTEL_ENABLED=1 initializes exporter without error", async () => {
    process.env.SMITHERS_OTEL_ENABLED = "1";
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
    process.env.OTEL_SERVICE_NAME = "test-smithers";
    const obs = await import("../observability");
    expect(obs.isEnabled()).toBe(true);
    // cleanup
    delete process.env.SMITHERS_OTEL_ENABLED;
  });

  test("disabled by default when env var absent", async () => {
    delete process.env.SMITHERS_OTEL_ENABLED;
    const obs = await import("../observability");
    expect(obs.isEnabled()).toBe(false);
    // Calling record functions should be no-ops
    obs.recordSpan("test", {});
    obs.incrementCounter("test.count");
  });
});
```

#### Step 4.2: Create `src/runtime/observability.ts`

```typescript
// src/runtime/observability.ts
// OTLP/JSON HTTP exporter using native fetch() — no @opentelemetry/* deps

const ENABLED = process.env.SMITHERS_OTEL_ENABLED === "1";
const ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318";
const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || "smithers";

export function isEnabled(): boolean { return ENABLED; }

export function recordSpan(name: string, attributes: Record<string, string | number>): void {
  if (!ENABLED) return;
  // POST to ENDPOINT/v1/traces with OTLP JSON payload
  // Fire-and-forget — don't block the monitor loop
}

export function incrementCounter(name: string, value = 1): void {
  if (!ENABLED) return;
  // POST to ENDPOINT/v1/metrics with OTLP JSON payload
}
```

No changes to workflow components needed — observability is opt-in via env vars.

### Phase 5: Verification

#### Step 5.1: Run all tests

```bash
bun test src/runtime/__tests__/projections.test.ts
bun test src/runtime/__tests__/observability.test.ts
bun test src/workflow/__tests__/state.test.ts  # regression
```

#### Step 5.2: Typecheck

```bash
bun run typecheck
```

#### Step 5.3: Manual TUI verification (AC 5)

Run `monitor-standalone.ts` against a test DB to verify the TUI renders correctly with projection-sourced data.

## Files to Create

| File | Purpose |
|------|---------|
| `src/runtime/events.ts` | SmithersEvent types + NDJSON reader |
| `src/runtime/projections.ts` | Pure `projectEvents()` function + exported types |
| `src/runtime/event-bridge.ts` | SQLite → SmithersEvent[] adapter (backward compat) |
| `src/runtime/observability.ts` | OTLP exporter + metrics via native fetch() |
| `src/runtime/__tests__/projections.test.ts` | Projection tests with synthetic events |
| `src/runtime/__tests__/observability.test.ts` | Observability env-var tests |

## Files to Modify

| File | Changes |
|------|---------|
| `src/advanced-monitor-ui.ts` | Remove SQLite queries from `poll()`, import projection + event-bridge, move types to `projections.ts`, add `eventLogPath` to options |
| `src/components/Monitor.tsx` | Pass `eventLogPath` option |
| `src/cli/monitor-standalone.ts` | Accept 5th positional arg for `eventLogPath` |

## Function Signatures

```typescript
// src/runtime/projections.ts
export function projectEvents(events: SmithersEvent[]): PollData;

// src/runtime/events.ts
export async function readEventLog(path: string): Promise<SmithersEvent[]>;

// src/runtime/event-bridge.ts
export async function pollEventsFromDb(dbPath: string, runId: string, workPlanPath: string): Promise<SmithersEvent[]>;

// src/runtime/observability.ts
export function isEnabled(): boolean;
export function recordSpan(name: string, attributes: Record<string, string | number>): void;
export function incrementCounter(name: string, value?: number): void;
```

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Event bridge doesn't perfectly replicate `poll()` behavior | Monitor shows stale/incorrect data | Test bridge output against raw SQL output for known DB states |
| NDJSON event log doesn't exist yet (no engine emitter) | Event source is never used | Bridge adapter ensures DB-based fallback works; eventLogPath is optional |
| `fetchDetail()` still needs DB — partial migration | Confusion about what's migrated | Document clearly that detail view remains DB-backed; projection handles only `poll()` |
| OpenTelemetry payload format mismatch | Spans not received by collector | Test with a local Jaeger/OTEL collector; validate JSON schema against OTLP spec |
| Phase detection logic drift during move | Subtle behavior changes | Keep `detectPhase()` signature identical; test with same inputs |
| `bun:sqlite` dynamic import in event-bridge | Bundle/test issues | Import pattern already used in `advanced-monitor-ui.ts` |

## Acceptance Criteria Verification

| AC | How to verify |
|----|---------------|
| 1. `poll()` no longer opens `_smithers_attempts` or `scheduled-tasks.db` | Grep `advanced-monitor-ui.ts` for `_smithers_attempts`, `scheduled-tasks.db` — should only appear in `event-bridge.ts` |
| 2. `projectEvents` is pure, no SQLite/file I/O | Read `projections.ts` — no imports of `bun:sqlite`, `fs`, or `path` |
| 3. Test: node-started/completed/landed → phase='done' | `bun test projections.test.ts` — specific test case |
| 4. Test: node-failed → phase='pipeline', failed status | `bun test projections.test.ts` — specific test case |
| 5. TUI renders correctly with projection output | Manual test with `monitor-standalone.ts` |
| 6. OTEL env var behavior | `bun test observability.test.ts` |
| 7. TIER_STAGES from contracts.ts | Already true (line 17 of `advanced-monitor-ui.ts`) — verify no redefinition after refactor |
| 8. Typecheck passes | `bun run typecheck` |

## Implementation Order

1. `src/runtime/events.ts` (types only — fast, no tests needed for types)
2. `src/runtime/__tests__/projections.test.ts` (tests FIRST)
3. `src/runtime/projections.ts` (make tests pass)
4. `src/runtime/event-bridge.ts` (SQLite adapter)
5. `src/advanced-monitor-ui.ts` (refactor poll() to use projection + bridge)
6. `src/components/Monitor.tsx` (pass eventLogPath)
7. `src/cli/monitor-standalone.ts` (accept 5th arg)
8. `src/runtime/__tests__/observability.test.ts` (tests FIRST)
9. `src/runtime/observability.ts` (make tests pass)
10. Typecheck + full test suite
