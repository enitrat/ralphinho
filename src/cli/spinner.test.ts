/**
 * Tests for createSpinner — verifies start/stop lifecycle and cleanup.
 */

import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { createSpinner } from "./spinner";

describe("createSpinner", () => {
  let writeSpy: ReturnType<typeof mock>;
  const originalWrite = process.stdout.write;

  beforeEach(() => {
    writeSpy = mock(() => true);
    process.stdout.write = writeSpy as any;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  test("start() begins writing spinner frames to stdout", async () => {
    const spinner = createSpinner("Loading...");
    spinner.start();

    // Wait for at least one frame to render
    await new Promise((r) => setTimeout(r, 120));
    spinner.stop();

    // Should have written at least one spinner frame and the clear sequence
    expect(writeSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

    // First call should contain the message
    const firstCall = writeSpy.mock.calls[0][0] as string;
    expect(firstCall).toContain("Loading...");
  });

  test("stop() clears the spinner line", async () => {
    const spinner = createSpinner("Working...");
    spinner.start();
    await new Promise((r) => setTimeout(r, 100));
    spinner.stop();

    // Last call should be the ANSI clear-line sequence
    const lastCall = writeSpy.mock.calls[writeSpy.mock.calls.length - 1][0] as string;
    expect(lastCall).toContain("\x1b[K");
  });

  test("stop() is safe to call without start()", () => {
    const spinner = createSpinner("Idle");
    // Should not throw
    spinner.stop();
    // Only the clear-line write from stop()
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  test("stop() clears the interval (no more writes after stop)", async () => {
    const spinner = createSpinner("Temp");
    spinner.start();
    await new Promise((r) => setTimeout(r, 100));
    spinner.stop();

    const countAfterStop = writeSpy.mock.calls.length;
    await new Promise((r) => setTimeout(r, 200));
    // No additional writes should occur after stop
    expect(writeSpy.mock.calls.length).toBe(countAfterStop);
  });
});
