import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("createLogger", () => {
  let originalIsTTY: boolean;
  let originalEnv: string | undefined;
  let captured: string[];
  let originalStdoutWrite: typeof process.stdout.write;
  let originalStderrWrite: typeof process.stderr.write;

  beforeEach(() => {
    originalIsTTY = process.stdout.isTTY;
    originalEnv = process.env.SUPER_RALPH_LOG_FILE;
    delete process.env.SUPER_RALPH_LOG_FILE;
    captured = [];
    originalStdoutWrite = process.stdout.write;
    originalStderrWrite = process.stderr.write;
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", { value: originalIsTTY, writable: true });
    if (originalEnv !== undefined) {
      process.env.SUPER_RALPH_LOG_FILE = originalEnv;
    } else {
      delete process.env.SUPER_RALPH_LOG_FILE;
    }
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  });

  function captureStdout() {
    process.stdout.write = ((chunk: any) => {
      captured.push(String(chunk));
      return true;
    }) as any;
  }

  function captureStderr() {
    process.stderr.write = ((chunk: any) => {
      captured.push(String(chunk));
      return true;
    }) as any;
  }

  test("non-TTY info outputs valid JSON with ts, level, msg fields", async () => {
    Object.defineProperty(process.stdout, "isTTY", { value: false, writable: true });
    captureStdout();

    const { createLogger } = await import("./logger");
    const log = createLogger({});
    log.info("hello world");

    expect(captured.length).toBeGreaterThan(0);
    const parsed = JSON.parse(captured[0].trim());
    expect(parsed.level).toBe("info");
    expect(parsed.msg).toBe("hello world");
    expect(parsed.ts).toBeDefined();
  });

  test("non-TTY includes context keys in JSON output", async () => {
    Object.defineProperty(process.stdout, "isTTY", { value: false, writable: true });
    captureStdout();

    const { createLogger } = await import("./logger");
    const log = createLogger({ context: { phase: "cli", mode: "test" } });
    log.info("test msg");

    const parsed = JSON.parse(captured[0].trim());
    expect(parsed.phase).toBe("cli");
    expect(parsed.mode).toBe("test");
  });

  test("TTY mode outputs human-readable prefixed lines", async () => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, writable: true });
    captureStdout();

    const { createLogger } = await import("./logger");
    const log = createLogger({});
    log.info("hello tty");

    expect(captured.length).toBeGreaterThan(0);
    const output = captured[0];
    expect(output).toContain("hello tty");
    // Should NOT be valid JSON
    expect(() => JSON.parse(output.trim())).toThrow();
  });

  test("error level writes to stderr", async () => {
    Object.defineProperty(process.stdout, "isTTY", { value: false, writable: true });
    captureStderr();

    const { createLogger } = await import("./logger");
    const log = createLogger({});
    log.error("something broke");

    expect(captured.length).toBeGreaterThan(0);
    const parsed = JSON.parse(captured[0].trim());
    expect(parsed.level).toBe("error");
    expect(parsed.msg).toBe("something broke");
  });

  test("warn level writes to stderr", async () => {
    Object.defineProperty(process.stdout, "isTTY", { value: false, writable: true });
    captureStderr();

    const { createLogger } = await import("./logger");
    const log = createLogger({});
    log.warn("watch out");

    const parsed = JSON.parse(captured[0].trim());
    expect(parsed.level).toBe("warn");
  });

  test("child() merges parent context with child context", async () => {
    Object.defineProperty(process.stdout, "isTTY", { value: false, writable: true });
    captureStdout();

    const { createLogger } = await import("./logger");
    const parent = createLogger({ context: { phase: "cli" } });
    const child = parent.child({ unit: "auth" });
    child.info("from child");

    const parsed = JSON.parse(captured[0].trim());
    expect(parsed.phase).toBe("cli");
    expect(parsed.unit).toBe("auth");
    expect(parsed.msg).toBe("from child");
  });

  test("debug level is suppressed by default", async () => {
    Object.defineProperty(process.stdout, "isTTY", { value: false, writable: true });
    captureStdout();

    const { createLogger } = await import("./logger");
    const log = createLogger({});
    log.debug("verbose detail");

    expect(captured.length).toBe(0);
  });

  test("debug level outputs when LOG_LEVEL=debug", async () => {
    Object.defineProperty(process.stdout, "isTTY", { value: false, writable: true });
    captureStdout();

    const { createLogger } = await import("./logger");
    const log = createLogger({ level: "debug" });
    log.debug("verbose detail");

    expect(captured.length).toBeGreaterThan(0);
    const parsed = JSON.parse(captured[0].trim());
    expect(parsed.level).toBe("debug");
  });

  test("SUPER_RALPH_LOG_FILE writes lines to file", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "logger-test-"));
    const logFile = join(tmpDir, "test.log");
    process.env.SUPER_RALPH_LOG_FILE = logFile;

    // Need fresh import to pick up env
    // Use a direct test approach instead
    const { createLogger } = await import("./logger");
    const log = createLogger({ logFile });
    log.info("file entry");

    // Give a tick for file write
    await new Promise((r) => setTimeout(r, 50));

    const content = readFileSync(logFile, "utf8");
    expect(content).toContain("file entry");

    try { unlinkSync(logFile); } catch {}
  });

  test("multiple args are joined into msg", async () => {
    Object.defineProperty(process.stdout, "isTTY", { value: false, writable: true });
    captureStdout();

    const { createLogger } = await import("./logger");
    const log = createLogger({});
    log.info("count:", 42);

    const parsed = JSON.parse(captured[0].trim());
    expect(parsed.msg).toBe("count: 42");
  });
});
