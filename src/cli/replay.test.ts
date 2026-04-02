/**
 * Tests for ralphinho replay command.
 *
 * Strategy: mock the smithers time-travel APIs and assert CLI behavior
 * (success output, error exit, argument parsing).
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

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
    const logs: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: any) => {
      logs.push(String(chunk));
      return true;
    }) as any;

    try {
      await runReplay({
        runId: "run-001",
        dbPath: "/tmp/test.db",
      });
    } finally {
      process.stdout.write = origWrite;
    }

    expect(mockReplayFromCheckpoint).toHaveBeenCalledTimes(1);
    expect(mockReplayFromCheckpoint).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ parentRunId: "run-001" }),
    );

    const allLogs = logs.join("");
    expect(allLogs).toContain("forked-run-001");
  });

  test("passes frame number when provided", async () => {
    const origWrite = process.stdout.write;
    process.stdout.write = (() => true) as any;

    try {
      await runReplay({
        runId: "run-001",
        dbPath: "/tmp/test.db",
        frame: 5,
      });
    } finally {
      process.stdout.write = origWrite;
    }

    expect(mockReplayFromCheckpoint).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ parentRunId: "run-001", frameNo: 5 }),
    );
  });

  test("exits with code 1 on invalid run-id (API throws)", async () => {
    mockReplayFromCheckpoint.mockRejectedValue(
      new Error("Run not found: bad-id"),
    );

    const logs: string[] = [];
    const origWrite = process.stdout.write;
    const origErrWrite = process.stderr.write;
    process.stdout.write = ((chunk: any) => {
      logs.push(String(chunk));
      return true;
    }) as any;
    process.stderr.write = ((chunk: any) => {
      logs.push(String(chunk));
      return true;
    }) as any;

    const origExit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code: number) => {
      exitCode = code;
      throw new Error("EXIT");
    }) as any;

    try {
      await runReplay({
        runId: "bad-id",
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
    const allLogs = logs.join("");
    expect(allLogs).toContain("Run not found");
  });

  test("exits with code 1 when DB cannot be opened", async () => {
    mockOpenSmithersDb.mockRejectedValue(
      new Error("SQLITE_CANTOPEN: unable to open database"),
    );

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
      await runReplay({
        runId: "run-001",
        dbPath: "/tmp/nonexistent.db",
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

  test("calls cleanup on adapter after replay succeeds", async () => {
    const cleanupFn = mock(() => {});
    mockOpenSmithersDb.mockResolvedValue({
      adapter: {} as any,
      cleanup: cleanupFn,
    });

    const origWrite = process.stdout.write;
    process.stdout.write = (() => true) as any;

    try {
      await runReplay({
        runId: "run-001",
        dbPath: "/tmp/test.db",
      });
    } finally {
      process.stdout.write = origWrite;
    }

    expect(cleanupFn).toHaveBeenCalledTimes(1);
  });
});
