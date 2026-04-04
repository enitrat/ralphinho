# Plan: observability-core — Token Tracking, Event Schema Expansion, and Event Writing

## Work Type Assessment

**This adds features and new observable behavior.** Specifically:
- New Zod event schemas (10 new event types) → new public API surface
- New `writeEventLog()` function → new code path
- Token polling from SQLite → new data flow
- New fields on `PollData` → changed output type

**TDD applies.** Tests should be written before implementation for each observable behavior.

---

## Approach

Three files to modify, one test file per source. Work bottom-up: schemas first (events.ts), then bridge (event-bridge.ts), then projections (projections.ts). Tests precede each implementation step.

---

## Step-by-Step Plan

### Phase 1: New Event Schemas in `events.ts`

#### Step 1.1 — Tests for new event types
**File:** `src/runtime/__tests__/events.test.ts`

Add `parseEvent()` tests for each new event type:
- `token-usage-reported` — with all fields, with optional fields omitted
- `agent-event`
- `scorer-started`, `scorer-finished`, `scorer-failed`
- `snapshot-captured`
- `run-forked`
- `replay-started`
- `run-hijack-requested`, `run-hijacked`

Follow existing test pattern: create input object, call `parseEvent()`, assert result equals input.

#### Step 1.2 — Tests for `writeEventLog()`
**File:** `src/runtime/__tests__/events.test.ts`

Add `describe("writeEventLog")` block:
- Test: writes valid events as NDJSON, each line is valid JSON
- Test: round-trip — `writeEventLog()` then `readEventLog()` returns same events
- Test: appends to existing file (doesn't overwrite)
- Test: skips invalid events (only writes Zod-valid events)
- Test: no-op when events array is empty

#### Step 1.3 — Implement new event schemas
**File:** `src/runtime/events.ts`

Add 10 new Zod schemas (follow existing kebab-case `z.literal` convention):

```typescript
const tokenUsageReportedSchema = z.object({
  type: z.literal("token-usage-reported"),
  timestamp: z.number().finite(),
  runId: z.string(),
  nodeId: z.string(),
  inputTokens: z.number().finite(),
  outputTokens: z.number().finite(),
  cacheReadTokens: z.number().finite().optional(),
  cacheWriteTokens: z.number().finite().optional(),
  reasoningTokens: z.number().finite().optional(),
  durationMs: z.number().finite(),
});

const agentEventSchema = z.object({
  type: z.literal("agent-event"),
  timestamp: z.number().finite(),
  runId: z.string(),
  nodeId: z.string(),
  agentType: z.string(),
  message: z.string(),
});

const scorerStartedSchema = z.object({
  type: z.literal("scorer-started"),
  timestamp: z.number().finite(),
  runId: z.string(),
  nodeId: z.string(),
  scorerName: z.string(),
});

const scorerFinishedSchema = z.object({
  type: z.literal("scorer-finished"),
  timestamp: z.number().finite(),
  runId: z.string(),
  nodeId: z.string(),
  scorerName: z.string(),
  score: z.number().finite(),
});

const scorerFailedSchema = z.object({
  type: z.literal("scorer-failed"),
  timestamp: z.number().finite(),
  runId: z.string(),
  nodeId: z.string(),
  scorerName: z.string(),
  error: z.string(),
});

const snapshotCapturedSchema = z.object({
  type: z.literal("snapshot-captured"),
  timestamp: z.number().finite(),
  runId: z.string(),
  snapshotId: z.string(),
});

const runForkedSchema = z.object({
  type: z.literal("run-forked"),
  timestamp: z.number().finite(),
  runId: z.string(),
  parentRunId: z.string(),
});

const replayStartedSchema = z.object({
  type: z.literal("replay-started"),
  timestamp: z.number().finite(),
  runId: z.string(),
  sourceRunId: z.string(),
});

const runHijackRequestedSchema = z.object({
  type: z.literal("run-hijack-requested"),
  timestamp: z.number().finite(),
  runId: z.string(),
  requestedBy: z.string(),
});

const runHijackedSchema = z.object({
  type: z.literal("run-hijacked"),
  timestamp: z.number().finite(),
  runId: z.string(),
  hijackedBy: z.string(),
});
```

Register all 10 in the `smithersEventSchema` discriminated union array.

Export corresponding types:
```typescript
export type TokenUsageReportedEvent = z.infer<typeof tokenUsageReportedSchema>;
export type AgentEventEvent = z.infer<typeof agentEventSchema>;
// ... etc for all 10
```

#### Step 1.4 — Implement `writeEventLog()`
**File:** `src/runtime/events.ts`

```typescript
import { appendFile } from "node:fs/promises";

export async function writeEventLog(path: string, events: SmithersEvent[]): Promise<void> {
  const lines = events
    .filter((e) => smithersEventSchema.safeParse(e).success)
    .map((e) => JSON.stringify(e))
    .join("\n");
  if (lines) await appendFile(path, lines + "\n", "utf8");
}
```

#### Step 1.5 — Run tests, verify Phase 1
```bash
bun test src/runtime/__tests__/events.test.ts
```

---

### Phase 2: Token Polling in `event-bridge.ts`

#### Step 2.1 — Tests for token usage emission
**File:** `src/runtime/__tests__/event-bridge.test.ts`

Add test: `pollEventsFromDb emits token-usage-reported from _smithers_token_usage table`
- Create an in-memory SQLite DB with `_smithers_token_usage` table
- Insert a mock row with token counts
- Call `pollEventsFromDb()`
- Assert result contains a `token-usage-reported` event with correct field values

Add test: `pollEventsFromDb gracefully handles missing _smithers_token_usage table`
- Use a DB without the token table → no error, no token events

#### Step 2.2 — Implement token usage query
**File:** `src/runtime/event-bridge.ts`

Add a Zod row schema:
```typescript
const tokenUsageRowSchema = z.object({
  node_id: z.string(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_read_tokens: z.number().nullable(),
  cache_write_tokens: z.number().nullable(),
  reasoning_tokens: z.number().nullable(),
  duration_ms: z.number(),
  timestamp_ms: z.number().nullable(),
});
```

Add `queryRows` call in `pollEventsFromDb()` (inside the try/finally block, after existing queries):
```typescript
const tokenEvents = queryRows(
  db,
  "SELECT node_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, duration_ms, timestamp_ms FROM _smithers_token_usage WHERE run_id = ? ORDER BY timestamp_ms ASC",
  [runId],
  (row): SmithersEvent | null => {
    const r = tokenUsageRowSchema.safeParse(row);
    if (!r.success) return null;
    return {
      type: "token-usage-reported",
      timestamp: r.data.timestamp_ms ?? now,
      runId,
      nodeId: r.data.node_id,
      inputTokens: r.data.input_tokens,
      outputTokens: r.data.output_tokens,
      cacheReadTokens: r.data.cache_read_tokens ?? undefined,
      cacheWriteTokens: r.data.cache_write_tokens ?? undefined,
      reasoningTokens: r.data.reasoning_tokens ?? undefined,
      durationMs: r.data.duration_ms,
    };
  },
);
events.push(...tokenEvents);
```

#### Step 2.3 — Add `writeEventLog()` call
**File:** `src/runtime/event-bridge.ts`

Import `writeEventLog` from `./events`. After building the events array and before returning, call:
```typescript
const ndjsonPath = join(dirname(dbPath), "events.ndjson");
await writeEventLog(ndjsonPath, events);
```

This keeps the NDJSON file current (matching the convention from `advanced-monitor-ui.ts:242`).

#### Step 2.4 — Run tests, verify Phase 2
```bash
bun test src/runtime/__tests__/event-bridge.test.ts
```

---

### Phase 3: Token Totals in `projections.ts`

#### Step 3.1 — Tests for new PollData fields
**File:** `src/runtime/__tests__/projections.test.ts`

Add tests:
- `projectEvents returns zero tokenTotals and runDurationMs for empty events`
- `projectEvents accumulates token totals from token-usage-reported events`
  - Feed 2-3 `token-usage-reported` events, assert `tokenTotals.inputTotal` sums `inputTokens`, etc.
- `projectEvents computes runDurationMs from earliest event timestamp to now`
  - Feed events with known timestamps, pass `now` param, assert `runDurationMs = now - earliest`

#### Step 3.2 — Implement PollData token fields
**File:** `src/runtime/projections.ts`

Add to `PollData` interface:
```typescript
tokenTotals: {
  inputTotal: number;
  outputTotal: number;
  cacheReadTotal: number;
};
runDurationMs: number;
```

In `projectEvents()`, add accumulators:
```typescript
let inputTotal = 0;
let outputTotal = 0;
let cacheReadTotal = 0;
let earliestTimestamp = Infinity;
```

In the switch statement, add case:
```typescript
case "token-usage-reported":
  inputTotal += event.inputTokens;
  outputTotal += event.outputTokens;
  cacheReadTotal += event.cacheReadTokens ?? 0;
  break;
```

Track `earliestTimestamp` on every event:
```typescript
// Before the switch, for every event:
if (event.timestamp < earliestTimestamp) earliestTimestamp = event.timestamp;
```

In the return object, add:
```typescript
tokenTotals: { inputTotal, outputTotal, cacheReadTotal },
runDurationMs: earliestTimestamp === Infinity ? 0 : Math.max(0, now - earliestTimestamp),
```

#### Step 3.3 — Run tests, verify Phase 3
```bash
bun test src/runtime/__tests__/projections.test.ts
```

---

### Phase 4: Full Verification

```bash
bun run typecheck
bun test src/runtime/__tests__/events.test.ts src/runtime/__tests__/event-bridge.test.ts src/runtime/__tests__/projections.test.ts
```

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/runtime/events.ts` | +10 Zod schemas, +10 type exports, register in union, add `writeEventLog()`, import `appendFile` |
| `src/runtime/event-bridge.ts` | +token usage row schema, +queryRows call, +writeEventLog call, import `writeEventLog` |
| `src/runtime/projections.ts` | +`tokenTotals` and `runDurationMs` to PollData, accumulation logic in `projectEvents()` |
| `src/runtime/__tests__/events.test.ts` | +tests for 10 new event types, +tests for `writeEventLog()` |
| `src/runtime/__tests__/event-bridge.test.ts` | +tests for token usage emission from mock DB |
| `src/runtime/__tests__/projections.test.ts` | +tests for tokenTotals and runDurationMs |

## Files to Create

None.

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Token usage SQLite table name unknown (might be `_smithers_token_usage` or different) | Use `queryRows` try/catch pattern — gracefully returns [] if table doesn't exist. Verify against actual Smithers DB if available. |
| `writeEventLog()` concurrent writes from multiple pollers | NDJSON append is atomic at OS level for small writes. `readEventLog()` already skips malformed lines. |
| Adding `tokenTotals`/`runDurationMs` to PollData breaks existing consumers | These are additive fields — TypeScript will require them at creation sites but not at consumption sites (structural typing). The monitor UI will need minor updates but that's outside this unit's scope. |
| Discriminated union with 22 variants may slow Zod parsing | Unlikely at this scale. Monitor if perf degrades. |

---

## Acceptance Criteria Verification

| AC# | How to Verify |
|-----|---------------|
| 1. TokenUsageReported + 14 new event types have Zod schemas | Count schemas in discriminated union array: should be 22 (12 existing + 10 new). `parseEvent()` tests cover all. |
| 2. writeEventLog() appends valid NDJSON; unit test replays | Round-trip test: `writeEventLog()` → `readEventLog()` returns same events. |
| 3. event-bridge.ts polls token events from SQLite | Unit test with mock DB row confirms `token-usage-reported` event fires. |
| 4. PollData includes token/duration fields | TypeScript enforces via interface. Test asserts fields are populated. |
| 5. `bun run typecheck` passes | Run as final verification step. |

**Note:** The description mentions "14 new event types" but the research lists 10 new types. We implement the 10 enumerated types from the research context. If additional types are needed, they follow the same mechanical pattern.
