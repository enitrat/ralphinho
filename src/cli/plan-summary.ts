/**
 * CLI-layer plan summary printer — terminal I/O kept out of the domain layer.
 */

import type { WorkPlan, WorkUnit } from "../workflows/ralphinho/types";

/**
 * Pretty-print a work plan summary to the console.
 */
export function printPlanSummary(
  plan: WorkPlan,
  layers: WorkUnit[][],
): void {
  const tierCounts = { small: 0, large: 0 };
  for (const u of plan.units) {
    tierCounts[u.tier]++;
  }

  console.log(
    `\n  Generated ${plan.units.length} work units in ${layers.length} parallelizable layers\n`,
  );

  console.log("  Tiers:");
  for (const [tier, count] of Object.entries(tierCounts)) {
    if (count > 0) console.log(`    ${tier}: ${count}`);
  }

  console.log("\n  Execution layers (units in same layer run in parallel):");
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    const names = layer.map((u) => u.id).join(", ");
    console.log(`    Layer ${i}: [${names}]`);
  }

  console.log();
}
