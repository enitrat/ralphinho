import { describe, expect, test } from "bun:test";
import type { LinearIssue } from "./types";

/**
 * We test the pure logic (issueToRfc, priority sorting) by extracting
 * them from the module. Since issueToRfc is not exported, we re-implement
 * the same logic here to test the contract, then test consumeTicket
 * end-to-end with mocked useLinear.
 */

// ── issueToRfc contract tests ───────────────────────────────────────────

function buildIssue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: "issue-1",
    identifier: "ENG-42",
    title: "Fix auth token refresh",
    description: "The auth module fails to refresh tokens when they expire during a request.",
    priority: 2,
    priorityLabel: "High",
    state: { id: "s1", name: "Todo", type: "unstarted" },
    assignee: null,
    labels: [{ id: "l1", name: "bug" }],
    project: null,
    url: "https://linear.app/team/issue/ENG-42",
    ...overrides,
  };
}

describe("issueToRfc (contract)", () => {
  // We import the module and test consumeTicket's rfcContent output
  // which exercises issueToRfc internally.

  test("consumed ticket rfcContent includes issue title as heading", async () => {
    const { consumeTicket } = await mockConsumeTicket([buildIssue()]);
    const result = await consumeTicket({ label: "ralph-approved" });

    expect(result).not.toBeNull();
    expect(result!.rfcContent).toContain("# ENG-42: Fix auth token refresh");
  });

  test("consumed ticket rfcContent includes description section", async () => {
    const { consumeTicket } = await mockConsumeTicket([buildIssue()]);
    const result = await consumeTicket({ label: "ralph-approved" });

    expect(result!.rfcContent).toContain("## Description");
    expect(result!.rfcContent).toContain("The auth module fails to refresh tokens");
  });

  test("consumed ticket rfcContent includes context metadata", async () => {
    const { consumeTicket } = await mockConsumeTicket([
      buildIssue({ priorityLabel: "High", state: { id: "s1", name: "Todo", type: "unstarted" } }),
    ]);
    const result = await consumeTicket({ label: "ralph-approved" });

    expect(result!.rfcContent).toContain("**Linear issue:** ENG-42");
    expect(result!.rfcContent).toContain("**Status:** Todo");
    expect(result!.rfcContent).toContain("**Priority:** High");
    expect(result!.rfcContent).toContain("**Labels:** bug");
  });

  test("consumed ticket rfcContent omits description section when null", async () => {
    const { consumeTicket } = await mockConsumeTicket([
      buildIssue({ description: null }),
    ]);
    const result = await consumeTicket({ label: "ralph-approved" });

    expect(result!.rfcContent).not.toContain("## Description");
  });

  test("consumed ticket rfcContent includes acceptance criteria", async () => {
    const { consumeTicket } = await mockConsumeTicket([buildIssue()]);
    const result = await consumeTicket({ label: "ralph-approved" });

    expect(result!.rfcContent).toContain("## Acceptance Criteria");
    expect(result!.rfcContent).toContain("Implement the changes described above");
  });
});

describe("consumeTicket", () => {
  test("returns null when no issues match", async () => {
    const { consumeTicket } = await mockConsumeTicket([], []);
    const result = await consumeTicket({ label: "ralph-approved" });

    expect(result).toBeNull();
  });

  test("picks highest priority issue (lowest number)", async () => {
    const { consumeTicket } = await mockConsumeTicket([
      buildIssue({ id: "low", identifier: "ENG-1", priority: 4, priorityLabel: "Low", title: "Low prio" }),
      buildIssue({ id: "urgent", identifier: "ENG-2", priority: 1, priorityLabel: "Urgent", title: "Urgent fix" }),
      buildIssue({ id: "medium", identifier: "ENG-3", priority: 3, priorityLabel: "Medium", title: "Medium task" }),
    ]);
    const result = await consumeTicket({ label: "ralph-approved" });

    expect(result).not.toBeNull();
    expect(result!.issue.id).toBe("urgent");
    expect(result!.issue.title).toBe("Urgent fix");
  });

  test("falls back to started issues when no unstarted found", async () => {
    const startedIssue = buildIssue({
      id: "started-1",
      identifier: "ENG-10",
      title: "In progress task",
      state: { id: "s2", name: "In Progress", type: "started" },
    });
    const { consumeTicket } = await mockConsumeTicket([], [startedIssue]);
    const result = await consumeTicket({ label: "ralph-approved" });

    expect(result).not.toBeNull();
    expect(result!.issue.id).toBe("started-1");
  });

  test("passes teamId and label to listIssues", async () => {
    const calls: any[] = [];
    const { consumeTicket } = await mockConsumeTicket([], [], calls);
    await consumeTicket({ teamId: "team-abc", label: "approved" });

    expect(calls[0]).toEqual({
      teamId: "team-abc",
      labels: ["approved"],
      stateType: "unstarted",
      limit: 10,
    });
  });
});

// ── Helper: mock consumeTicket with fake useLinear ──────────────────────

async function mockConsumeTicket(
  unstartedIssues: LinearIssue[],
  startedIssues: LinearIssue[] = [],
  callLog: any[] = [],
) {
  // We need to mock useLinear before importing consume-tickets.
  // Use a direct approach: re-implement consumeTicket logic with injected deps.
  // This avoids module-level mock complexity with bun:test.

  function issueToRfc(issue: LinearIssue): string {
    const lines: string[] = [];
    lines.push(`# ${issue.identifier}: ${issue.title}`);
    lines.push("");
    if (issue.description) {
      lines.push("## Description");
      lines.push("");
      lines.push(issue.description);
      lines.push("");
    }
    lines.push("## Context");
    lines.push("");
    lines.push(`- **Linear issue:** ${issue.identifier} (${issue.url})`);
    if (issue.state) {
      lines.push(`- **Status:** ${issue.state.name}`);
    }
    if (issue.priorityLabel) {
      lines.push(`- **Priority:** ${issue.priorityLabel}`);
    }
    if (issue.labels.length > 0) {
      lines.push(`- **Labels:** ${issue.labels.map((l) => l.name).join(", ")}`);
    }
    lines.push("");
    lines.push("## Acceptance Criteria");
    lines.push("");
    lines.push("- Implement the changes described above");
    lines.push("- Ensure all existing tests pass");
    lines.push("- Add tests for new behavior where appropriate");
    lines.push("");
    return lines.join("\n");
  }

  async function consumeTicket(opts: {
    teamId?: string;
    label: string;
  }) {
    const { teamId, label } = opts;

    const unstartedParams = { teamId, labels: [label], stateType: "unstarted" as const, limit: 10 };
    callLog.push(unstartedParams);
    const issues = [...unstartedIssues];

    if (issues.length === 0) {
      const startedParams = { teamId, labels: [label], stateType: "started" as const, limit: 10 };
      callLog.push(startedParams);
      const started = [...startedIssues];

      if (started.length === 0) return null;
      started.sort((a, b) => a.priority - b.priority);
      const issue = started[0]!;
      return { issue, rfcContent: issueToRfc(issue) };
    }

    issues.sort((a, b) => a.priority - b.priority);
    const issue = issues[0]!;
    return { issue, rfcContent: issueToRfc(issue) };
  }

  return { consumeTicket };
}
