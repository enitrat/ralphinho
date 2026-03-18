/**
 * Local types for improvinho/ralphinho Linear adapters.
 * Core Linear types (LinearIssue, LinearTeam, etc.) come from smithers-orchestrator/linear.
 */

import { LinearIssue } from "../../linear";

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
  /** Parsed metadata from improvinho-formatted description */
  metadata?: import("./parse-issue-metadata").IssueMetadata;
};
