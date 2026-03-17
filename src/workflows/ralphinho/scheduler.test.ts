import { describe, expect, test } from "bun:test";
import type { ConsumedTicket } from "../../adapters/linear/types";
import type { LinearIssue } from "smithers-orchestrator/linear";
import { slugify } from "../../cli/shared";
import {
  groupByFileOverlap,
  groupToWorkPlan,
} from "./scheduler";

// ── Helpers ─────────────────────────────────────────────────────────────

function buildIssue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: "issue-1",
    identifier: "IMP-0001",
    title: "Fix something",
    description: null,
    priority: 2,
    priorityLabel: "High",
    state: { id: "s1", name: "Todo", type: "unstarted" },
    assignee: null,
    labels: [],
    project: null,
    createdAt: "2026-03-16T00:00:00.000Z",
    updatedAt: "2026-03-16T00:00:00.000Z",
    url: "https://linear.app/team/issue/IMP-0001",
    ...overrides,
  };
}

function buildTicket(
  overrides: {
    id?: string;
    identifier?: string;
    primaryFile?: string | null;
    title?: string;
  } = {},
): ConsumedTicket {
  const issue = buildIssue({
    id: overrides.id ?? "issue-1",
    identifier: overrides.identifier ?? "IMP-0001",
    title: overrides.title ?? "Fix something",
  });
  return {
    issue,
    rfcContent: `# ${issue.identifier}: ${issue.title}`,
    metadata: {
      kind: null,
      priority: null,
      confidence: null,
      primaryFile: overrides.primaryFile ?? null,
      lineRefs: [],
      symbol: null,
    },
  };
}

// ── groupByFileOverlap ──────────────────────────────────────────────────

describe("groupByFileOverlap", () => {
  test("returns empty array for empty input", () => {
    expect(groupByFileOverlap([])).toEqual([]);
  });

  test("two tickets sharing primaryFile are placed in the same group", () => {
    const tickets = [
      buildTicket({ id: "a", identifier: "IMP-0001", primaryFile: "src/foo.ts" }),
      buildTicket({ id: "b", identifier: "IMP-0002", primaryFile: "src/foo.ts" }),
    ];

    const groups = groupByFileOverlap(tickets);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.tickets).toHaveLength(2);
    expect(groups[0]!.files).toEqual(["src/foo.ts"]);
  });

  test("two tickets with different primaryFile values are in separate groups", () => {
    const tickets = [
      buildTicket({ id: "a", identifier: "IMP-0001", primaryFile: "src/foo.ts" }),
      buildTicket({ id: "b", identifier: "IMP-0002", primaryFile: "src/bar.ts" }),
    ];

    const groups = groupByFileOverlap(tickets);

    expect(groups).toHaveLength(2);
    expect(groups[0]!.tickets).toHaveLength(1);
    expect(groups[1]!.tickets).toHaveLength(1);
  });

  test("three tickets sharing the same file are grouped together", () => {
    // NOTE: true transitivity (A↔B via file1, B↔C via file2) requires
    // multi-file awareness. With single primaryFile, all tickets here
    // share the same file directly.
    const tickets = [
      buildTicket({ id: "a", identifier: "IMP-0001", primaryFile: "src/file1.ts" }),
      buildTicket({ id: "b", identifier: "IMP-0002", primaryFile: "src/file1.ts" }),
      buildTicket({ id: "c", identifier: "IMP-0003", primaryFile: "src/file1.ts" }),
    ];

    const groups = groupByFileOverlap(tickets);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.tickets).toHaveLength(3);
  });

  test("tickets with no primaryFile each form their own singleton group", () => {
    const tickets = [
      buildTicket({ id: "a", identifier: "IMP-0001", primaryFile: null }),
      buildTicket({ id: "b", identifier: "IMP-0002", primaryFile: null }),
    ];

    const groups = groupByFileOverlap(tickets);

    expect(groups).toHaveLength(2);
    expect(groups[0]!.tickets).toHaveLength(1);
    expect(groups[1]!.tickets).toHaveLength(1);
    // No files in these groups
    expect(groups[0]!.files).toEqual([]);
    expect(groups[1]!.files).toEqual([]);
  });

  test("mixed: some tickets share a file, others are singletons", () => {
    const tickets = [
      buildTicket({ id: "a", identifier: "IMP-0001", primaryFile: "src/foo.ts" }),
      buildTicket({ id: "b", identifier: "IMP-0002", primaryFile: "src/bar.ts" }),
      buildTicket({ id: "c", identifier: "IMP-0003", primaryFile: "src/foo.ts" }),
      buildTicket({ id: "d", identifier: "IMP-0004", primaryFile: null }),
    ];

    const groups = groupByFileOverlap(tickets);

    // IMP-0001 + IMP-0003 (foo.ts), IMP-0002 (bar.ts), IMP-0004 (no file)
    expect(groups).toHaveLength(3);

    const fooGroup = groups.find((g) => g.files.includes("src/foo.ts"));
    expect(fooGroup).toBeDefined();
    expect(fooGroup!.tickets).toHaveLength(2);
  });
});

// ── groupToWorkPlan ─────────────────────────────────────────────────────

describe("groupToWorkPlan", () => {
  const repoConfig = {
    projectName: "test-project",
    buildCmds: { typecheck: "bun run typecheck" },
    testCmds: { test: "bun test" },
  };

  test("first ticket on a file has empty deps, subsequent tickets depend on the previous", () => {
    const tickets = [
      buildTicket({ id: "a", identifier: "IMP-0001", primaryFile: "src/foo.ts" }),
      buildTicket({ id: "b", identifier: "IMP-0002", primaryFile: "src/foo.ts" }),
      buildTicket({ id: "c", identifier: "IMP-0003", primaryFile: "src/foo.ts" }),
    ];

    const group = {
      id: "group-0",
      files: ["src/foo.ts"],
      tickets,
    };

    const plan = groupToWorkPlan(group, repoConfig);

    expect(plan.units).toHaveLength(3);
    expect(plan.units[0]!.deps).toEqual([]);
    expect(plan.units[1]!.deps).toEqual(["imp-0001"]);
    expect(plan.units[2]!.deps).toEqual(["imp-0002"]);
  });

  test("tickets on different files within the same group have no deps between them", () => {
    const tickets = [
      buildTicket({ id: "a", identifier: "IMP-0001", primaryFile: "src/foo.ts" }),
      buildTicket({ id: "b", identifier: "IMP-0002", primaryFile: "src/bar.ts" }),
    ];

    const group = {
      id: "group-0",
      files: ["src/foo.ts", "src/bar.ts"],
      tickets,
    };

    const plan = groupToWorkPlan(group, repoConfig);

    expect(plan.units).toHaveLength(2);
    // Both should have empty deps since they're on different files
    expect(plan.units[0]!.deps).toEqual([]);
    expect(plan.units[1]!.deps).toEqual([]);
  });

  test("multiple no-primaryFile tickets in a group have independent (empty) deps", () => {
    const tickets = [
      buildTicket({ id: "a", identifier: "IMP-0001", primaryFile: null }),
      buildTicket({ id: "b", identifier: "IMP-0002", primaryFile: null }),
      buildTicket({ id: "c", identifier: "IMP-0003", primaryFile: null }),
    ];

    const group = { id: "group-0", files: [], tickets };
    const plan = groupToWorkPlan(group, repoConfig);

    expect(plan.units).toHaveLength(3);
    // Each no-file ticket should be independent — no deps
    for (const unit of plan.units) {
      expect(unit.deps).toEqual([]);
    }
  });

  test("work plan has correct source, repo config, and generatedAt", () => {
    const fixedDate = new Date("2026-03-17T12:00:00.000Z");
    const group = {
      id: "group-0",
      files: ["src/foo.ts"],
      tickets: [buildTicket({ identifier: "IMP-0001", primaryFile: "src/foo.ts" })],
    };

    const plan = groupToWorkPlan(group, repoConfig, { now: () => fixedDate });

    expect(plan.source).toBe("linear-batch");
    expect(plan.repo).toEqual(repoConfig);
    expect(plan.generatedAt).toBe("2026-03-17T12:00:00.000Z");
  });

  test("units have correct shape", () => {
    const group = {
      id: "group-0",
      files: ["src/foo.ts"],
      tickets: [
        buildTicket({ identifier: "IMP-0001", primaryFile: "src/foo.ts", title: "Do the thing" }),
      ],
    };

    const plan = groupToWorkPlan(group, repoConfig);

    const unit = plan.units[0]!;
    expect(unit.id).toBe("imp-0001");
    expect(unit.name).toBe("IMP-0001: Do the thing");
    expect(unit.tier).toBe("small");
    expect(unit.rfcSections).toEqual([]);
    expect(unit.acceptance).toBeArrayOfSize(3);
    expect(unit.acceptance[0]).toBe("IMP-0001: Do the thing is fully implemented");
  });
});

// ── slugify (reused from cli/shared) ────────────────────────────────────

describe("slugify (used as unit ID sanitizer)", () => {
  test("converts IMP-0001 to imp-0001", () => {
    expect(slugify("IMP-0001")).toBe("imp-0001");
  });

  test("strips non-alphanumeric characters", () => {
    expect(slugify("IMP@#$0001")).toBe("imp-0001");
  });

  test("collapses multiple hyphens", () => {
    expect(slugify("IMP---0001")).toBe("imp-0001");
  });

  test("strips leading and trailing hyphens", () => {
    expect(slugify("-IMP-0001-")).toBe("imp-0001");
  });
});
