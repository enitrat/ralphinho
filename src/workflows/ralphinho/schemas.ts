/**
 * Output schemas for the scheduled workflow.
 *
 * These are the Zod schemas used by createSmithers() to auto-generate
 * SQLite tables. Each key becomes a table name, and each schema defines
 * the structured output that the AI agent must return.
 */

import { z } from "zod";

const issueSchema = z.object({
  severity: z.enum(["critical", "major", "minor"]),
  description: z.string(),
  file: z.string().nullable(),
  suggestion: z.string().nullable(),
  reference: z.string().nullable(),
});

export const scheduledOutputSchemas = {
  // ── Research ──────────────────────────────────────────────────────
  research: z.object({
    inputSignature: z.string(),
    contextFilePath: z.string(),
    findings: z.array(z.string()),
    referencesRead: z.array(z.string()),
    openQuestions: z.array(z.string()),
    notes: z.string().nullable(),
  }),

  // ── Plan ──────────────────────────────────────────────────────────
  plan: z.object({
    inputSignature: z.string(),
    planFilePath: z.string(),
    implementationSteps: z.array(z.string()),
    filesToCreate: z.array(z.string()),
    filesToModify: z.array(z.string()),
    complexity: z.enum(["small", "large"]),
  }),

  // ── Implement ─────────────────────────────────────────────────────
  implement: z.object({
    summary: z.string(),
    filesCreated: z.array(z.string()).nullable(),
    filesModified: z.array(z.string()).nullable(),
    whatWasDone: z.string(),
    nextSteps: z.string().nullable(),
    believesComplete: z.boolean(),
  }),

  // ── Test ──────────────────────────────────────────────────────────
  test: z.object({
    buildPassed: z.boolean(),
    testsPassed: z.boolean(),
    testsPassCount: z.number(),
    testsFailCount: z.number(),
    failingSummary: z.string().nullable(),
    testOutput: z.string(),
  }),

  // ── PRD Review ────────────────────────────────────────────────────
  prd_review: z.object({
    severity: z.enum(["critical", "major", "minor", "none"]),
    approved: z.boolean(),
    feedback: z.string(),
    issues: z.array(issueSchema).nullable(),
  }),

  // ── Code Review ───────────────────────────────────────────────────
  code_review: z.object({
    severity: z.enum(["critical", "major", "minor", "none"]),
    approved: z.boolean(),
    feedback: z.string(),
    issues: z.array(issueSchema).nullable(),
  }),

  // ── Review Fix ────────────────────────────────────────────────────
  review_fix: z.object({
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
    buildPassed: z.boolean(),
    testsPassed: z.boolean(),
  }),

  // ── Final Review (the gate) ───────────────────────────────────────
  final_review: z.object({
    readyToMoveOn: z.boolean(),
    reasoning: z.string(),
    approved: z.boolean(),
    qualityScore: z.number(),
    remainingIssues: z
      .array(
        z.object({
          severity: z.enum(["critical", "major", "minor"]),
          description: z.string(),
          file: z.string().nullable(),
        }),
      )
      .nullable(),
  }),

  // ── Learnings Extraction ────────────────────────────────────────────
  learnings: z.object({
    learningsFilePath: z.string(),
    patterns: z.array(
      z.object({
        pattern: z.string(),
        category: z.enum([
          "code-quality",
          "testing",
          "architecture",
          "error-handling",
          "performance",
          "security",
          "naming",
          "other",
        ]),
        description: z.string(),
        example: z.string().nullable(),
        frequency: z.enum(["one-off", "recurring"]),
      }),
    ),
    summary: z.string(),
  }),

  // ── Pass Tracker ──────────────────────────────────────────────────
  pass_tracker: z.object({
    totalIterations: z.number(),
    unitsRun: z.array(z.string()),
    unitsComplete: z.array(z.string()),
    unitsLanded: z.array(z.string()),
    unitsSemanticallyComplete: z.array(z.string()),
    summary: z.string(),
  }),

  // ── Completion Report ────────────────────────────────────────────
  completion_report: z.object({
    totalUnits: z.number(),
    unitsLanded: z.array(z.string()),
    unitsSemanticallyComplete: z.array(z.string()),
    unitsFailed: z.array(
      z.object({
        unitId: z.string(),
        lastStage: z.string(),
        reason: z.string(),
      }),
    ),
    passesUsed: z.number(),
    summary: z.string(),
    nextSteps: z.array(z.string()),
  }),

  // ── PR Creation Result ──────────────────────────────────────────────
  pr_creation: z.object({
    ticketsPushed: z.array(z.object({
      ticketId: z.string(),
      branch: z.string(),
      prUrl: z.string().nullable(),
      prNumber: z.number().nullable(),
      summary: z.string(),
    })),
    ticketsFailed: z.array(z.object({
      ticketId: z.string(),
      reason: z.string(),
    })),
    summary: z.string(),
  }),

  // ── Merge Queue Result (per-layer batch) ──────────────────────────
  // Land status is read directly from this output.
  // unitLanded()/unitEvicted() scan ticketsLanded/ticketsEvicted.
  merge_queue: z.object({
    ticketsLanded: z.array(z.object({
      ticketId: z.string(),
      mergeCommit: z.string().nullable(),
      summary: z.string(),
      decisionIteration: z.number().nullable(),
      testIteration: z.number().nullable(),
      approvalSupersededRejection: z.boolean(),
    })),
    ticketsEvicted: z.array(z.object({
      ticketId: z.string(),
      reason: z.string(),
      details: z.string(),
    })),
    ticketsSkipped: z.array(z.object({
      ticketId: z.string(),
      reason: z.string(),
    })),
    summary: z.string(),
    nextActions: z.string().nullable(),
  }),
};
