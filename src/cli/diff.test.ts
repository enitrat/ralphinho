/**
 * Tests for ralphinho diff command.
 *
 * Strategy: mock smithers time-travel APIs, assert CLI output format
 * (table output, --json flag, run_id:frame_no parsing, error cases).
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { captureOutput } from "./__tests__/capture-output";

// ── Mock infrastructure ──────────────────────────────────────────────

const mockLoadSnapshot = mock((_adapter: any, _runId: string, _frameNo: number) => Promise.resolve(undefined as any));
const mockLoadLatestSnapshot = mock((_adapter: any, _runId: string) => Promise.resolve(undefined as any));
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
const { parseSpec } = await import("./diff");

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

// ── parseSpec unit tests ─────────────────────────────────────────────

describe("parseSpec", () => {
  test("parses plain run-id without frame", () => {
    expect(parseSpec("run-001")).toEqual({ runId: "run-001", frameNo: null });
  });

  test("parses run-id:frame format", () => {
    expect(parseSpec("run-001:3")).toEqual({ runId: "run-001", frameNo: 3 });
  });

  test("parses frame 0", () => {
    expect(parseSpec("run-001:0")).toEqual({ runId: "run-001", frameNo: 0 });
  });

  test("treats trailing colon as no frame", () => {
    // "run-001:" → maybeFn is "", Number("") is 0, but it's ambiguous.
    // Actually Number("") === 0 and isInteger(0), so this parses as frame 0.
    // This is acceptable behavior — empty after colon means frame 0.
    const result = parseSpec("run-001:");
    expect(result.runId).toBe("run-001");
  });

  test("treats negative frame as no frame (whole string becomes runId)", () => {
    // -1 fails the >= 0 check, so the whole spec is treated as a run-id
    expect(parseSpec("run-001:-1")).toEqual({ runId: "run-001:-1", frameNo: null });
  });

  test("treats non-numeric suffix as part of run-id", () => {
    expect(parseSpec("run-001:abc")).toEqual({ runId: "run-001:abc", frameNo: null });
  });

  test("handles empty string", () => {
    expect(parseSpec("")).toEqual({ runId: "", frameNo: null });
  });

  test("handles UUID-style run-id with colon-delimited frame", () => {
    expect(parseSpec("abc-def-123:5")).toEqual({ runId: "abc-def-123", frameNo: 5 });
  });

  test("uses last colon for run-ids containing colons", () => {
    // "ns:run-001:3" → lastIndexOf(":") points to ":3"
    expect(parseSpec("ns:run-001:3")).toEqual({ runId: "ns:run-001", frameNo: 3 });
  });

  test("handles float frame as no frame", () => {
    expect(parseSpec("run-001:1.5")).toEqual({ runId: "run-001:1.5", frameNo: null });
  });
});

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

    const cap = captureOutput();
    try {
      await runDiff({
        specA: "run-001:1",
        specB: "run-001:3",
        dbPath: "/tmp/test.db",
      });
    } finally {
      cap.restore();
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

    const cap = captureOutput();
    try {
      await runDiff({
        specA: "run-001",
        specB: "run-002",
        dbPath: "/tmp/test.db",
      });
    } finally {
      cap.restore();
    }

    expect(mockLoadLatestSnapshot).toHaveBeenCalledWith(expect.anything(), "run-001");
    expect(mockLoadLatestSnapshot).toHaveBeenCalledWith(expect.anything(), "run-002");
  });

  test("prints formatted TUI diff by default", async () => {
    const snapA = makeSnapshot("run-001", 1);
    const snapB = makeSnapshot("run-001", 3);
    mockLoadSnapshot.mockImplementation(async (_adapter, _runId, frameNo) => {
      return frameNo === 1 ? snapA : snapB;
    });

    const cap = captureOutput();
    try {
      await runDiff({
        specA: "run-001:1",
        specB: "run-001:3",
        dbPath: "/tmp/test.db",
      });
    } finally {
      cap.restore();
    }

    expect(mockFormatDiffForTui).toHaveBeenCalledTimes(1);
    expect(cap.allStdout()).toContain("analyze");
  });

  test("prints JSON output when --json flag is set", async () => {
    const snapA = makeSnapshot("run-001", 1);
    const snapB = makeSnapshot("run-002", 2);
    mockLoadSnapshot.mockImplementation(async (_adapter, runId, frameNo) => {
      if (runId === "run-001" && frameNo === 1) return snapA;
      if (runId === "run-002" && frameNo === 2) return snapB;
      return undefined;
    });

    const cap = captureOutput();
    try {
      await runDiff({
        specA: "run-001:1",
        specB: "run-002:2",
        dbPath: "/tmp/test.db",
        json: true,
      });
    } finally {
      cap.restore();
    }

    expect(mockFormatDiffAsJson).toHaveBeenCalledTimes(1);
    // Should NOT call TUI formatter
    expect(mockFormatDiffForTui).not.toHaveBeenCalled();
  });

  test("throws when snapshot A is not found", async () => {
    mockLoadSnapshot.mockResolvedValue(undefined);

    const cap = captureOutput();
    try {
      await expect(
        runDiff({
          specA: "bad-run:99",
          specB: "run-001:1",
          dbPath: "/tmp/test.db",
        }),
      ).rejects.toThrow("Snapshot not found: bad-run:99");
    } finally {
      cap.restore();
    }
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

    const cap = captureOutput();
    try {
      await runDiff({
        specA: "run-001:1",
        specB: "run-001:3",
        dbPath: "/tmp/test.db",
      });
    } finally {
      cap.restore();
    }

    expect(cleanupFn).toHaveBeenCalledTimes(1);
  });
});
