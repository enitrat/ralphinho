import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const ENV_KEYS = [
  "SMITHERS_OTEL_ENABLED",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_SERVICE_NAME",
] as const;

const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (typeof value === "string") process.env[key] = value;
    else delete process.env[key];
  }
});

describe("observability", () => {
  test("is disabled by default and record helpers are no-ops", async () => {
    const mod = await import(`../observability.ts?disabled=${Date.now()}`);
    expect(mod.isEnabled()).toBe(false);
    expect(mod.initializeObservability()).toBe(false);
    mod.recordSpan("test-span", { foo: "bar" });
    mod.incrementCounter("test-counter");
  });

  test("SMITHERS_OTEL_ENABLED=1 enables OTLP initialization", async () => {
    process.env.SMITHERS_OTEL_ENABLED = "1";
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
    process.env.OTEL_SERVICE_NAME = "test-smithers";

    const fetchMock = mock(() => Promise.resolve(new Response(null, { status: 200 })));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as any;

    try {
      const mod = await import(`../observability.ts?enabled=${Date.now()}`);
      expect(mod.isEnabled()).toBe(true);
      expect(mod.initializeObservability()).toBe(true);
      mod.recordSpan("render.monitor", { run_id: "run-1" });
      mod.incrementCounter("monitor.poll", 2);
      expect(fetchMock).toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
