import { describe, expect, test } from "bun:test";
import React from "react";
import { z } from "zod";
import { scheduledOutputSchemas } from "../../schemas";

// Lazy imports — these don't exist yet (RED phase)
import {
  prCreationResultSchema,
  PushAndCreatePR,
  type PushAndCreatePRTicket,
} from "../PushAndCreatePR";

// ── Helpers ──────────────────────────────────────────────────────────

function collectTasks(node: React.ReactNode): Record<string, Record<string, unknown>> {
  const tasks: Record<string, Record<string, unknown>> = {};

  function walk(current: React.ReactNode): void {
    if (!React.isValidElement(current)) return;
    const props = (current as React.ReactElement).props as Record<string, unknown>;
    const id = props.id;
    if (typeof id === "string") {
      tasks[id] = props;
    }
    const children = props.children;
    if (Array.isArray(children)) {
      for (const child of children) walk(child);
      return;
    }
    if (children != null) {
      walk(children as React.ReactNode);
    }
  }

  walk(node);
  return tasks;
}

function makeTicket(overrides?: Partial<PushAndCreatePRTicket>): PushAndCreatePRTicket {
  return {
    ticketId: "unit-1",
    ticketTitle: "Add auth module",
    branch: "unit/run-1/unit-1",
    worktreePath: "/tmp/workflow-wt-run-1-unit-1",
    filesModified: ["src/auth.ts"],
    filesCreated: ["src/auth.test.ts"],
    ...overrides,
  };
}

function createCtx() {
  return {
    runId: "run-1",
    latest: () => null,
  } as any;
}

// ── Schema tests ─────────────────────────────────────────────────────

describe("prCreationResultSchema", () => {
  test("validates a valid result with ticketsPushed, ticketsFailed, and summary", () => {
    const valid = {
      ticketsPushed: [
        {
          ticketId: "unit-1",
          branch: "unit/run-1/unit-1",
          prUrl: "https://github.com/org/repo/pull/42",
          prNumber: 42,
          summary: "Created PR for auth module",
        },
      ],
      ticketsFailed: [],
      summary: "1 PR created, 0 failures",
    };
    expect(() => prCreationResultSchema.parse(valid)).not.toThrow();
  });

  test("rejects missing summary", () => {
    const invalid = {
      ticketsPushed: [],
      ticketsFailed: [],
      // no summary
    };
    expect(() => prCreationResultSchema.parse(invalid)).toThrow();
  });

  test("allows empty arrays for ticketsPushed and ticketsFailed", () => {
    const minimal = {
      ticketsPushed: [],
      ticketsFailed: [],
      summary: "Nothing to do",
    };
    const result = prCreationResultSchema.parse(minimal);
    expect(result.ticketsPushed).toEqual([]);
    expect(result.ticketsFailed).toEqual([]);
  });

  test("ticketsPushed items accept nullable prUrl and prNumber", () => {
    const withNulls = {
      ticketsPushed: [
        {
          ticketId: "unit-1",
          branch: "unit/run-1/unit-1",
          prUrl: null,
          prNumber: null,
          summary: "Pushed but PR creation failed",
        },
      ],
      ticketsFailed: [],
      summary: "1 pushed with issues",
    };
    const result = prCreationResultSchema.parse(withNulls);
    expect(result.ticketsPushed[0].prUrl).toBeNull();
    expect(result.ticketsPushed[0].prNumber).toBeNull();
  });
});

// ── Component tests ──────────────────────────────────────────────────

describe("PushAndCreatePR component", () => {
  test("renders as a Task with a non-empty prompt when tickets are provided", () => {
    const element = PushAndCreatePR({
      ctx: createCtx(),
      tickets: [makeTicket()],
      agent: {} as any,
      repoRoot: "/repo",
      baseBranch: "main",
      output: {} as any,
      nodeId: "pr-creation",
    });

    const tasks = collectTasks(element);
    const task = tasks["pr-creation"];
    expect(task).toBeDefined();
    // The prompt is passed as children to the Task
    expect(typeof task.children).toBe("string");
    expect((task.children as string).length).toBeGreaterThan(0);
  });

  test("short-circuits with empty result Task when no tickets are provided", () => {
    const element = PushAndCreatePR({
      ctx: createCtx(),
      tickets: [],
      agent: {} as any,
      repoRoot: "/repo",
      output: {} as any,
      nodeId: "pr-creation",
    });

    const tasks = collectTasks(element);
    const task = tasks["pr-creation"];
    expect(task).toBeDefined();
    // Children should be the empty result object, not a string prompt
    expect(typeof task.children).not.toBe("string");
    const result = task.children as Record<string, unknown>;
    expect(result.ticketsPushed).toEqual([]);
    expect(result.ticketsFailed).toEqual([]);
    expect(typeof result.summary).toBe("string");
  });

  test("prompt contains jj git push --bookmark instructions", () => {
    const element = PushAndCreatePR({
      ctx: createCtx(),
      tickets: [makeTicket({ branch: "unit/run-1/unit-1" })],
      agent: {} as any,
      repoRoot: "/repo",
      baseBranch: "main",
      output: {} as any,
      nodeId: "pr-creation",
    });

    const tasks = collectTasks(element);
    const prompt = tasks["pr-creation"].children as string;
    expect(prompt).toContain("jj git push --bookmark");
  });

  test("prompt contains gh pr create instructions", () => {
    const element = PushAndCreatePR({
      ctx: createCtx(),
      tickets: [makeTicket()],
      agent: {} as any,
      repoRoot: "/repo",
      baseBranch: "main",
      output: {} as any,
      nodeId: "pr-creation",
    });

    const tasks = collectTasks(element);
    const prompt = tasks["pr-creation"].children as string;
    expect(prompt).toContain("gh pr create");
  });
});

// ── Schema integration test ──────────────────────────────────────────

describe("scheduledOutputSchemas.pr_creation", () => {
  test("pr_creation key exists and is a zod schema", () => {
    expect(scheduledOutputSchemas.pr_creation).toBeDefined();
    expect(scheduledOutputSchemas.pr_creation).toBeInstanceOf(z.ZodObject);
  });

  test("validates the expected shape", () => {
    const valid = {
      ticketsPushed: [
        {
          ticketId: "unit-1",
          branch: "unit/run-1/unit-1",
          prUrl: "https://github.com/org/repo/pull/1",
          prNumber: 1,
          summary: "Done",
        },
      ],
      ticketsFailed: [{ ticketId: "unit-2", reason: "push failed" }],
      summary: "Mixed results",
    };
    expect(() => scheduledOutputSchemas.pr_creation.parse(valid)).not.toThrow();
  });
});
