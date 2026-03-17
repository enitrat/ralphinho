/**
 * Shared utilities for building markdown tables from ticket data.
 *
 * Used by AgenticMergeQueue and PushAndCreatePR to avoid duplicating
 * file-summary computation and markdown table construction.
 */

/** Minimal ticket shape needed for file summary computation. */
export type TicketWithFiles = {
  filesModified: string[];
  filesCreated: string[];
};

/**
 * Compute a human-readable summary of files touched by a ticket.
 * Shows up to `maxFiles` file paths; if more exist, appends "(+N more)".
 * Returns "(unknown)" when no files are listed.
 */
export function buildFileSummary(
  ticket: TicketWithFiles,
  maxFiles: number = 5,
): string {
  const allFiles = [
    ...(ticket.filesModified ?? []),
    ...(ticket.filesCreated ?? []),
  ];
  if (allFiles.length === 0) return "(unknown)";
  const shown = allFiles.slice(0, maxFiles).join(", ");
  return allFiles.length > maxFiles
    ? `${shown} (+${allFiles.length - maxFiles} more)`
    : shown;
}

/** Column definition for a markdown table. */
export type MarkdownColumn<T> = {
  header: string;
  separator: string;
  cell: (row: T, index: number) => string;
};

/**
 * Build a markdown table from column definitions and row data.
 */
export function buildMarkdownTable<T>(
  columns: MarkdownColumn<T>[],
  rows: T[],
): string {
  const header = "| " + columns.map((c) => c.header).join(" | ") + " |";
  const separator = "|" + columns.map((c) => c.separator).join("|") + "|";
  const body = rows.map(
    (row, i) =>
      "| " + columns.map((c) => c.cell(row, i)).join(" | ") + " |",
  );
  return [header, separator, ...body].join("\n");
}
