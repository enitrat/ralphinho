/**
 * Serializable Linear types — plain objects safe for cross-module passing.
 * The SDK models use lazy-loaded relations which don't serialize cleanly.
 */

export type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  priorityLabel: string;
  state: { id: string; name: string; type: string } | null;
  assignee: { id: string; name: string; email: string } | null;
  labels: { id: string; name: string }[];
  project: { id: string; name: string } | null;
  url: string;
};

export type LinearTeam = {
  id: string;
  name: string;
  key: string;
};

export type LinearLabel = {
  id: string;
  name: string;
};

export type PushFindingsResult = {
  created: {
    findingDisplayId: string;
    linearIssueId: string;
    identifier: string;
    url: string;
  }[];
  skipped: number;
};

export type ConsumedTicket = {
  issue: LinearIssue;
  /** Markdown RFC content generated from the ticket */
  rfcContent: string;
};
