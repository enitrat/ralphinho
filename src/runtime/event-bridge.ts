import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

import { DISPLAY_STAGES, type StageName } from "../workflows/ralphinho/workflow/contracts";
import { scheduledOutputSchemas } from "../workflows/ralphinho/schemas";
import {
  extractUnitId,
  implementRowFromSqlite,
  parseStringArray,
  reviewLoopResultRowFromSqlite,
  reviewFixRowFromSqlite,
  testRowFromSqlite,
  type MergeQueueRow,
  type ImplementRow,
  type ReviewLoopResult,
  type ReviewFixRow,
  type TestRow,
} from "../workflows/ralphinho/workflow/state";
import type { SmithersEvent } from "./events";

const STAGE_NAMES = new Set<StageName>(DISPLAY_STAGES.map((entry) => entry.key));

// ── Structural interface for bun:sqlite Database (avoids dynamic-import types) ──

interface SqliteDb {
  query(sql: string): { all(...params: unknown[]): unknown[] };
}

// ── Zod row schemas (boolean columns typed as number — SQLite returns INTEGER 0|1) ──

const smithersNodeRowSchema = z.object({
  node_id: z.string(),
  state: z.string(),
  started_at_ms: z.number().nullish(),
  completed_at_ms: z.number().nullish(),
});

const scheduledTaskRowSchema = z.object({
  job_type: z.string(),
  agent_id: z.string(),
  ticket_id: z.string().nullable(),
  created_at_ms: z.number(),
});

const smithersAttemptRowSchema = z.object({
  node_id: z.string(),
  started_at_ms: z.number().nullable(),
});

const mergeQueueRowSchema = z.object({
  iteration: z.number(),
  tickets_landed: z.string().nullable(),
  tickets_evicted: z.string().nullable(),
  tickets_skipped: z.string().nullable(),
  summary: z.string().nullable(),
});

function deriveFinalReviewDecisionStatus(
  result: Pick<ReviewLoopResult, "passed"> & { exhausted?: boolean | null },
): "pending" | "rejected" | "approved" {
  if (result.passed) return "approved";
  if (result.exhausted === true) return "rejected";
  return "pending";
}


// ── Helpers ───────────────────────────────────────────────────────────────────

function parseNodeId(nodeId: string): { unitId: string; stageName: StageName } | null {
  const parts = nodeId.split(":");
  if (parts.length < 2) return null;
  const stage = parts[parts.length - 1];
  if (!STAGE_NAMES.has(stage as StageName)) return null;
  const unitId = parts.slice(0, -1).join(":");
  if (!unitId) return null;
  return { unitId, stageName: stage as StageName };
}

function safeJsonParse(raw: unknown): unknown {
  if (typeof raw !== "string") return undefined;
  try { return JSON.parse(raw); } catch { return undefined; }
}

function normalizePriority(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : "medium";
}

function normalizeTier(value: unknown): "small" | "large" {
  return value === "small" ? "small" : "large";
}

/**
 * Generic DB-query helper that absorbs table-not-found errors and filters null
 * mapper results. Exported for unit testing.
 *
 * @internal
 */
export function queryRows<T>(
  db: SqliteDb,
  sql: string,
  params: unknown[],
  mapper: (row: unknown) => T | null,
): T[] {
  try {
    return db.query(sql).all(...params)
      .map(mapper)
      .filter((r): r is T => r !== null);
  } catch {
    return [];
  }
}

export async function pollEventsFromDb(
  dbPath: string,
  runId: string,
  workPlanPath: string,
): Promise<SmithersEvent[]> {
  if (!existsSync(dbPath)) return [];

  const now = Date.now();
  const events: SmithersEvent[] = [];
  const { Database } = await import("bun:sqlite");
  const db = new Database(dbPath, { readonly: true });

  try {
    if (existsSync(workPlanPath)) {
      try {
        const rawPlan = await readFile(workPlanPath, "utf8");
        const parsed = JSON.parse(rawPlan) as { units?: Array<Record<string, unknown>> };
        const units = (parsed.units ?? [])
          .filter((unit) => typeof unit?.id === "string")
          .map((unit) => ({
            id: unit.id as string,
            name: typeof unit.name === "string" ? unit.name : unit.id as string,
            tier: normalizeTier(unit.tier),
            priority: normalizePriority(unit.priority),
          }));
        if (units.length > 0) {
          events.push({
            type: "work-plan-loaded",
            timestamp: now,
            units,
          });
        }
      } catch {
        // Ignore malformed work-plan file; monitor should keep rendering.
      }
    }

    const nodeEvents = queryRows(
      db,
      "SELECT node_id, state, started_at_ms, completed_at_ms FROM _smithers_nodes WHERE run_id = ? ORDER BY iteration ASC",
      [runId],
      (row): SmithersEvent | null => {
        const r = smithersNodeRowSchema.safeParse(row);
        if (!r.success) return null;
        const parsed = parseNodeId(r.data.node_id);
        if (!parsed) return null;
        const base = {
          runId,
          nodeId: r.data.node_id,
          unitId: parsed.unitId,
          stageName: parsed.stageName,
          timestamp: r.data.started_at_ms ?? r.data.completed_at_ms ?? now,
        } as const;
        if (r.data.state === "in-progress") return { type: "node-started", ...base };
        if (r.data.state === "completed") return { type: "node-completed", ...base };
        if (r.data.state === "failed") return { type: "node-failed", ...base };
        return null;
      },
    );
    events.push(...nodeEvents);

    const scheduledDbPath = join(dirname(dbPath), "..", "scheduled-tasks.db");
    let scheduledRowsCount = 0;
    if (existsSync(scheduledDbPath)) {
      try {
        const scheduledDb = new Database(scheduledDbPath, { readonly: true });
        const rawScheduledRows = scheduledTaskRowSchema.array().safeParse(
          scheduledDb.query(
            "SELECT job_type, agent_id, ticket_id, created_at_ms FROM scheduled_tasks ORDER BY created_at_ms ASC",
          ).all(),
        );
        const rows = rawScheduledRows.success ? rawScheduledRows.data : [];
        scheduledRowsCount = rows.length;
        for (const row of rows) {
          events.push({
            type: "job-scheduled",
            timestamp: row.created_at_ms || now,
            jobType: row.job_type,
            agentId: row.agent_id,
            ticketId: row.ticket_id ?? null,
            createdAtMs: row.created_at_ms || now,
          });
        }
        scheduledDb.close();
      } catch {
        // Ignore scheduled task DB errors and rely on other event sources.
      }
    }

    if (scheduledRowsCount === 0) {
      const attemptEvents = queryRows(
        db,
        "SELECT node_id, started_at_ms FROM _smithers_attempts WHERE run_id = ? AND state = 'in-progress' ORDER BY started_at_ms ASC",
        [runId],
        (row): SmithersEvent | null => {
          const r = smithersAttemptRowSchema.safeParse(row);
          if (!r.success) return null;
          const parsed = parseNodeId(r.data.node_id);
          const ticketId = parsed?.unitId ?? null;
          const jobType = parsed ? `ticket:${parsed.stageName}` : r.data.node_id;
          return {
            type: "job-scheduled",
            timestamp: r.data.started_at_ms ?? now,
            jobType,
            agentId: "claude",
            ticketId,
            createdAtMs: r.data.started_at_ms ?? now,
          };
        },
      );
      events.push(...attemptEvents);
    }

    const mergeQueueRows: MergeQueueRow[] = [];
    try {
      const rawMergeQueueRows = mergeQueueRowSchema.array().safeParse(
        db.query(
          "SELECT iteration, tickets_landed, tickets_evicted, tickets_skipped, summary FROM merge_queue WHERE run_id = ? ORDER BY iteration ASC",
        ).all(runId),
      );
      const rows = rawMergeQueueRows.success ? rawMergeQueueRows.data : [];

      const ticketsLandedSchema = scheduledOutputSchemas.merge_queue.shape.ticketsLanded;
      const ticketsEvictedSchema = scheduledOutputSchemas.merge_queue.shape.ticketsEvicted;
      const ticketsSkippedSchema = scheduledOutputSchemas.merge_queue.shape.ticketsSkipped;

      for (const row of rows) {
        const landedParsed = ticketsLandedSchema.safeParse(safeJsonParse(row.tickets_landed));
        const landed = landedParsed.success ? landedParsed.data : [];
        const evictedParsed = ticketsEvictedSchema.safeParse(safeJsonParse(row.tickets_evicted));
        const evicted = evictedParsed.success ? evictedParsed.data : [];
        const skippedParsed = ticketsSkippedSchema.safeParse(safeJsonParse(row.tickets_skipped));
        const skipped = skippedParsed.success ? skippedParsed.data : [];

        mergeQueueRows.push({
          nodeId: "merge-queue",
          ticketsLanded: landed.map((item) => ({
            ticketId: item.ticketId,
            mergeCommit: item.mergeCommit ?? null,
            summary: item.summary || (row.summary ?? ""),
            reviewLoopIteration: item.reviewLoopIteration ?? null,
            testIteration: item.testIteration ?? null,
          })),
          ticketsEvicted: evicted,
        });

        for (const item of landed) {
          events.push({
            type: "merge-queue-landed",
            timestamp: now + row.iteration,
            runId,
            ticketId: item.ticketId,
            mergeCommit: item.mergeCommit ?? null,
            summary: item.summary || (row.summary ?? ""),
          });
        }

        for (const item of evicted) {
          events.push({
            type: "merge-queue-evicted",
            timestamp: now + row.iteration,
            runId,
            ticketId: item.ticketId,
            reason: item.reason,
            details: item.details,
          });
        }

        for (const item of skipped) {
          events.push({
            type: "merge-queue-skipped",
            timestamp: now + row.iteration,
            runId,
            ticketId: item.ticketId,
            reason: item.reason,
          });
        }
      }
    } catch {
      // merge_queue may not be initialized yet.
    }

    const allReviewLoopRows: Array<ReviewLoopResult & { exhausted?: boolean | null }> = queryRows(
      db,
      "SELECT node_id, iteration, passed, summary, exhausted FROM review_loop_result WHERE run_id = ? ORDER BY iteration ASC",
      [runId],
      (row) => {
        const mapped = reviewLoopResultRowFromSqlite(row as Record<string, unknown>);
        if (!mapped || !parseNodeId(mapped.nodeId)) return null;
        const exhaustedRaw = (row as { exhausted?: unknown }).exhausted;
        return {
          ...mapped,
          exhausted: typeof exhaustedRaw === "number" ? Boolean(exhaustedRaw) : null,
        };
      },
    );

    const allImplementRows: ImplementRow[] = queryRows(
      db,
      "SELECT node_id, iteration, what_was_done, files_created, files_modified, believes_complete, summary FROM implement WHERE run_id = ? ORDER BY iteration ASC",
      [runId],
      (row) => {
        const mapped = implementRowFromSqlite(row as Record<string, unknown>);
        if (!mapped || !parseNodeId(mapped.nodeId)) return null;
        return mapped;
      },
    );

    const allTestRows: TestRow[] = queryRows(
      db,
      "SELECT node_id, iteration, tests_passed, build_passed, failing_summary FROM test WHERE run_id = ? ORDER BY iteration ASC",
      [runId],
      (row) => {
        const mapped = testRowFromSqlite(row as Record<string, unknown>);
        if (!mapped || !parseNodeId(mapped.nodeId)) return null;
        return mapped;
      },
    );

    const allReviewFixRows: ReviewFixRow[] = queryRows(
      db,
      "SELECT node_id, iteration, summary, all_issues_resolved, build_passed, tests_passed FROM review_fix WHERE run_id = ? ORDER BY iteration ASC",
      [runId],
      (row) => {
        const mapped = reviewFixRowFromSqlite(row as Record<string, unknown>);
        if (!mapped || !parseNodeId(mapped.nodeId)) return null;
        return mapped;
      },
    );

    const unitIds = new Set<string>();
    for (const row of [...allTestRows, ...allReviewLoopRows, ...allImplementRows, ...allReviewFixRows]) {
      if (row.nodeId) {
        const uid = extractUnitId(row.nodeId);
        if (uid) unitIds.add(uid);
      }
    }
    for (const unitId of unitIds) {
      const latestReviewLoopResult = allReviewLoopRows
        .filter((row) => extractUnitId(row.nodeId) === unitId)
        .at(-1);
      if (!latestReviewLoopResult) continue;
      const status = deriveFinalReviewDecisionStatus(latestReviewLoopResult);
      events.push({
        type: "final-review-decision",
        timestamp: now + latestReviewLoopResult.iteration,
        runId,
        unitId,
        iteration: latestReviewLoopResult.iteration,
        status,
        reasoning: latestReviewLoopResult.summary,
        approvalSupersededRejection: false,
        approvalOnlyCorrectedFormatting: false,
      });
    }

    try {
      const row = db.query(
        "SELECT total_units, units_landed, units_semantically_complete FROM completion_report WHERE run_id = ? ORDER BY iteration DESC LIMIT 1",
      ).get(runId) as {
        total_units?: number;
        units_landed?: string | null;
        units_semantically_complete?: string | null;
      } | undefined;
      if (row) {
        events.push({
          type: "semantic-completion-update",
          timestamp: now,
          runId,
          totalUnits: row.total_units ?? 0,
          unitsLanded: parseStringArray(row.units_landed),
          unitsSemanticallyComplete: parseStringArray(row.units_semantically_complete),
        });
      }
    } catch {
      // completion report may not exist yet.
    }

    try {
      const row = db.query(
        "SELECT summary FROM pass_tracker WHERE run_id = ? ORDER BY iteration DESC LIMIT 1",
      ).get(runId) as { summary?: string } | undefined;
      const summary = typeof row?.summary === "string" ? row.summary : "";
      if (summary) {
        const maxMatch = /[0-9]+\/([0-9]+)\s+units/.exec(summary);
        events.push({
          type: "pass-tracker-update",
          timestamp: now,
          runId,
          summary,
          maxConcurrency: maxMatch ? Number(maxMatch[1]) || 0 : 0,
        });
      }
    } catch {
      // pass tracker table may be unavailable early in startup.
    }
  } finally {
    db.close();
  }

  return events;
}
