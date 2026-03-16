import { z } from "zod";

import {
  auditedIssueSchema,
  candidateIssueSchema,
  reviewTicketSchema,
} from "./types";

export const reviewOutputSchemas = {
  slice_plan: z.object({
    totalSlices: z.number(),
    sliceIds: z.array(z.string()),
    summary: z.string(),
  }),

  candidate_issue: z.object({
    sliceId: z.string(),
    passNumber: z.number(),
    inputSignature: z.string(),
    discoverySummary: z.string(),
    candidates: z.array(candidateIssueSchema),
  }),

  audited_issue: z.object({
    sliceId: z.string(),
    passNumber: z.number(),
    audited: z.array(auditedIssueSchema),
    confirmedCount: z.number(),
    rejectedCount: z.number(),
    summary: z.string(),
  }),

  review_ticket: z.object({
    sliceId: z.string(),
    passNumber: z.number(),
    tickets: z.array(reviewTicketSchema),
    newConfirmedCount: z.number(),
    summary: z.string(),
  }),

  ticket_write: z.object({
    passNumber: z.number(),
    ticketCount: z.number(),
    newTicketCount: z.number(),
    summary: z.string(),
  }),

  pass_tracker: z.object({
    totalIterations: z.number(),
    slicesRun: z.array(z.string()),
    slicesComplete: z.array(z.string()),
    newConfirmedTickets: z.number(),
    zeroNewPasses: z.number(),
    summary: z.string(),
  }),

  completion_report: z.object({
    totalSlices: z.number(),
    slicesComplete: z.array(z.string()),
    slicesRemaining: z.array(z.string()),
    totalConfirmedTickets: z.number(),
    openTicketCount: z.number(),
    passesUsed: z.number(),
    zeroNewPasses: z.number(),
    summary: z.string(),
    nextSteps: z.array(z.string()),
  }),
};
