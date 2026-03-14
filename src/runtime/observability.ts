const ENABLED = process.env.SMITHERS_OTEL_ENABLED === "1";
const ENDPOINT = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318").replace(/\/+$/, "");
const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || "smithers";

let initialized = false;

function sendOtlp(path: string, payload: unknown): void {
  if (!ENABLED || typeof fetch !== "function") return;
  void fetch(`${ENDPOINT}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  }).catch(() => {
    // Fire-and-forget by design; monitor operations must not fail on telemetry transport errors.
  });
}

export function isEnabled(): boolean {
  return ENABLED;
}

export function initializeObservability(): boolean {
  if (!ENABLED || initialized) return false;
  initialized = true;
  return true;
}

export function recordSpan(name: string, attributes: Record<string, string | number>): void {
  if (!ENABLED) return;
  initializeObservability();
  const timestamp = Date.now() * 1_000_000;
  sendOtlp("/v1/traces", {
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: SERVICE_NAME } }],
        },
        scopeSpans: [
          {
            scope: { name: "super-ralph-monitor" },
            spans: [
              {
                name,
                startTimeUnixNano: timestamp,
                endTimeUnixNano: timestamp,
                attributes: Object.entries(attributes).map(([key, value]) => (
                  typeof value === "number"
                    ? { key, value: { doubleValue: value } }
                    : { key, value: { stringValue: value } }
                )),
              },
            ],
          },
        ],
      },
    ],
  });
}

export function incrementCounter(name: string, value = 1): void {
  if (!ENABLED) return;
  initializeObservability();
  sendOtlp("/v1/metrics", {
    resourceMetrics: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: SERVICE_NAME } }],
        },
        scopeMetrics: [
          {
            scope: { name: "super-ralph-monitor" },
            metrics: [
              {
                name,
                sum: {
                  dataPoints: [
                    {
                      asDouble: value,
                      timeUnixNano: Date.now() * 1_000_000,
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  });
}
