/**
 * File-Overlap Scheduler: Union-Find Grouping + WorkPlan Builder.
 *
 * Groups consumed tickets by file overlap using union-find,
 * then converts each group into a WorkPlan with sequential deps
 * for tickets on the same file and no deps between different files.
 */

import type { ConsumedTicket } from "../../adapters/linear/types";
import { slugify } from "../../cli/shared";
import type { WorkPlan, WorkUnit } from "./types";

// ── Types ───────────────────────────────────────────────────────────────

export type ParallelismGroup = {
  id: string;
  files: string[];
  tickets: ConsumedTicket[];
};

// ── groupByFileOverlap ──────────────────────────────────────────────────

/**
 * Partition tickets into parallelism groups using union-find on shared files.
 *
 * Tickets sharing a `primaryFile` are unioned into the same group.
 * Tickets with no `primaryFile` (metadata absent) each form their own
 * singleton group.
 */
export function groupByFileOverlap(
  tickets: ConsumedTicket[],
): ParallelismGroup[] {
  if (tickets.length === 0) return [];

  // Build file → ticket-index map
  const fileToTicketIdx = new Map<string, number[]>();
  for (let i = 0; i < tickets.length; i++) {
    const file = tickets[i]!.metadata?.primaryFile;
    if (!file) continue;
    const existing = fileToTicketIdx.get(file) ?? [];
    existing.push(i);
    fileToTicketIdx.set(file, existing);
  }

  // Union-Find with path compression
  const parent = tickets.map((_, i) => i);

  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  }

  function union(a: number, b: number): void {
    parent[find(a)] = find(b);
  }

  // Union tickets that share a file
  for (const indices of fileToTicketIdx.values()) {
    for (let i = 1; i < indices.length; i++) {
      union(indices[0]!, indices[i]!);
    }
  }

  // Collect groups by root
  const groups = new Map<number, number[]>();
  for (let i = 0; i < tickets.length; i++) {
    const root = find(i);
    const existing = groups.get(root) ?? [];
    existing.push(i);
    groups.set(root, existing);
  }

  return [...groups.values()].map((indices, groupIdx) => {
    const groupTickets = indices.map((i) => tickets[i]!);
    const files = [
      ...new Set(
        groupTickets
          .map((t) => t.metadata?.primaryFile)
          .filter((f): f is string => f != null),
      ),
    ];
    return { id: `group-${groupIdx}`, files, tickets: groupTickets };
  });
}

// ── groupToWorkPlan ─────────────────────────────────────────────────────

/**
 * Convert a parallelism group into a WorkPlan.
 *
 * Within the group, tickets on the same file are chained sequentially
 * (each depends on the previous). Tickets on different files have no
 * dependency relationship and can execute in parallel.
 */
export function groupToWorkPlan(
  group: ParallelismGroup,
  repoConfig: {
    projectName: string;
    buildCmds: Record<string, string>;
    testCmds: Record<string, string>;
  },
): WorkPlan {
  // Build per-file chains
  const fileChains = new Map<string, ConsumedTicket[]>();
  for (const ticket of group.tickets) {
    const file = ticket.metadata?.primaryFile ?? "__unknown__";
    const chain = fileChains.get(file) ?? [];
    chain.push(ticket);
    fileChains.set(file, chain);
  }

  const units: WorkUnit[] = [];
  for (const [, chain] of fileChains) {
    let prevId: string | null = null;
    for (const ticket of chain) {
      const unitId = slugify(ticket.issue.identifier);
      units.push({
        id: unitId,
        name: `${ticket.issue.identifier}: ${ticket.issue.title}`,
        rfcSections: [],
        description: ticket.rfcContent,
        deps: prevId ? [prevId] : [],
        acceptance: [
          "Implement the changes described in the issue",
          "All existing tests pass",
          "Add tests for new behavior where appropriate",
        ],
        tier: "small",
      });
      prevId = unitId;
    }
  }

  return {
    source: "linear-batch",
    generatedAt: new Date().toISOString(),
    repo: repoConfig,
    units,
  };
}

