/**
 * Tests for ralphinho replay command.
 *
 * Strategy: mock the smithers time-travel APIs and assert CLI behavior
 * (success output, error propagation, argument parsing).
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { captureOutput } from "./__tests__/capture-output";

// ── Mock infrastructure ──────────────────────────────────────────────

const mockReplayFromCheckpoint = mock(() =>
  Promise.resolve({
    runId: "forked-run-001",
    branch: {
      runId: "forked-run-001",
      parentRunId: "run-001",
      parentFrameNo: 2,
      branchLabel: null,
      forkDescription: "Replay from run-001:2",
      createdAtMs: Date.now(),
    },
    snapshot: {
      runId: "forked-run-001",
      frameNo: 0,
      nodesJson: "[]",
      outputsJson: "{}",
      ralphJson: "[]",
      inputJson: "{}",
      vcsPointer: null,
      workflowHash: null,
      contentHash: "abc123",
      createdAtMs: Date.now(),
    },
    vcsRestored: false,
    vcsPointer: null,
  }),
);

const mockOpenSmithersDb = mock(() =>
  Promise.resolve({
    adapter: {} as any,
    cleanup: mock(() => {}),
  }),
);

mock.module("smithers-orchestrator/src/time-travel/replay", () => ({
  replayFromCheckpoint: mockReplayFromCheckpoint,
}));

mock.module("smithers-orchestrator/src/cli/find-db", () => ({
  openSmithersDb: mockOpenSmithersDb,
}));

// Import after mocks
const { runReplay } = await import("./replay");

// ── Tests ────────────────────────────────────────────────────────────

describe("runReplay", () => {
  beforeEach(() => {
    mockReplayFromCheckpoint.mockReset();
    mockOpenSmithersDb.mockReset();

    mockOpenSmithersDb.mockResolvedValue({
      adapter: {} as any,
      cleanup: mock(() => {}),
    });

    mockReplayFromCheckpoint.mockResolvedValue({
      runId: "forked-run-001",
      branch: {
        runId: "forked-run-001",
        parentRunId: "run-001",
        parentFrameNo: 2,
        branchLabel: null,
        forkDescription: "Replay from run-001:2",
        createdAtMs: Date.now(),
      },
      snapshot: {
        runId: "forked-run-001",
        frameNo: 0,
        nodesJson: "[]",
        outputsJson: "{}",
        ralphJson: "[]",
        inputJson: "{}",
        vcsPointer: null,
        workflowHash: null,
        contentHash: "abc123",
        createdAtMs: Date.now(),
      },
      vcsRestored: false,
      vcsPointer: null,
    });
  });

  test("calls replayFromCheckpoint and prints forked run ID on success", async () => {
    const cap = captureOutput();
    try {
      await runReplay({
        runId: "run-001",
        dbPath: "/tmp/test.db",
      });
    } finally {
      cap.restore();
    }

    expect(mockReplayFromCheckpoint).toHaveBeenCalledTimes(1);
    expect(mockReplayFromCheckpoint).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ parentRunId: "run-001" }),
    );

    expect(cap.allStdout()).toContain("forked-run-001");
  });

  test("passes frame number when provided", async () => {
    const cap = captureOutput();
    try {
      await runReplay({
        runId: "run-001",
        dbPath: "/tmp/test.db",
        frame: 5,
      });
    } finally {
      cap.restore();
    }

    expect(mockReplayFromCheckpoint).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ parentRunId: "run-001", frameNo: 5 }),
    );
  });

  test("throws on invalid run-id (API throws)", async () => {
    mockReplayFromCheckpoint.mockRejectedValue(
      new Error("Run not found: bad-id"),
    );

    const cap = captureOutput();
    try {
      await expect(
        runReplay({
          runId: "bad-id",
          dbPath: "/tmp/test.db",
        }),
      ).rejects.toThrow("Run not found");
    } finally {
      cap.restore();
    }
  });

  test("throws when DB cannot be opened", async () => {
    mockOpenSmithersDb.mockRejectedValue(
      new Error("SQLITE_CANTOPEN: unable to open database"),
    );

    const cap = captureOutput();
    try {
      await expect(
        runReplay({
          runId: "run-001",
          dbPath: "/tmp/nonexistent.db",
        }),
      ).rejects.toThrow("SQLITE_CANTOPEN");
    } finally {
      cap.restore();
    }
  });

  test("calls cleanup on adapter after replay succeeds", async () => {
    const cleanupFn = mock(() => {});
    mockOpenSmithersDb.mockResolvedValue({
      adapter: {} as any,
      cleanup: cleanupFn,
    });

    const cap = captureOutput();
    try {
      await runReplay({
        runId: "run-001",
        dbPath: "/tmp/test.db",
      });
    } finally {
      cap.restore();
    }

    expect(cleanupFn).toHaveBeenCalledTimes(1);
  });
});
