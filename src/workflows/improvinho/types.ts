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

export const reviewFindingStatusSchema = z.enum([
  "draft",
  "confirmed",
  "projected",
  "rejected",
]);

export const reviewModeSchema = z.enum([
  "slice",
  "cross-cutting",
]);

export const reviewLensSchema = z.enum([
  "refactor-hunter",
  "type-system-purist",
  "app-logic-architecture",
]);

export const reviewSliceSchema = z.object({
  id: z.string(),
  mode: reviewModeSchema,
  path: z.string(),
  entryType: z.enum(["file", "directory", "virtual"]),
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

export const discoveredFindingSchema = z.object({
  kind: reviewKindSchema,
  priority: reviewPrioritySchema,
  confidence: reviewConfidenceSchema,
  summary: z.string(),
  evidence: z.string(),
  primaryFile: z.string(),
  lineRefs: z.array(z.string()),
  symbol: z.string().nullable(),
  pattern: z.string(),
  suggestedDiff: z.string().nullable(),
  acceptIf: z.string().nullable(),
  dismissIf: z.string().nullable(),
});

export const reviewFindingSchema = z.object({
  id: z.string(),
  lens: reviewLensSchema,
  status: reviewFindingStatusSchema,
  dedupeKey: z.string(),
  kind: reviewKindSchema,
  priority: reviewPrioritySchema,
  confidence: reviewConfidenceSchema,
  summary: z.string(),
  evidence: z.string(),
  primaryFile: z.string(),
  lineRefs: z.array(z.string()),
  symbol: z.string().nullable(),
  pattern: z.string(),
  suggestedDiff: z.string().nullable(),
  acceptIf: z.string().nullable(),
  dismissIf: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  scopeId: z.string(),
  scopeMode: reviewModeSchema,
  scopeLabel: z.string(),
  discoveredAt: z.string(),
});

export type ReviewKind = z.infer<typeof reviewKindSchema>;
export type ReviewPriority = z.infer<typeof reviewPrioritySchema>;
export type ReviewConfidence = z.infer<typeof reviewConfidenceSchema>;
export type ReviewFindingStatus = z.infer<typeof reviewFindingStatusSchema>;
export type ReviewMode = z.infer<typeof reviewModeSchema>;
export type ReviewLens = z.infer<typeof reviewLensSchema>;
export type ReviewSlice = z.infer<typeof reviewSliceSchema>;
export type ReviewPlan = z.infer<typeof reviewPlanSchema>;
export type DiscoveredFinding = z.infer<typeof discoveredFindingSchema>;
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;
