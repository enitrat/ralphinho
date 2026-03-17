import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

import { DISPLAY_STAGES, type StageName } from "../workflows/ralphinho/workflow/contracts";
import { getDecisionAudit } from "../workflows/ralphinho/workflow/decisions";
import { buildOutputSnapshot, extractUnitId, type FinalReviewRow, type ImplementRow, type OutputSnapshot, type ReviewFixRow, type TestRow } from "../workflows/ralphinho/workflow/state";
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

const finalReviewRawRowSchema = z.object({
  node_id: z.string(),
  iteration: z.number(),
  ready_to_move_on: z.number(),
  approved: z.number(),
  reasoning: z.string(),
  quality_score: z.number().nullable(),
});

const implementRawRowSchema = z.object({
  node_id: z.string(),
  iteration: z.number(),
  what_was_done: z.string(),
  files_created: z.string().nullable(),
  files_modified: z.string().nullable(),
  believes_complete: z.number(),
  summary: z.string().nullable(),
});

const testRawRowSchema = z.object({
  node_id: z.string(),
  iteration: z.number(),
  tests_passed: z.number(),
  build_passed: z.number(),
  failing_summary: z.string().nullable(),
});

const reviewFixRawRowSchema = z.object({
  node_id: z.string(),
  iteration: z.number(),
  summary: z.string(),
  all_issues_resolved: z.number(),
  build_passed: z.number(),
  tests_passed: z.number(),
});

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

function parseObjectArray(raw: unknown): Array<Record<string, unknown>> {
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((entry) => typeof entry === "object" && entry !== null) as Array<Record<string, unknown>>
      : [];
  } catch {
    return [];
  }
}

function parseStringArray(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
  } catch {
    return [];
  }
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
            name: typeof unit.name === "string" ? unit.name : String(unit.id),
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

    try {
      const rawSmithersNodes = smithersNodeRowSchema.array().safeParse(
        db.query(
          "SELECT node_id, state, started_at_ms, completed_at_ms FROM _smithers_nodes WHERE run_id = ? ORDER BY iteration ASC",
        ).all(runId),
      );
      const rows = rawSmithersNodes.success ? rawSmithersNodes.data : [];

      for (const row of rows) {
        const parsed = parseNodeId(row.node_id);
        if (!parsed) continue;
        const base = {
          runId,
          nodeId: row.node_id,
          unitId: parsed.unitId,
          stageName: parsed.stageName,
          timestamp: row.started_at_ms ?? row.completed_at_ms ?? now,
        } as const;

        if (row.state === "in-progress") {
          events.push({ type: "node-started", ...base });
        } else if (row.state === "completed") {
          events.push({ type: "node-completed", ...base });
        } else if (row.state === "failed") {
          events.push({ type: "node-failed", ...base });
        }
      }
    } catch {
      // Optional tables may not exist in all runs.
    }

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
      try {
        const rawAttemptRows = smithersAttemptRowSchema.array().safeParse(
          db.query(
            "SELECT node_id, started_at_ms FROM _smithers_attempts WHERE run_id = ? AND state = 'in-progress' ORDER BY started_at_ms ASC",
          ).all(runId),
        );
        const rows = rawAttemptRows.success ? rawAttemptRows.data : [];

        for (const row of rows) {
          const parsed = parseNodeId(row.node_id);
          const ticketId = parsed?.unitId ?? null;
          const jobType = parsed ? `ticket:${parsed.stageName}` : row.node_id;
          events.push({
            type: "job-scheduled",
            timestamp: row.started_at_ms ?? now,
            jobType,
            agentId: "claude",
            ticketId,
            createdAtMs: row.started_at_ms ?? now,
          });
        }
      } catch {
        // attempts table may not exist depending on orchestrator version.
      }
    }

    const mergeQueueRows: OutputSnapshot["mergeQueueRows"] = [];
    try {
      const rawMergeQueueRows = mergeQueueRowSchema.array().safeParse(
        db.query(
          "SELECT iteration, tickets_landed, tickets_evicted, tickets_skipped, summary FROM merge_queue WHERE run_id = ? ORDER BY iteration ASC",
        ).all(runId),
      );
      const rows = rawMergeQueueRows.success ? rawMergeQueueRows.data : [];

      for (const row of rows) {
        const landed = parseObjectArray(row.tickets_landed);
        mergeQueueRows.push({
          nodeId: "merge-queue",
          ticketsLanded: landed
            .filter((item) => typeof item.ticketId === "string")
            .map((item) => ({
              ticketId: item.ticketId as string,
              mergeCommit: typeof item.mergeCommit === "string" ? item.mergeCommit : null,
              summary: typeof item.summary === "string" ? item.summary : row.summary ?? "",
              decisionIteration: typeof item.decisionIteration === "number" ? item.decisionIteration : null,
              testIteration: typeof item.testIteration === "number" ? item.testIteration : null,
              approvalSupersededRejection: item.approvalSupersededRejection === true,
            })),
          ticketsEvicted: parseObjectArray(row.tickets_evicted)
            .filter((item) => typeof item.ticketId === "string")
            .map((item) => ({
              ticketId: item.ticketId as string,
              reason: typeof item.reason === "string" ? item.reason : "evicted",
              details: typeof item.details === "string" ? item.details : "",
            })),
        });

        for (const item of landed) {
          if (typeof item.ticketId !== "string") continue;
          events.push({
            type: "merge-queue-landed",
            timestamp: now + row.iteration,
            runId,
            ticketId: item.ticketId,
            mergeCommit: typeof item.mergeCommit === "string" ? item.mergeCommit : null,
            summary: typeof item.summary === "string" ? item.summary : row.summary ?? "",
          });
        }

        for (const item of parseObjectArray(row.tickets_evicted)) {
          if (typeof item.ticketId !== "string") continue;
          events.push({
            type: "merge-queue-evicted",
            timestamp: now + row.iteration,
            runId,
            ticketId: item.ticketId,
            reason: typeof item.reason === "string" ? item.reason : "evicted",
            details: typeof item.details === "string" ? item.details : "",
          });
        }

        for (const item of parseObjectArray(row.tickets_skipped)) {
          if (typeof item.ticketId !== "string") continue;
          events.push({
            type: "merge-queue-skipped",
            timestamp: now + row.iteration,
            runId,
            ticketId: item.ticketId,
            reason: typeof item.reason === "string" ? item.reason : "skipped",
          });
        }
      }
    } catch {
      // merge_queue may not be initialized yet.
    }

    const allFinalReviewRows: FinalReviewRow[] = queryRows(
      db,
      "SELECT node_id, iteration, ready_to_move_on, approved, reasoning, quality_score FROM final_review WHERE run_id = ? ORDER BY iteration ASC",
      [runId],
      (row) => {
        const parsed = finalReviewRawRowSchema.safeParse(row);
        if (!parsed.success) return null;
        const r = parsed.data;
        if (!parseNodeId(r.node_id)) return null;
        return {
          nodeId: r.node_id,
          iteration: r.iteration,
          readyToMoveOn: Boolean(r.ready_to_move_on),
          approved: Boolean(r.approved),
          reasoning: r.reasoning ?? "",
          qualityScore: r.quality_score,
        };
      },
    );

    const allImplementRows: ImplementRow[] = queryRows(
      db,
      "SELECT node_id, iteration, what_was_done, files_created, files_modified, believes_complete, summary FROM implement WHERE run_id = ? ORDER BY iteration ASC",
      [runId],
      (row) => {
        const parsed = implementRawRowSchema.safeParse(row);
        if (!parsed.success) return null;
        const r = parsed.data;
        if (!parseNodeId(r.node_id)) return null;
        return {
          nodeId: r.node_id,
          iteration: r.iteration,
          whatWasDone: r.what_was_done ?? "",
          filesCreated: parseStringArray(r.files_created),
          filesModified: parseStringArray(r.files_modified),
          believesComplete: Boolean(r.believes_complete),
          summary: r.summary ?? undefined,
        };
      },
    );

    const allTestRows: TestRow[] = queryRows(
      db,
      "SELECT node_id, iteration, tests_passed, build_passed, failing_summary FROM test WHERE run_id = ? ORDER BY iteration ASC",
      [runId],
      (row) => {
        const parsed = testRawRowSchema.safeParse(row);
        if (!parsed.success) return null;
        const r = parsed.data;
        if (!parseNodeId(r.node_id)) return null;
        return {
          nodeId: r.node_id,
          iteration: r.iteration,
          testsPassed: Boolean(r.tests_passed),
          buildPassed: Boolean(r.build_passed),
          failingSummary: r.failing_summary,
        };
      },
    );

    const allReviewFixRows: ReviewFixRow[] = queryRows(
      db,
      "SELECT node_id, iteration, summary, all_issues_resolved, build_passed, tests_passed FROM review_fix WHERE run_id = ? ORDER BY iteration ASC",
      [runId],
      (row) => {
        const parsed = reviewFixRawRowSchema.safeParse(row);
        if (!parsed.success) return null;
        const r = parsed.data;
        if (!parseNodeId(r.node_id)) return null;
        return {
          nodeId: r.node_id,
          iteration: r.iteration,
          summary: r.summary ?? "",
          allIssuesResolved: Boolean(r.all_issues_resolved),
          buildPassed: Boolean(r.build_passed),
          testsPassed: Boolean(r.tests_passed),
        };
      },
    );

    const unitIds = new Set<string>();
    for (const row of [...allTestRows, ...allFinalReviewRows, ...allImplementRows, ...allReviewFixRows]) {
      if (row.nodeId) {
        const uid = extractUnitId(row.nodeId);
        if (uid) unitIds.add(uid);
      }
    }
    const snapshot = buildOutputSnapshot({
      mergeQueueRows,
      testRows: allTestRows,
      finalReviewRows: allFinalReviewRows,
      implementRows: allImplementRows,
      reviewFixRows: allReviewFixRows,
    });
    for (const unitId of unitIds) {
      const audit = getDecisionAudit(snapshot, unitId);
      if (!audit.finalDecision) continue;
      events.push({
        type: "final-review-decision",
        timestamp: now + audit.finalDecision.iteration,
        runId,
        unitId,
        iteration: audit.finalDecision.iteration,
        status: audit.finalDecision.status,
        reasoning: audit.finalDecision.reasoning,
        approvalSupersededRejection: audit.finalDecision.approvalSupersededRejection,
        approvalOnlyCorrectedFormatting: audit.finalDecision.approvalOnlyCorrectedFormatting,
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
