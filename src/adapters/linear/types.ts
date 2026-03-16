/**
 * Local types for improvinho/ralphinho Linear adapters.
 * Core Linear types (LinearIssue, LinearTeam, etc.) come from smithers-orchestrator/linear.
 */

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
  issue: import("smithers-orchestrator/linear").LinearIssue;
  /** Markdown RFC content generated from the ticket */
  rfcContent: string;
};
