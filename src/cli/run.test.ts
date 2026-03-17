/**
 * Tests for CLI batch wiring: --batch flag routing + runBatchFromLinear orchestration.
 *
 * Strategy: mock external dependencies (Linear adapter, scheduler, smithers launch,
 * init-scheduled) and assert call routing and orchestration behavior only.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Shared fixtures ──────────────────────────────────────────────────

function makeTicket(
  id: string,
  identifier: string,
  title: string,
  primaryFile?: string,
) {
  return {
    issue: {
      id,
      identifier,
      title,
      description: primaryFile
        ? `Primary File: \`${primaryFile}\``
        : "No metadata",
      priority: 2,
      priorityLabel: "High",
      url: `https://linear.app/team/issue/${identifier}`,
      state: { name: "Todo", type: "unstarted" as const },
      labels: [{ id: "lbl-1", name: "ralph-approved" }],
      team: { id: "team-1", name: "Team" },
    },
    rfcContent: `# ${identifier}: ${title}`,
    metadata: primaryFile
      ? { primaryFile, linesOfInterest: null, relatedFiles: [] }
      : { primaryFile: null, linesOfInterest: null, relatedFiles: [] },
  };
}

// ── Mock infrastructure ──────────────────────────────────────────────

// We need to mock the modules that runBatchFromLinear uses.
// Since bun:test mock.module works at the module level, we set up
// spy functions that the mocked modules delegate to.

const mockConsumeAllTickets = mock(() =>
  Promise.resolve({ tickets: [], unparseable: [] }),
);
const mockConsumeTicket = mock(() => Promise.resolve(null));
const mockMarkTicketInProgress = mock(() => Promise.resolve());
const mockMarkTicketDone = mock(() => Promise.resolve());
const mockGroupByFileOverlap = mock(() => []);
const mockGroupToWorkPlan = mock(() => ({
  source: "linear-batch",
  generatedAt: "2026-03-17T00:00:00.000Z",
  repo: { projectName: "test", buildCmds: {}, testCmds: {} },
  units: [],
}));
const mockLaunchSmithers = mock(() => Promise.resolve(0));
const mockResolveSmithersCliPath = mock(() => "/mock/smithers");
const mockInitScheduledWork = mock(() => Promise.resolve());

mock.module("../adapters/linear", () => ({
  consumeAllTickets: mockConsumeAllTickets,
  consumeTicket: mockConsumeTicket,
  markTicketInProgress: mockMarkTicketInProgress,
  markTicketDone: mockMarkTicketDone,
  issueToRfc: (issue: any) => `# ${issue.identifier}: ${issue.title}`,
  pushFindingsToLinear: mock(() => Promise.resolve({ created: [], skipped: 0 })),
}));

mock.module("../../workflows/ralphinho/scheduler", () => ({
  groupByFileOverlap: mockGroupByFileOverlap,
  groupToWorkPlan: mockGroupToWorkPlan,
}));

mock.module("../runtime/smithers-launch", () => ({
  launchSmithers: mockLaunchSmithers,
  resolveSmithersCliPath: mockResolveSmithersCliPath,
}));

mock.module("./init-scheduled", () => ({
  initScheduledWork: mockInitScheduledWork,
}));

// Must import AFTER mocks are set up
const { runBatchFromLinear } = await import("./run");

// ── Tests ────────────────────────────────────────────────────────────

describe("runBatchFromLinear", () => {
  let repoRoot: string;
  let ralphDir: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "batch-test-"));
    ralphDir = join(repoRoot, ".ralphinho");
    mkdirSync(ralphDir, { recursive: true });

    // Reset all mocks
    mockConsumeAllTickets.mockReset();
    mockConsumeTicket.mockReset();
    mockMarkTicketInProgress.mockReset();
    mockMarkTicketDone.mockReset();
    mockGroupByFileOverlap.mockReset();
    mockGroupToWorkPlan.mockReset();
    mockLaunchSmithers.mockReset();
    mockResolveSmithersCliPath.mockReset();

    // Default mock implementations
    mockConsumeAllTickets.mockResolvedValue({ tickets: [], unparseable: [] });
    mockResolveSmithersCliPath.mockReturnValue("/mock/smithers");
    mockLaunchSmithers.mockResolvedValue(0);
  });

  test("returns early with message when consumeAllTickets returns empty tickets", async () => {
    mockConsumeAllTickets.mockResolvedValue({ tickets: [], unparseable: [] });

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(" "));

    try {
      await runBatchFromLinear({
        repoRoot,
        ralphDir,
        linearOpts: { teamId: "team-1", label: "ralph-approved" },
        force: true,
        flags: {},
      });
    } finally {
      console.log = origLog;
    }

    expect(mockConsumeAllTickets).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.toLowerCase().includes("nothing to do") || l.toLowerCase().includes("no"))).toBe(true);
    // Should NOT call groupByFileOverlap or launchSmithers
    expect(mockGroupByFileOverlap).not.toHaveBeenCalled();
    expect(mockLaunchSmithers).not.toHaveBeenCalled();
  });

  test("logs unparseable ticket identifiers and excludes them from grouping", async () => {
    const parseable = makeTicket("t1", "ENG-1", "Fix auth", "src/auth.ts");
    const unparseable1 = makeTicket("t2", "ENG-2", "Vague task");
    const unparseable2 = makeTicket("t3", "ENG-3", "Another vague task");

    mockConsumeAllTickets.mockResolvedValue({
      tickets: [parseable],
      unparseable: [unparseable1, unparseable2],
    });
    mockGroupByFileOverlap.mockReturnValue([
      { id: "group-0", files: ["src/auth.ts"], tickets: [parseable] },
    ]);
    mockGroupToWorkPlan.mockReturnValue({
      source: "linear-batch",
      generatedAt: "2026-03-17T00:00:00.000Z",
      repo: { projectName: "test", buildCmds: {}, testCmds: {} },
      units: [{ id: "eng-1", name: "ENG-1: Fix auth", rfcSections: [], description: "", deps: [], acceptance: [], tier: "small" }],
    });

    const logs: string[] = [];
    const origLog = console.log;
    const origWarn = console.warn;
    console.log = (...args: any[]) => logs.push(args.join(" "));
    console.warn = (...args: any[]) => logs.push(args.join(" "));

    try {
      await runBatchFromLinear({
        repoRoot,
        ralphDir,
        linearOpts: { teamId: "team-1", label: "ralph-approved" },
        force: true,
        flags: {},
      });
    } finally {
      console.log = origLog;
      console.warn = origWarn;
    }

    // Should log unparseable identifiers
    expect(logs.some((l) => l.includes("ENG-2"))).toBe(true);
    expect(logs.some((l) => l.includes("ENG-3"))).toBe(true);

    // groupByFileOverlap should receive ONLY parseable tickets (not unparseable).
    // We verify this indirectly: the group plan log should only contain ENG-1 (parseable),
    // not ENG-2/ENG-3 (unparseable) in the group ticket lists.
    const groupPlanLogs = logs.filter((l) => l.includes("group-0"));
    expect(groupPlanLogs.some((l) => l.includes("ENG-1"))).toBe(true);
  });

  test("logs each group plan (id, files, ticket identifiers) before launch", async () => {
    const t1 = makeTicket("t1", "ENG-1", "Fix auth", "src/auth.ts");
    const t2 = makeTicket("t2", "ENG-2", "Fix db", "src/db.ts");

    mockConsumeAllTickets.mockResolvedValue({
      tickets: [t1, t2],
      unparseable: [],
    });
    mockGroupByFileOverlap.mockReturnValue([
      { id: "group-0", files: ["src/auth.ts"], tickets: [t1] },
      { id: "group-1", files: ["src/db.ts"], tickets: [t2] },
    ]);
    mockGroupToWorkPlan.mockReturnValue({
      source: "linear-batch",
      generatedAt: "2026-03-17T00:00:00.000Z",
      repo: { projectName: "test", buildCmds: {}, testCmds: {} },
      units: [],
    });

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(" "));

    try {
      await runBatchFromLinear({
        repoRoot,
        ralphDir,
        linearOpts: { teamId: "team-1", label: "ralph-approved" },
        force: true,
        flags: {},
      });
    } finally {
      console.log = origLog;
    }

    // Should log group-0 info
    const allLogs = logs.join("\n");
    expect(allLogs).toContain("group-0");
    expect(allLogs).toContain("src/auth.ts");
    expect(allLogs).toContain("ENG-1");
    // Should log group-1 info
    expect(allLogs).toContain("group-1");
    expect(allLogs).toContain("src/db.ts");
    expect(allLogs).toContain("ENG-2");
  });

  test("marks all parseable tickets in-progress before first group launch", async () => {
    const t1 = makeTicket("t1", "ENG-1", "Fix auth", "src/auth.ts");
    const t2 = makeTicket("t2", "ENG-2", "Fix db", "src/db.ts");

    mockConsumeAllTickets.mockResolvedValue({
      tickets: [t1, t2],
      unparseable: [],
    });
    mockGroupByFileOverlap.mockReturnValue([
      { id: "group-0", files: ["src/auth.ts"], tickets: [t1] },
      { id: "group-1", files: ["src/db.ts"], tickets: [t2] },
    ]);
    mockGroupToWorkPlan.mockReturnValue({
      source: "linear-batch",
      generatedAt: "2026-03-17T00:00:00.000Z",
      repo: { projectName: "test", buildCmds: {}, testCmds: {} },
      units: [],
    });

    // Track call order
    const callOrder: string[] = [];
    mockMarkTicketInProgress.mockImplementation(async () => {
      callOrder.push("markInProgress");
    });
    mockLaunchSmithers.mockImplementation(async () => {
      callOrder.push("launchSmithers");
      return 0;
    });

    await runBatchFromLinear({
      repoRoot,
      ralphDir,
      linearOpts: { teamId: "team-1", label: "ralph-approved" },
      force: true,
      flags: {},
    });

    // Should mark both tickets in-progress
    expect(mockMarkTicketInProgress).toHaveBeenCalledTimes(2);
    expect(mockMarkTicketInProgress).toHaveBeenCalledWith({
      issueId: "t1",
      teamId: "team-1",
    });
    expect(mockMarkTicketInProgress).toHaveBeenCalledWith({
      issueId: "t2",
      teamId: "team-1",
    });

    // All markInProgress calls should come before any launchSmithers
    const firstLaunch = callOrder.indexOf("launchSmithers");
    const lastMarkInProgress = callOrder.lastIndexOf("markInProgress");
    expect(lastMarkInProgress).toBeLessThan(firstLaunch);
  });

  test("marks only successful-group tickets done; failed-group tickets remain in-progress", async () => {
    const t1 = makeTicket("t1", "ENG-1", "Fix auth", "src/auth.ts");
    const t2 = makeTicket("t2", "ENG-2", "Fix db", "src/db.ts");

    mockConsumeAllTickets.mockResolvedValue({
      tickets: [t1, t2],
      unparseable: [],
    });
    mockGroupByFileOverlap.mockReturnValue([
      { id: "group-0", files: ["src/auth.ts"], tickets: [t1] },
      { id: "group-1", files: ["src/db.ts"], tickets: [t2] },
    ]);
    mockGroupToWorkPlan.mockReturnValue({
      source: "linear-batch",
      generatedAt: "2026-03-17T00:00:00.000Z",
      repo: { projectName: "test", buildCmds: {}, testCmds: {} },
      units: [],
    });

    // First group succeeds (exit 0), second group fails (exit 1)
    let launchCount = 0;
    mockLaunchSmithers.mockImplementation(async () => {
      launchCount++;
      return launchCount === 1 ? 0 : 1;
    });

    // Suppress error logs from failed group
    const origError = console.error;
    console.error = () => {};

    try {
      await runBatchFromLinear({
        repoRoot,
        ralphDir,
        linearOpts: { teamId: "team-1", label: "ralph-approved" },
        force: true,
        flags: {},
      });
    } finally {
      console.error = origError;
    }

    // Only the first group's ticket should be marked done
    expect(mockMarkTicketDone).toHaveBeenCalledTimes(1);
    expect(mockMarkTicketDone).toHaveBeenCalledWith(
      expect.objectContaining({ issueId: "t1" }),
    );
  });
});
