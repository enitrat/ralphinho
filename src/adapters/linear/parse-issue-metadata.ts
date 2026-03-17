export type IssueMetadata = {
  kind: string | null;
  priority: string | null;
  confidence: string | null;
  primaryFile: string | null;
  lineRefs: string[];
  symbol: string | null;
};

const NULL_METADATA: IssueMetadata = {
  kind: null,
  priority: null,
  confidence: null,
  primaryFile: null,
  lineRefs: [],
  symbol: null,
};

function extractField(description: string, key: string): string | null {
  const re = new RegExp(`\\*\\*${key}:\\*\\*\\s*\`?([^\`\\n]+)\`?`);
  const match = description.match(re);
  if (!match) return null;
  return match[1]!.trim().replace(/^`|`$/g, "");
}

export function parseIssueMetadata(description: string | null): IssueMetadata {
  if (!description) return { ...NULL_METADATA, lineRefs: [] };

  const kind = extractField(description, "Kind");
  const priority = extractField(description, "Priority");
  const confidence = extractField(description, "Confidence");
  const primaryFile = extractField(description, "File");
  const symbol = extractField(description, "Symbol");

  // Lines needs special handling: split on comma, trim, strip backticks
  let lineRefs: string[] = [];
  const linesRe = /\*\*Lines:\*\*\s*([^\n]+)/;
  const linesMatch = description.match(linesRe);
  if (linesMatch) {
    lineRefs = linesMatch[1]!
      .split(",")
      .map((s) => s.trim().replace(/^`|`$/g, ""))
      .filter((s) => s.length > 0);
  }

  return { kind, priority, confidence, primaryFile, lineRefs, symbol };
}
