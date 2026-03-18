import { describe, expect, test, mock, beforeEach } from "bun:test";
import type { LinearIssue } from "../../linear/types";
import { parseIssueMetadata } from "./parse-issue-metadata";

/**
 * Tests for consume-tickets module.
 *
 * We mock the `smithers-orchestrator/linear` module so that `useLinear()`
 * returns a fake client, then import the REAL production functions
 * (issueToRfc, consumeTicket, consumeAllTickets) which exercise the
 * actual code paths.
 */

// ── Mock useLinear ──────────────────────────────────────────────────────

let mockListIssues: ReturnType<typeof mock>;

mock.module("../../linear/useLinear", () => ({
  useLinear: () => ({
    listIssues: mockListIssues,
  }),
}));

// Import AFTER mock.module so the mock is in place
const { issueToRfc, consumeTicket, consumeAllTickets } = await import(
  "./consume-tickets"
);

// ── Helpers ─────────────────────────────────────────────────────────────

function buildIssue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: "issue-1",
    identifier: "ENG-42",
    title: "Fix auth token refresh",
    description:
      "The auth module fails to refresh tokens when they expire during a request.",
    priority: 2,
    priorityLabel: "High",
    state: { id: "s1", name: "Todo", type: "unstarted" },
    assignee: null,
    labels: [{ id: "l1", name: "bug" }],
    project: null,
    createdAt: "2026-03-16T00:00:00.000Z",
    updatedAt: "2026-03-16T00:00:00.000Z",
    url: "https://linear.app/team/issue/ENG-42",
    ...overrides,
  };
}

/**
 * Configure mockListIssues to return different results based on stateType.
 */
function setupListIssues(
  unstartedIssues: LinearIssue[],
  startedIssues: LinearIssue[] = [],
) {
  mockListIssues = mock((params: any) => {
    if (params.stateType === "started") return Promise.resolve(startedIssues);
    return Promise.resolve(unstartedIssues);
  });
}

beforeEach(() => {
  mockListIssues = mock(() => Promise.resolve([]));
});

// ── issueToRfc tests ────────────────────────────────────────────────────

describe("issueToRfc", () => {
  test("includes issue title as heading", () => {
    const issue = buildIssue();
    const rfc = issueToRfc(issue);
    expect(rfc).toContain("# ENG-42: Fix auth token refresh");
  });

  test("includes description section", () => {
    const issue = buildIssue();
    const rfc = issueToRfc(issue);
    expect(rfc).toContain("## Description");
    expect(rfc).toContain(
      "The auth module fails to refresh tokens",
    );
  });

  test("includes context metadata", () => {
    const issue = buildIssue({
      priorityLabel: "High",
      state: { id: "s1", name: "Todo", type: "unstarted" },
    });
    const rfc = issueToRfc(issue);
    expect(rfc).toContain("**Linear issue:** ENG-42");
    expect(rfc).toContain("**Status:** Todo");
    expect(rfc).toContain("**Priority:** High");
    expect(rfc).toContain("**Labels:** bug");
  });

  test("omits description section when null", () => {
    const issue = buildIssue({ description: null });
    const rfc = issueToRfc(issue);
    expect(rfc).not.toContain("## Description");
  });

  test("includes acceptance criteria", () => {
    const issue = buildIssue();
    const rfc = issueToRfc(issue);
    expect(rfc).toContain("## Acceptance Criteria");
    expect(rfc).toContain("Implement the changes described above");
  });

  test("omits labels section when empty", () => {
    const issue = buildIssue({ labels: [] });
    const rfc = issueToRfc(issue);
    expect(rfc).not.toContain("**Labels:**");
  });

  test("omits priority when absent", () => {
    const issue = buildIssue({ priorityLabel: "" });
    const rfc = issueToRfc(issue);
    expect(rfc).not.toContain("**Priority:**");
  });
});

// ── consumeTicket tests ─────────────────────────────────────────────────

describe("consumeTicket", () => {
  test("returns null when no issues match", async () => {
    setupListIssues([], []);
    const result = await consumeTicket({ label: "ralph-approved" });
    expect(result).toBeNull();
  });

  test("picks highest priority issue (lowest number)", async () => {
    setupListIssues([
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
    setupListIssues([], [startedIssue]);
    const result = await consumeTicket({ label: "ralph-approved" });

    expect(result).not.toBeNull();
    expect(result!.issue.id).toBe("started-1");
  });

  test("passes teamId and label to listIssues", async () => {
    setupListIssues([], []);
    await consumeTicket({ teamId: "team-abc", label: "approved" });

    expect(mockListIssues).toHaveBeenCalledWith({
      teamId: "team-abc",
      labels: ["approved"],
      stateType: "unstarted",
      limit: 10,
    });
  });

  test("rfcContent is generated by the real issueToRfc", async () => {
    const issue = buildIssue();
    setupListIssues([issue]);
    const result = await consumeTicket({ label: "ralph-approved" });

    expect(result).not.toBeNull();
    // Verify the rfcContent matches what the real issueToRfc produces
    expect(result!.rfcContent).toBe(issueToRfc(issue));
  });
});

// ── consumeAllTickets tests ─────────────────────────────────────────────

describe("consumeAllTickets", () => {
  test("fetches unstarted + started in parallel and deduplicates by ID", async () => {
    const shared = buildIssue({ id: "shared", identifier: "ENG-5", priority: 2, title: "Shared" });
    const unstartedOnly = buildIssue({ id: "unstarted-only", identifier: "ENG-6", priority: 3, title: "Unstarted" });
    const startedOnly = buildIssue({ id: "started-only", identifier: "ENG-7", priority: 1, title: "Started" });

    // shared appears in both sets — should be deduplicated
    setupListIssues([shared, unstartedOnly], [shared, startedOnly]);
    const batch = await consumeAllTickets({ label: "approved" });

    const allIds = [...batch.tickets, ...batch.unparseable].map((t) => t.issue.id);
    // shared should appear only once
    expect(allIds.filter((id) => id === "shared")).toHaveLength(1);
    // All three unique issues present
    expect(allIds).toHaveLength(3);
  });

  test("sorts by priority ascending (urgent first)", async () => {
    const low = buildIssue({
      id: "low", priority: 4, title: "Low",
      description: "**Kind:** bug\n**File:** `low.ts`",
    });
    const urgent = buildIssue({
      id: "urgent", priority: 1, title: "Urgent",
      description: "**Kind:** bug\n**File:** `urgent.ts`",
    });
    const medium = buildIssue({
      id: "medium", priority: 3, title: "Medium",
      description: "**Kind:** bug\n**File:** `medium.ts`",
    });

    setupListIssues([low, urgent, medium], []);
    const batch = await consumeAllTickets({ label: "approved" });

    // All have primaryFile so they go into tickets, sorted by priority
    expect(batch.tickets[0]!.issue.id).toBe("urgent");
    expect(batch.tickets[1]!.issue.id).toBe("medium");
    expect(batch.tickets[2]!.issue.id).toBe("low");
  });

  test("splits into tickets (has primaryFile) and unparseable (no primaryFile)", async () => {
    const withFile = buildIssue({
      id: "with-file", priority: 1,
      description: "**Kind:** bug\n**File:** `src/foo.ts`",
    });
    const withoutFile = buildIssue({
      id: "without-file", priority: 2,
      description: "**Kind:** enhancement",
    });
    const nullDesc = buildIssue({
      id: "null-desc", priority: 3,
      description: null,
    });

    setupListIssues([withFile, withoutFile, nullDesc], []);
    const batch = await consumeAllTickets({ label: "approved" });

    expect(batch.tickets).toHaveLength(1);
    expect(batch.tickets[0]!.issue.id).toBe("with-file");

    expect(batch.unparseable).toHaveLength(2);
    const unparseableIds = batch.unparseable.map((t) => t.issue.id);
    expect(unparseableIds).toContain("without-file");
    expect(unparseableIds).toContain("null-desc");
  });

  test("includes parsed metadata on each consumed ticket", async () => {
    const issue = buildIssue({
      id: "meta",
      priority: 1,
      description: "**Kind:** bug\n**Priority:** high\n**File:** `src/x.ts`\n**Symbol:** `doStuff`",
    });

    setupListIssues([issue], []);
    const batch = await consumeAllTickets({ label: "approved" });

    expect(batch.tickets).toHaveLength(1);
    const ticket = batch.tickets[0]!;
    expect(ticket.metadata).toBeDefined();
    expect(ticket.metadata!.kind).toBe("bug");
    expect(ticket.metadata!.primaryFile).toBe("src/x.ts");
    expect(ticket.metadata!.symbol).toBe("doStuff");
  });

  test("returns empty arrays when no tickets exist", async () => {
    setupListIssues([], []);
    const batch = await consumeAllTickets({ label: "approved" });

    expect(batch.tickets).toHaveLength(0);
    expect(batch.unparseable).toHaveLength(0);
  });
});
