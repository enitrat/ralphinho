/**
 * Tests for ralphinho diff command.
 *
 * Strategy: mock smithers time-travel APIs, assert CLI output format
 * (table output, --json flag, run_id:frame_no parsing, error cases).
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Mock infrastructure ──────────────────────────────────────────────

const mockLoadSnapshot = mock(() => Promise.resolve(undefined));
const mockLoadLatestSnapshot = mock(() => Promise.resolve(undefined));
const mockDiffRawSnapshots = mock(() => ({
  nodesAdded: [],
  nodesRemoved: [],
  nodesChanged: [],
  outputsAdded: [],
  outputsRemoved: [],
  outputsChanged: [],
  ralphChanged: [],
  inputChanged: false,
  vcsPointerChanged: false,
}));
const mockFormatDiffForTui = mock(() => "No differences");
const mockFormatDiffAsJson = mock(() => ({}));
const mockOpenSmithersDb = mock(() =>
  Promise.resolve({
    adapter: {} as any,
    cleanup: mock(() => {}),
  }),
);

mock.module("smithers-orchestrator/src/time-travel/snapshot", () => ({
  loadSnapshot: mockLoadSnapshot,
  loadLatestSnapshot: mockLoadLatestSnapshot,
}));

mock.module("smithers-orchestrator/src/time-travel/diff", () => ({
  diffRawSnapshots: mockDiffRawSnapshots,
  formatDiffForTui: mockFormatDiffForTui,
  formatDiffAsJson: mockFormatDiffAsJson,
}));

mock.module("smithers-orchestrator/src/cli/find-db", () => ({
  openSmithersDb: mockOpenSmithersDb,
}));

// Import after mocks
const { runDiff } = await import("./diff");

// ── Fixtures ─────────────────────────────────────────────────────────

function makeSnapshot(runId: string, frameNo: number) {
  return {
    runId,
    frameNo,
    nodesJson: "[]",
    outputsJson: "{}",
    ralphJson: "[]",
    inputJson: "{}",
    vcsPointer: null,
    workflowHash: null,
    contentHash: `hash-${runId}-${frameNo}`,
    createdAtMs: Date.now(),
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("runDiff", () => {
  beforeEach(() => {
    mockLoadSnapshot.mockReset();
    mockLoadLatestSnapshot.mockReset();
    mockDiffRawSnapshots.mockReset();
    mockFormatDiffForTui.mockReset();
    mockFormatDiffAsJson.mockReset();
    mockOpenSmithersDb.mockReset();

    mockOpenSmithersDb.mockResolvedValue({
      adapter: {} as any,
      cleanup: mock(() => {}),
    });

    mockDiffRawSnapshots.mockReturnValue({
      nodesAdded: ["implement"],
      nodesRemoved: [],
      nodesChanged: [{ nodeId: "analyze", from: { state: "running" }, to: { state: "finished" } }],
      outputsAdded: ["analyze-output"],
      outputsRemoved: [],
      outputsChanged: [],
      ralphChanged: [],
      inputChanged: false,
      vcsPointerChanged: false,
    });

    mockFormatDiffForTui.mockReturnValue("Nodes changed:\n  ~ analyze: running -> finished");
    mockFormatDiffAsJson.mockReturnValue({ nodesChanged: [{ nodeId: "analyze" }] });
  });

  test("parses run_id:frame_no format and loads specific snapshots", async () => {
    const snapA = makeSnapshot("run-001", 1);
    const snapB = makeSnapshot("run-001", 3);
    mockLoadSnapshot.mockImplementation(async (_adapter, runId, frameNo) => {
      if (runId === "run-001" && frameNo === 1) return snapA;
      if (runId === "run-001" && frameNo === 3) return snapB;
      return undefined;
    });

    const origWrite = process.stdout.write;
    process.stdout.write = (() => true) as any;

    try {
      await runDiff({
        specA: "run-001:1",
        specB: "run-001:3",
        dbPath: "/tmp/test.db",
      });
    } finally {
      process.stdout.write = origWrite;
    }

    // Should call loadSnapshot with specific frame numbers
    expect(mockLoadSnapshot).toHaveBeenCalledWith(expect.anything(), "run-001", 1);
    expect(mockLoadSnapshot).toHaveBeenCalledWith(expect.anything(), "run-001", 3);
    expect(mockDiffRawSnapshots).toHaveBeenCalledTimes(1);
  });

  test("uses loadLatestSnapshot when no frame_no specified", async () => {
    const snapA = makeSnapshot("run-001", 5);
    const snapB = makeSnapshot("run-002", 3);
    mockLoadLatestSnapshot.mockImplementation(async (_adapter, runId) => {
      if (runId === "run-001") return snapA;
      if (runId === "run-002") return snapB;
      return undefined;
    });

    const origWrite = process.stdout.write;
    process.stdout.write = (() => true) as any;

    try {
      await runDiff({
        specA: "run-001",
        specB: "run-002",
        dbPath: "/tmp/test.db",
      });
    } finally {
      process.stdout.write = origWrite;
    }

    expect(mockLoadLatestSnapshot).toHaveBeenCalledWith(expect.anything(), "run-001");
    expect(mockLoadLatestSnapshot).toHaveBeenCalledWith(expect.anything(), "run-002");
  });

  test("prints formatted TUI diff by default", async () => {
    const snapA = makeSnapshot("run-001", 1);
    const snapB = makeSnapshot("run-001", 3);
    mockLoadSnapshot.mockResolvedValue(snapA);
    // Override for both calls
    mockLoadSnapshot.mockImplementation(async (_adapter, _runId, frameNo) => {
      return frameNo === 1 ? snapA : snapB;
    });

    const logs: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: any) => {
      logs.push(String(chunk));
      return true;
    }) as any;

    try {
      await runDiff({
        specA: "run-001:1",
        specB: "run-001:3",
        dbPath: "/tmp/test.db",
      });
    } finally {
      process.stdout.write = origWrite;
    }

    expect(mockFormatDiffForTui).toHaveBeenCalledTimes(1);
    const allLogs = logs.join("");
    expect(allLogs).toContain("analyze");
  });

  test("prints JSON output when --json flag is set", async () => {
    const snapA = makeSnapshot("run-001", 1);
    const snapB = makeSnapshot("run-002", 2);
    mockLoadSnapshot.mockImplementation(async (_adapter, runId, frameNo) => {
      if (runId === "run-001" && frameNo === 1) return snapA;
      if (runId === "run-002" && frameNo === 2) return snapB;
      return undefined;
    });

    const logs: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: any) => {
      logs.push(String(chunk));
      return true;
    }) as any;

    try {
      await runDiff({
        specA: "run-001:1",
        specB: "run-002:2",
        dbPath: "/tmp/test.db",
        json: true,
      });
    } finally {
      process.stdout.write = origWrite;
    }

    expect(mockFormatDiffAsJson).toHaveBeenCalledTimes(1);
    // Should NOT call TUI formatter
    expect(mockFormatDiffForTui).not.toHaveBeenCalled();
  });

  test("exits with code 1 when snapshot A is not found", async () => {
    mockLoadSnapshot.mockResolvedValue(undefined);

    const origWrite = process.stdout.write;
    const origErrWrite = process.stderr.write;
    process.stdout.write = (() => true) as any;
    process.stderr.write = (() => true) as any;

    const origExit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code: number) => {
      exitCode = code;
      throw new Error("EXIT");
    }) as any;

    try {
      await runDiff({
        specA: "bad-run:99",
        specB: "run-001:1",
        dbPath: "/tmp/test.db",
      });
    } catch (e: any) {
      if (e.message !== "EXIT") throw e;
    } finally {
      process.stdout.write = origWrite;
      process.stderr.write = origErrWrite;
      process.exit = origExit;
    }

    expect(exitCode).toBe(1);
  });

  test("calls cleanup on adapter after diff", async () => {
    const cleanupFn = mock(() => {});
    mockOpenSmithersDb.mockResolvedValue({
      adapter: {} as any,
      cleanup: cleanupFn,
    });

    const snapA = makeSnapshot("run-001", 1);
    const snapB = makeSnapshot("run-001", 3);
    mockLoadSnapshot.mockImplementation(async (_adapter, _runId, frameNo) => {
      return frameNo === 1 ? snapA : snapB;
    });

    const origWrite = process.stdout.write;
    process.stdout.write = (() => true) as any;

    try {
      await runDiff({
        specA: "run-001:1",
        specB: "run-001:3",
        dbPath: "/tmp/test.db",
      });
    } finally {
      process.stdout.write = origWrite;
    }

    expect(cleanupFn).toHaveBeenCalledTimes(1);
  });
});
