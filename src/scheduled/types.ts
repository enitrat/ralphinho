/**
 * Scheduled Work types — work plan, work units, and dependency DAG.
 *
 * A work plan is the output of RFC decomposition: a set of work units
 * with a dependency graph that determines execution order and parallelism.
 */

import { z } from "zod";

// ── Work Unit ─────────────────────────────────────────────────────────

export const workUnitSchema = z.object({
  /** Unique identifier (kebab-case, e.g. "metadata-cleanup") */
  id: z.string(),
  /** Human-readable name */
  name: z.string(),
  /** Which RFC sections this unit addresses */
  rfcSections: z.array(z.string()),
  /** Detailed description of what needs to be done */
  description: z.string(),
  /** IDs of units that must complete before this one can start */
  deps: z.array(z.string()),
  /** Concrete acceptance criteria — what must be true when this unit is done */
  acceptance: z.array(z.string()),
  /** Complexity tier — determines quality pipeline depth */
  tier: z.enum(["trivial", "small", "medium", "large"]),
});

export type WorkUnit = z.infer<typeof workUnitSchema>;

// ── Work Plan ─────────────────────────────────────────────────────────

export const workPlanSchema = z.object({
  /** Path to the source RFC file */
  source: z.string(),
  /** When this plan was generated */
  generatedAt: z.string(),
  /** Repo-detected configuration */
  repo: z.object({
    projectName: z.string(),
    buildCmds: z.record(z.string(), z.string()),
    testCmds: z.record(z.string(), z.string()),
  }),
  /** The work units with their dependency graph */
  units: z.array(workUnitSchema),
});

export type WorkPlan = z.infer<typeof workPlanSchema>;

// ── Ralphinho Config ──────────────────────────────────────────────────

export const ralphinhoConfigSchema = z.object({
  /** Workflow mode */
  mode: z.literal("scheduled-work"),
  /** Absolute path to repo root */
  repoRoot: z.string(),
  /** For scheduled-work: path to the source RFC file */
  rfcPath: z.string().optional(),
  /** Detected agents */
  agents: z.object({
    claude: z.boolean(),
    codex: z.boolean(),
    gh: z.boolean(),
  }),
  /** Max concurrency for parallel work units */
  maxConcurrency: z.number(),
  /** When this config was created */
  createdAt: z.string(),
});

export type RalphinhoConfig = z.infer<typeof ralphinhoConfigSchema>;

// ── Tier Pipeline Stages ──────────────────────────────────────────────

/**
 * Quality pipeline stages per tier for scheduled work.
 * These always include review steps because scheduled work is
 * driven by a spec (the RFC).
 */
export const SCHEDULED_TIERS = {
  trivial: ["implement", "test"] as const,
  small: [
    "implement",
    "test",
    "code-review",
  ] as const,
  medium: [
    "research",
    "plan",
    "implement",
    "test",
    "prd-review",
    "code-review",
    "review-fix",
  ] as const,
  large: [
    "research",
    "plan",
    "implement",
    "test",
    "prd-review",
    "code-review",
    "review-fix",
    "final-review",
  ] as const,
} as const;

export type ScheduledTier = keyof typeof SCHEDULED_TIERS;

// ── DAG Utilities ─────────────────────────────────────────────────────

/**
 * Validate that the dependency graph has no cycles and all dep references
 * point to existing units.
 */
export function validateDAG(units: WorkUnit[]): {
  valid: boolean;
  errors: string[];
} {
  const ids = new Set(units.map((u) => u.id));
  const errors: string[] = [];

  // Check all deps reference existing units
  for (const unit of units) {
    for (const dep of unit.deps) {
      if (!ids.has(dep)) {
        errors.push(
          `Unit "${unit.id}" depends on "${dep}" which does not exist`,
        );
      }
    }
  }

  // Check for cycles using DFS
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(id: string): boolean {
    if (inStack.has(id)) return true; // cycle
    if (visited.has(id)) return false;

    visited.add(id);
    inStack.add(id);

    const unit = units.find((u) => u.id === id);
    if (unit) {
      for (const dep of unit.deps) {
        if (dfs(dep)) {
          errors.push(`Cycle detected involving "${id}" → "${dep}"`);
          return true;
        }
      }
    }

    inStack.delete(id);
    return false;
  }

  for (const unit of units) {
    dfs(unit.id);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Compute topological layers: groups of units that can run in parallel.
 * Layer 0 = units with no deps, layer 1 = units whose deps are all in layer 0, etc.
 */
export function computeLayers(units: WorkUnit[]): WorkUnit[][] {
  const unitMap = new Map(units.map((u) => [u.id, u]));
  const layerOf = new Map<string, number>();

  function getLayer(id: string): number {
    if (layerOf.has(id)) return layerOf.get(id)!;

    const unit = unitMap.get(id);
    if (!unit || unit.deps.length === 0) {
      layerOf.set(id, 0);
      return 0;
    }

    const maxDepLayer = Math.max(...unit.deps.map((d) => getLayer(d)));
    const layer = maxDepLayer + 1;
    layerOf.set(id, layer);
    return layer;
  }

  for (const unit of units) {
    getLayer(unit.id);
  }

  const maxLayer = Math.max(...Array.from(layerOf.values()), 0);
  const layers: WorkUnit[][] = [];

  for (let i = 0; i <= maxLayer; i++) {
    layers.push(
      units.filter((u) => layerOf.get(u.id) === i),
    );
  }

  return layers;
}
