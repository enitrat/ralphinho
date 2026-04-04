/**
 * Tests for Prometheus metrics HTTP server.
 */

import { describe, test, expect, afterEach } from "bun:test";

// Import after ensuring module exists
const { startPrometheusServer } = await import("./prometheus");

describe("startPrometheusServer", () => {
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  test("starts server and GET /metrics returns text/plain with smithers_ metric", async () => {
    const result = startPrometheusServer({ port: 0 }); // port 0 = random available
    cleanup = result.stop;

    const res = await fetch(`http://localhost:${result.port}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");

    const body = await res.text();
    // Should have at least one smithers_ metric line (from effect-utils metrics)
    expect(body).toContain("smithers_");
  });

  test("returns 404 for non-/metrics paths", async () => {
    const result = startPrometheusServer({ port: 0 });
    cleanup = result.stop;

    const res = await fetch(`http://localhost:${result.port}/health`);
    expect(res.status).toBe(404);
  });

  test("stop() shuts down the server", async () => {
    const result = startPrometheusServer({ port: 0 });
    const port = result.port;
    result.stop();
    cleanup = null;

    // After stop, fetch should throw (connection refused)
    let threw = false;
    try {
      await fetch(`http://localhost:${port}/metrics`);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
