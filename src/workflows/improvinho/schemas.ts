import { z } from "zod";

import {
  discoveredFindingSchema,
  reviewLensSchema,
  reviewFindingSchema,
} from "./types";

export const reviewOutputSchemas = {
  slice_plan: z.object({
    totalSlices: z.number(),
    localSliceIds: z.array(z.string()),
    crossCuttingSliceId: z.string().nullable(),
    summary: z.string(),
  }),

  discovery_result: z.object({
    sliceId: z.string(),
    mode: z.enum(["slice", "cross-cutting"]),
    lens: reviewLensSchema,
    inputSignature: z.string(),
    discoverySummary: z.string(),
    findings: z.array(discoveredFindingSchema),
  }),

  finding: z.object({
    sliceId: z.string(),
    mode: z.enum(["slice", "cross-cutting"]),
    findings: z.array(reviewFindingSchema),
    confirmedCount: z.number(),
    rejectedCount: z.number(),
    summary: z.string(),
  }),

  merge_report: z.object({
    rawFindingCount: z.number(),
    confirmedFindingCount: z.number(),
    mergedFindingCount: z.number(),
    summaryPath: z.string(),
    summary: z.string(),
  }),

  completion_report: z.object({
    totalSlices: z.number(),
    localSlicesComplete: z.array(z.string()),
    crossCuttingSliceComplete: z.boolean(),
    totalFindings: z.number(),
    confirmedFindings: z.number(),
    rejectedFindings: z.number(),
    mergedFindings: z.number(),
    summary: z.string(),
    nextSteps: z.array(z.string()),
  }),
};
