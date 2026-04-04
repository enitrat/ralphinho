/**
 * Shared test utility for capturing stdout/stderr output.
 *
 * Replaces the repeated monkey-patching boilerplate across CLI test files.
 */

export type CapturedOutput = {
  stdout: string[];
  stderr: string[];
  /** Restore original stdout/stderr writers */
  restore: () => void;
  /** Join all captured stdout lines */
  allStdout: () => string;
  /** Join all captured stderr lines */
  allStderr: () => string;
  /** Join all captured output (both streams) */
  all: () => string;
};

/**
 * Capture stdout and stderr writes. Returns a handle with restore() and
 * accessors for the captured content.
 *
 * Usage:
 * ```ts
 * const cap = captureOutput();
 * try {
 *   await someFunction();
 *   expect(cap.allStdout()).toContain("expected");
 * } finally {
 *   cap.restore();
 * }
 * ```
 */
export function captureOutput(): CapturedOutput {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origStdout = process.stdout.write;
  const origStderr = process.stderr.write;

  process.stdout.write = ((chunk: any) => {
    stdout.push(String(chunk));
    return true;
  }) as any;

  process.stderr.write = ((chunk: any) => {
    stderr.push(String(chunk));
    return true;
  }) as any;

  return {
    stdout,
    stderr,
    restore() {
      process.stdout.write = origStdout;
      process.stderr.write = origStderr;
    },
    allStdout: () => stdout.join(""),
    allStderr: () => stderr.join(""),
    all: () => [...stdout, ...stderr].join(""),
  };
}

/**
 * Capture stdout only (silent stderr). For tests that don't need stderr.
 */
export function captureStdout(): CapturedOutput {
  const stdout: string[] = [];
  const origStdout = process.stdout.write;

  process.stdout.write = ((chunk: any) => {
    stdout.push(String(chunk));
    return true;
  }) as any;

  return {
    stdout,
    stderr: [],
    restore() {
      process.stdout.write = origStdout;
    },
    allStdout: () => stdout.join(""),
    allStderr: () => "",
    all: () => stdout.join(""),
  };
}
