import { scheduledOutputSchemas } from "../schemas";

/**
 * Resolve a table identifier (string key or Zod schema object) to
 * the corresponding string key in scheduledOutputSchemas.
 *
 * Smithers' ctx.latest() accepts both forms; test mocks need to
 * normalise to strings for Map lookups.
 */
export function resolveTableName(table: unknown): string {
  if (typeof table === "string") return table;
  for (const [key, schema] of Object.entries(scheduledOutputSchemas)) {
    if (schema === table) return key;
  }
  return String(table);
}
