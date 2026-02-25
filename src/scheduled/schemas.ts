/**
 * Output schemas for Scheduled Work mode.
 *
 * These are the Zod schemas used by createSmithers() to auto-generate
 * SQLite tables. Each key becomes a table name, and each schema defines
 * the structured output that the AI agent must return.
 *
 * Prefixed with "sw_" to avoid collisions with super-ralph schemas
 * if both modes share the same database in the future.
 */

import { z } from "zod";

const issueSchema = z.object({
  severity: z.enum(["critical", "major", "minor"]),
  description: z.string(),
  file: z.string().nullable().optional(),
  suggestion: z.string().nullable().optional(),
  reference: z.string().nullable().optional(),
});

export const scheduledOutputSchemas = {
  // ── Research ──────────────────────────────────────────────────────
  sw_research: z.object({
    contextFilePath: z.string(),
    findings: z.array(z.string()),
    referencesRead: z.array(z.string()),
    openQuestions: z.array(z.string()),
    notes: z.string().nullable().optional(),
  }),

  // ── Plan ──────────────────────────────────────────────────────────
  sw_plan: z.object({
    planFilePath: z.string(),
    implementationSteps: z.array(z.string()),
    filesToCreate: z.array(z.string()),
    filesToModify: z.array(z.string()),
    complexity: z.enum(["trivial", "small", "medium", "large"]),
  }),

  // ── Implement ─────────────────────────────────────────────────────
  sw_implement: z.object({
    summary: z.string(),
    filesCreated: z.array(z.string()).nullable(),
    filesModified: z.array(z.string()).nullable(),
    whatWasDone: z.string(),
    nextSteps: z.string().nullable(),
    believesComplete: z.boolean(),
  }),

  // ── Test ──────────────────────────────────────────────────────────
  sw_test: z.object({
    buildPassed: z.boolean(),
    testsPassed: z.boolean(),
    testsPassCount: z.number(),
    testsFailCount: z.number(),
    failingSummary: z.string().nullable(),
    testOutput: z.string(),
  }),

  // ── PRD Review ────────────────────────────────────────────────────
  sw_prd_review: z.object({
    severity: z.enum(["critical", "major", "minor", "none"]),
    approved: z.boolean(),
    feedback: z.string(),
    issues: z.array(issueSchema).nullable(),
  }),

  // ── Code Review ───────────────────────────────────────────────────
  sw_code_review: z.object({
    severity: z.enum(["critical", "major", "minor", "none"]),
    approved: z.boolean(),
    feedback: z.string(),
    issues: z.array(issueSchema).nullable(),
  }),

  // ── Review Fix ────────────────────────────────────────────────────
  sw_review_fix: z.object({
    summary: z.string(),
    fixesMade: z.array(
      z.object({
        issue: z.string(),
        fix: z.string(),
        file: z.string().nullable(),
      }),
    ),
    falsePositives: z.array(
      z.object({
        issue: z.string(),
        reasoning: z.string(),
      }),
    ),
    allIssuesResolved: z.boolean(),
  }),

  // ── Final Review (the gate) ───────────────────────────────────────
  sw_final_review: z.object({
    readyToMoveOn: z.boolean(),
    reasoning: z.string(),
    approved: z.boolean(),
    qualityScore: z.number(),
    remainingIssues: z
      .array(
        z.object({
          severity: z.enum(["critical", "major", "minor"]),
          description: z.string(),
          file: z.string().nullable().optional(),
        }),
      )
      .nullable(),
  }),

  // ── Pass Tracker ──────────────────────────────────────────────────
  sw_pass_tracker: z.object({
    totalIterations: z.number(),
    unitsRun: z.array(z.string()),
    unitsComplete: z.array(z.string()),
    summary: z.string(),
  }),
};
