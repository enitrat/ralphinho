import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type Database from "better-sqlite3";

import type { ReviewTicket } from "./types";

type StoredReviewTicket = ReviewTicket & {
  dedupeKey: string;
};

type ProjectedTicketRecord = StoredReviewTicket & {
  id: string;
  status: "open";
  discoveredAt: string;
  runId: string;
};

type TicketIndex = {
  generatedAt: string;
  runId: string;
  lastId: number;
  tickets: ProjectedTicketRecord[];
};

type ReviewTicketRow = {
  run_id: string;
  iteration: number;
  tickets: string;
};

function escapeYaml(value: string): string {
  return JSON.stringify(value);
}

function parseTicketId(value: string): number {
  const match = /^IMP-(\d+)$/.exec(value);
  return match ? Number(match[1]) : 0;
}

function nextTicketId(lastId: number): string {
  return `IMP-${String(lastId).padStart(4, "0")}`;
}

async function ensureTicketDirs(root: string): Promise<void> {
  await mkdir(join(root, "open", "critical"), { recursive: true });
  await mkdir(join(root, "open", "high"), { recursive: true });
  await mkdir(join(root, "open", "medium"), { recursive: true });
  await mkdir(join(root, "open", "low"), { recursive: true });
  await mkdir(join(root, "accepted"), { recursive: true });
  await mkdir(join(root, "archived"), { recursive: true });
}

async function loadExistingIndex(root: string): Promise<TicketIndex | null> {
  const indexPath = join(root, "index.json");
  if (!existsSync(indexPath)) return null;

  try {
    return JSON.parse(await readFile(indexPath, "utf8")) as TicketIndex;
  } catch {
    return null;
  }
}

function loadReviewTicketsFromDb(
  db: Database.Database,
  runId: string,
): Map<string, ProjectedTicketRecord> {
  const rows = db.prepare(
    `
      SELECT run_id, iteration, tickets
      FROM review_ticket
      WHERE run_id = ?
      ORDER BY iteration ASC
    `,
  ).all(runId) as ReviewTicketRow[];

  const deduped = new Map<string, ProjectedTicketRecord>();

  for (const row of rows) {
    const tickets = JSON.parse(row.tickets) as StoredReviewTicket[];
    for (const ticket of tickets) {
      if (!ticket.requiresHumanReview) continue;

      deduped.set(ticket.dedupeKey, {
        ...ticket,
        id: "",
        status: "open",
        discoveredAt: new Date().toISOString(),
        runId: row.run_id,
      });
    }
  }

  return deduped;
}

function formatTicketMarkdown(ticket: ProjectedTicketRecord): string {
  const alternativesSection = ticket.alternatives && ticket.alternatives.length > 0
    ? [
        "## Alternatives",
        ...ticket.alternatives.map((entry) => `- ${entry}`),
        "",
      ].join("\n")
    : "";
  const reproSection = ticket.reproOrTrace
    ? `## Repro Or Trace\n${ticket.reproOrTrace}\n\n`
    : "## Repro Or Trace\nNo minimal repro was captured beyond the evidence bundle.\n\n";

  return [
    "---",
    `id: ${ticket.id}`,
    "status: open",
    `kind: ${ticket.kind}`,
    `priority: ${ticket.priority}`,
    `confidence: ${ticket.confidence}`,
    `area: ${escapeYaml(ticket.area)}`,
    `primary_file: ${escapeYaml(ticket.primaryFile)}`,
    "line_refs:",
    ...ticket.lineRefs.map((lineRef) => `  - ${escapeYaml(lineRef)}`),
    `dedupe_key: ${escapeYaml(ticket.dedupeKey)}`,
    `discovered_at: ${escapeYaml(ticket.discoveredAt)}`,
    `run_id: ${escapeYaml(ticket.runId)}`,
    "---",
    "",
    `# ${ticket.id} - ${ticket.summary}`,
    "",
    "## Summary",
    ticket.summary,
    "",
    "## Why It Matters",
    ticket.whyItMatters,
    "",
    "## Evidence",
    ...ticket.evidence.map((entry) => `- ${entry}`),
    "",
    reproSection,
    alternativesSection,
    "## Quick Triage",
    ticket.quickTriage,
    "",
    "## Accept If",
    ...ticket.acceptIf.map((entry) => `- ${entry}`),
    "",
    "## Dismiss If",
    ...ticket.dismissIf.map((entry) => `- ${entry}`),
    "",
  ].join("\n");
}

function formatSummaryMarkdown(tickets: ProjectedTicketRecord[]): string {
  const orderedPriorities = ["critical", "high", "medium", "low"] as const;
  const lines = ["# Improvinho Summary", ""];

  for (const priority of orderedPriorities) {
    const matching = tickets.filter((ticket) => ticket.priority === priority);
    lines.push(`## ${priority[0]!.toUpperCase()}${priority.slice(1)}`);
    if (matching.length === 0) {
      lines.push("No open tickets.");
      lines.push("");
      continue;
    }

    for (const ticket of matching) {
      lines.push(`- ${ticket.id} — ${ticket.summary} (${ticket.primaryFile})`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

export function resolveLatestReviewRunId(db: Database.Database): string | null {
  const row = db.prepare(
    `
      SELECT run_id
      FROM completion_report
      ORDER BY iteration DESC
      LIMIT 1
    `,
  ).get() as { run_id?: string } | undefined;

  return row?.run_id ?? null;
}

export async function projectReviewTicketsFromDb(options: {
  repoRoot: string;
  db: Database.Database;
  runId: string;
}): Promise<TicketIndex> {
  const { repoRoot, db, runId } = options;
  const ticketsRoot = join(repoRoot, ".tickets");
  await ensureTicketDirs(ticketsRoot);

  const existingIndex = await loadExistingIndex(ticketsRoot);
  const existingByKey = new Map(
    (existingIndex?.tickets ?? []).map((ticket) => [ticket.dedupeKey, ticket]),
  );

  let lastId = existingIndex?.lastId
    ?? Math.max(0, ...(existingIndex?.tickets ?? []).map((ticket) => parseTicketId(ticket.id)));

  const deduped = loadReviewTicketsFromDb(db, runId);
  const tickets = [...deduped.values()]
    .sort((left, right) => {
      if (left.priority !== right.priority) return left.priority.localeCompare(right.priority);
      return left.dedupeKey.localeCompare(right.dedupeKey);
    })
    .map((ticket) => {
      const existing = existingByKey.get(ticket.dedupeKey);
      if (existing) {
        return {
          ...ticket,
          id: existing.id,
          discoveredAt: existing.discoveredAt,
        };
      }

      lastId += 1;
      return {
        ...ticket,
        id: nextTicketId(lastId),
      };
    });

  await rm(join(ticketsRoot, "open"), { recursive: true, force: true });
  await ensureTicketDirs(ticketsRoot);

  for (const ticket of tickets) {
    const filePath = join(ticketsRoot, "open", ticket.priority, `${ticket.id}.md`);
    await writeFile(filePath, formatTicketMarkdown(ticket), "utf8");
  }

  const summary = formatSummaryMarkdown(tickets);
  await writeFile(join(ticketsRoot, "summary.md"), summary, "utf8");

  const index: TicketIndex = {
    generatedAt: new Date().toISOString(),
    runId,
    lastId,
    tickets,
  };
  await writeFile(
    join(ticketsRoot, "index.json"),
    `${JSON.stringify(index, null, 2)}\n`,
    "utf8",
  );

  return index;
}
