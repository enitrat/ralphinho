import { z } from "zod";

export const reviewKindSchema = z.enum([
  "bug",
  "security",
  "simplification",
  "architecture",
  "test-gap",
]);

export const reviewPrioritySchema = z.enum([
  "critical",
  "high",
  "medium",
  "low",
]);

export const reviewConfidenceSchema = z.enum([
  "high",
  "medium",
  "low",
]);

export const reviewSliceSchema = z.object({
  id: z.string(),
  path: z.string(),
  entryType: z.enum(["file", "directory"]),
  focusAreas: z.array(z.string()),
  rationale: z.string(),
  risk: z.enum(["high", "medium", "low"]),
  inferredPaths: z.array(z.string()),
});

export const reviewPlanSchema = z.object({
  source: z.string().nullable(),
  instruction: z.string(),
  generatedAt: z.string(),
  repo: z.object({
    projectName: z.string(),
    buildCmds: z.record(z.string(), z.string()),
    testCmds: z.record(z.string(), z.string()),
  }),
  slices: z.array(reviewSliceSchema),
});

export const candidateIssueSchema = z.object({
  candidateId: z.string(),
  dedupeKey: z.string(),
  kind: reviewKindSchema,
  priority: reviewPrioritySchema,
  confidence: reviewConfidenceSchema,
  summary: z.string(),
  primaryFile: z.string(),
  lineRefs: z.array(z.string()),
  whyItMayMatter: z.string(),
});

export const auditedIssueSchema = z.object({
  candidateId: z.string(),
  dedupeKey: z.string(),
  kind: reviewKindSchema,
  priority: reviewPrioritySchema,
  confidence: reviewConfidenceSchema,
  confirmed: z.boolean(),
  summary: z.string(),
  whyItMatters: z.string(),
  evidence: z.array(z.string()),
  lineRefs: z.array(z.string()),
  reproOrTrace: z.string().nullable(),
  alternatives: z.array(z.string()).nullable(),
  quickTriage: z.string(),
  acceptIf: z.array(z.string()),
  dismissIf: z.array(z.string()),
  rejectionReason: z.string().nullable(),
  primaryFile: z.string(),
});

export const reviewTicketSchema = z.object({
  dedupeKey: z.string(),
  kind: reviewKindSchema,
  priority: reviewPrioritySchema,
  confidence: reviewConfidenceSchema,
  summary: z.string(),
  whyItMatters: z.string(),
  evidence: z.array(z.string()),
  lineRefs: z.array(z.string()),
  reproOrTrace: z.string().nullable(),
  alternatives: z.array(z.string()).nullable(),
  quickTriage: z.string(),
  acceptIf: z.array(z.string()),
  dismissIf: z.array(z.string()),
  primaryFile: z.string(),
  area: z.string(),
  requiresHumanReview: z.boolean(),
});

export type ReviewKind = z.infer<typeof reviewKindSchema>;
export type ReviewPriority = z.infer<typeof reviewPrioritySchema>;
export type ReviewConfidence = z.infer<typeof reviewConfidenceSchema>;
export type ReviewSlice = z.infer<typeof reviewSliceSchema>;
export type ReviewPlan = z.infer<typeof reviewPlanSchema>;
export type CandidateIssue = z.infer<typeof candidateIssueSchema>;
export type AuditedIssue = z.infer<typeof auditedIssueSchema>;
export type ReviewTicket = z.infer<typeof reviewTicketSchema>;
