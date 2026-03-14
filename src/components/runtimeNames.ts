function sanitizeSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "") || "run";
}

export function buildRunScope(runId: string): string {
  return sanitizeSegment(runId);
}

export function buildUnitBranchPrefix(runId: string, basePrefix = "unit/"): string {
  const normalizedBase = basePrefix.endsWith("/") ? basePrefix : `${basePrefix}/`;
  return `${normalizedBase}${buildRunScope(runId)}/`;
}

export function buildUnitWorktreePath(runId: string, unitId: string): string {
  return `/tmp/workflow-wt-${buildRunScope(runId)}-${sanitizeSegment(unitId)}`;
}
