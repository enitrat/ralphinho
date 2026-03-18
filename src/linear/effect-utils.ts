import * as BunContext from "@effect/platform-bun/BunContext";
import * as FetchHttpClient from "@effect/platform/FetchHttpClient";
import * as Otlp from "@effect/opentelemetry/Otlp";
import {
  Cause, Exit,
  Context,
  Effect,
  ManagedRuntime,
  Layer,
  Logger,
  LogLevel,
  Metric,
  MetricState,
  Option,
  MetricBoundaries,
} from "effect";
export type RunStatus =
  | "running"
  | "waiting-approval"
  | "finished"
  | "failed"
  | "cancelled";


export type SmithersEvent =
  | { type: "RunStarted"; runId: string; timestampMs: number }
  | {
      type: "RunStatusChanged";
      runId: string;
      status: RunStatus;
      timestampMs: number;
    }
  | { type: "RunFinished"; runId: string; timestampMs: number }
  | { type: "RunFailed"; runId: string; error: unknown; timestampMs: number }
  | { type: "RunCancelled"; runId: string; timestampMs: number }
  | {
      type: "FrameCommitted";
      runId: string;
      frameNo: number;
      xmlHash: string;
      timestampMs: number;
    }
  | {
      type: "NodePending";
      runId: string;
      nodeId: string;
      iteration: number;
      timestampMs: number;
    }
  | {
      type: "NodeStarted";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      timestampMs: number;
    }
  | {
      type: "NodeFinished";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      timestampMs: number;
    }
  | {
      type: "NodeFailed";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      error: unknown;
      timestampMs: number;
    }
  | {
      type: "NodeCancelled";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt?: number;
      reason?: string;
      timestampMs: number;
    }
  | {
      type: "NodeSkipped";
      runId: string;
      nodeId: string;
      iteration: number;
      timestampMs: number;
    }
  | {
      type: "NodeRetrying";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      timestampMs: number;
    }
  | {
      type: "NodeWaitingApproval";
      runId: string;
      nodeId: string;
      iteration: number;
      timestampMs: number;
    }
  | {
      type: "ApprovalRequested";
      runId: string;
      nodeId: string;
      iteration: number;
      timestampMs: number;
    }
  | {
      type: "ApprovalGranted";
      runId: string;
      nodeId: string;
      iteration: number;
      timestampMs: number;
    }
  | {
      type: "ApprovalDenied";
      runId: string;
      nodeId: string;
      iteration: number;
      timestampMs: number;
    }
  | {
      type: "ToolCallStarted";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      toolName: string;
      seq: number;
      timestampMs: number;
    }
  | {
      type: "ToolCallFinished";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      toolName: string;
      seq: number;
      status: "success" | "error";
      timestampMs: number;
    }
  | {
      type: "NodeOutput";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      text: string;
      stream: "stdout" | "stderr";
      timestampMs: number;
    }
  | {
      type: "RevertStarted";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      jjPointer: string;
      timestampMs: number;
    }
  | {
      type: "RevertFinished";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      jjPointer: string;
      success: boolean;
      error?: string;
      timestampMs: number;
    }
  | {
      type: "WorkflowReloadDetected";
      runId: string;
      changedFiles: string[];
      timestampMs: number;
    }
  | {
      type: "WorkflowReloaded";
      runId: string;
      generation: number;
      changedFiles: string[];
      timestampMs: number;
    }
  | {
      type: "WorkflowReloadFailed";
      runId: string;
      error: unknown;
      changedFiles: string[];
      timestampMs: number;
    }
  | {
      type: "WorkflowReloadUnsafe";
      runId: string;
      reason: string;
      changedFiles: string[];
      timestampMs: number;
    }
  | {
      type: "TokenUsageReported";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      model: string;
      agent: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      reasoningTokens?: number;
      timestampMs: number;
    };

export type SmithersLogFormat = "json" | "pretty" | "string" | "logfmt";

export type SmithersObservabilityOptions = {
  readonly enabled?: boolean;
  readonly endpoint?: string;
  readonly serviceName?: string;
  readonly logFormat?: SmithersLogFormat;
  readonly logLevel?: LogLevel.LogLevel | string;
};

export type ResolvedSmithersObservabilityOptions = {
  readonly enabled: boolean;
  readonly endpoint: string;
  readonly serviceName: string;
  readonly logFormat: SmithersLogFormat;
  readonly logLevel: LogLevel.LogLevel;
};

export type SmithersObservabilityService = {
  readonly options: ResolvedSmithersObservabilityOptions;
  readonly annotate: (
    attributes: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<void>;
  readonly withSpan: <A, E, R>(
    name: string,
    effect: Effect.Effect<A, E, R>,
    attributes?: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<A, E, R>;
};

export class SmithersObservability extends Context.Tag("SmithersObservability")<
  SmithersObservability,
  SmithersObservabilityService
>() {}

export const prometheusContentType =
  "text/plain; version=0.0.4; charset=utf-8";

type PrometheusMetricType = "counter" | "gauge" | "histogram" | "summary";

function sanitizePrometheusName(name: string): string {
  const next = name.replace(/[^a-zA-Z0-9_:]/g, "_");
  return /^[a-zA-Z_:]/.test(next) ? next : `_${next}`;
}

function escapePrometheusText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function escapePrometheusLabelValue(value: string): string {
  return escapePrometheusText(value).replace(/"/g, '\\"');
}

function formatPrometheusNumber(value: number | bigint): string {
  if (typeof value === "bigint") return value.toString();
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "+Inf";
  if (value === Number.NEGATIVE_INFINITY) return "-Inf";
  return String(value);
}

function formatPrometheusLabels(labels: ReadonlyArray<[string, string]>): string {
  if (labels.length === 0) return "";
  return `{${labels
    .map(
      ([key, value]) =>
        `${sanitizePrometheusName(key)}="${escapePrometheusLabelValue(value)}"`,
    )
    .join(",")}}`;
}

function mergePrometheusLabels(
  base: ReadonlyArray<[string, string]>,
  extra: ReadonlyArray<[string, string]>,
): string {
  const merged = [...base, ...extra].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return formatPrometheusLabels(merged);
}

function metricLabels(metricKey: any): ReadonlyArray<[string, string]> {
  const tags: any[] = Array.isArray(metricKey?.tags) ? metricKey.tags : [];
  return tags
    .map((tag: any) => [String(tag.key), String(tag.value)] as [string, string])
    .sort(
      ([left]: [string, string], [right]: [string, string]) =>
        left.localeCompare(right),
    );
}

function metricHelp(metricKey: any): string | undefined {
  const description = Option.getOrElse(
    metricKey?.description as Option.Option<string>,
    () => "",
  );
  return description.trim() ? description : undefined;
}

type PrometheusBucket = {
  boundary: number;
  count: number | bigint;
};

function histogramBuckets(metricState: any): PrometheusBucket[] {
  const buckets: PrometheusBucket[] = [];
  if (
    !metricState?.buckets ||
    typeof metricState.buckets[Symbol.iterator] !== "function"
  ) {
    return buckets;
  }
  for (const [boundary, count] of metricState.buckets as Iterable<
    readonly [number, number | bigint]
  >) {
    buckets.push({ boundary, count });
  }
  return buckets;
}

function registerPrometheusMetric(
  registry: Map<
    string,
    { type: PrometheusMetricType; help?: string; lines: string[] }
  >,
  name: string,
  type: PrometheusMetricType,
  help: string | undefined,
) {
  const existing = registry.get(name);
  if (existing) return existing;
  const created = { type, help, lines: [] };
  registry.set(name, created);
  return created;
}

export function renderPrometheusMetrics(): string {
  // Snapshot process-level gauges before rendering
  try { Effect.runSync(updateProcessMetrics()); } catch { /* non-critical */ }

  const registry = new Map<
    string,
    { type: PrometheusMetricType; help?: string; lines: string[] }
  >();

  for (const snapshot of Metric.unsafeSnapshot()) {
    const metricKey = snapshot.metricKey as any;
    const metricState = snapshot.metricState as any;
    const name = sanitizePrometheusName(String(metricKey.name ?? ""));
    if (!name) continue;

    const labels = metricLabels(metricKey);
    const help = metricHelp(metricKey);

    if (MetricState.isCounterState(metricState)) {
      const metric = registerPrometheusMetric(registry, name, "counter", help);
      metric.lines.push(
        `${name}${formatPrometheusLabels(labels)} ${formatPrometheusNumber(metricState.count)}`,
      );
      continue;
    }

    if (MetricState.isGaugeState(metricState)) {
      const metric = registerPrometheusMetric(registry, name, "gauge", help);
      metric.lines.push(
        `${name}${formatPrometheusLabels(labels)} ${formatPrometheusNumber(metricState.value)}`,
      );
      continue;
    }

    if (MetricState.isHistogramState(metricState)) {
      const metric = registerPrometheusMetric(registry, name, "histogram", help);
      for (const bucket of histogramBuckets(metricState)) {
        metric.lines.push(
          `${name}_bucket${mergePrometheusLabels(labels, [["le", String(bucket.boundary)]])} ${formatPrometheusNumber(bucket.count)}`,
        );
      }
      metric.lines.push(
        `${name}_bucket${mergePrometheusLabels(labels, [["le", "+Inf"]])} ${formatPrometheusNumber(metricState.count)}`,
      );
      metric.lines.push(
        `${name}_sum${formatPrometheusLabels(labels)} ${formatPrometheusNumber(metricState.sum)}`,
      );
      metric.lines.push(
        `${name}_count${formatPrometheusLabels(labels)} ${formatPrometheusNumber(metricState.count)}`,
      );
      continue;
    }

    if (MetricState.isFrequencyState(metricState)) {
      const metric = registerPrometheusMetric(registry, name, "counter", help);
      for (const [key, count] of metricState.occurrences as Map<
        string,
        number | bigint
      >) {
        metric.lines.push(
          `${name}${mergePrometheusLabels(labels, [["key", key]])} ${formatPrometheusNumber(count)}`,
        );
      }
      continue;
    }

    if (MetricState.isSummaryState(metricState)) {
      const metric = registerPrometheusMetric(registry, name, "summary", help);
      metric.lines.push(
        `${name}${mergePrometheusLabels(labels, [["quantile", "min"]])} ${formatPrometheusNumber(metricState.min)}`,
      );
      for (const [quantile, value] of metricState.quantiles as ReadonlyArray<
        readonly [number, Option.Option<number>]
      >) {
        metric.lines.push(
          `${name}${mergePrometheusLabels(labels, [["quantile", String(quantile)]])} ${formatPrometheusNumber(Option.getOrElse(value, () => 0))}`,
        );
      }
      metric.lines.push(
        `${name}${mergePrometheusLabels(labels, [["quantile", "max"]])} ${formatPrometheusNumber(metricState.max)}`,
      );
      metric.lines.push(
        `${name}_sum${formatPrometheusLabels(labels)} ${formatPrometheusNumber(metricState.sum)}`,
      );
      metric.lines.push(
        `${name}_count${formatPrometheusLabels(labels)} ${formatPrometheusNumber(metricState.count)}`,
      );
    }
  }

  const lines: string[] = [];
  for (const [name, metric] of [...registry.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (metric.help) {
      lines.push(`# HELP ${name} ${escapePrometheusText(metric.help)}`);
    }
    lines.push(`# TYPE ${name} ${metric.type}`);
    lines.push(...metric.lines.sort((left, right) => left.localeCompare(right)));
  }
  return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}

function resolveLogLevel(
  value: LogLevel.LogLevel | string | undefined,
): LogLevel.LogLevel {
  if (typeof value !== "string") {
    return value ?? LogLevel.Info;
  }
  switch (value.toLowerCase()) {
    case "none":
      return LogLevel.None;
    case "trace":
      return LogLevel.Trace;
    case "debug":
      return LogLevel.Debug;
    case "warning":
    case "warn":
      return LogLevel.Warning;
    case "error":
      return LogLevel.Error;
    case "fatal":
      return LogLevel.Fatal;
    case "all":
      return LogLevel.All;
    case "info":
    default:
      return LogLevel.Info;
  }
}

function resolveLogFormat(value: string | undefined): SmithersLogFormat {
  switch ((value ?? "").toLowerCase()) {
    case "json":
      return "json";
    case "pretty":
      return "pretty";
    case "string":
      return "string";
    case "logfmt":
    default:
      return "logfmt";
  }
}

function resolveLogger(format: SmithersLogFormat) {
  switch (format) {
    case "json":
      return Logger.withLeveledConsole(Logger.jsonLogger);
    case "pretty":
      return Logger.prettyLogger();
    case "string":
      return Logger.withLeveledConsole(Logger.stringLogger);
    case "logfmt":
    default:
      return Logger.withLeveledConsole(Logger.logfmtLogger);
  }
}

function resolveEnabled(value: boolean | undefined): boolean {
  if (typeof value === "boolean") return value;
  const env = (process.env.SMITHERS_OTEL_ENABLED ?? "").toLowerCase();
  return env === "1" || env === "true";
}

function makeService(
  options: ResolvedSmithersObservabilityOptions,
): SmithersObservabilityService {
  return {
    options,
    annotate: (attributes) => Effect.void.pipe(Effect.annotateLogs(attributes)),
    withSpan: (name, effect, attributes) =>
      (attributes && Object.keys(attributes).length > 0
        ? effect.pipe(Effect.annotateLogs(attributes))
        : effect
      ).pipe(Effect.withLogSpan(name)),
  };
}

export function resolveSmithersObservabilityOptions(
  options: SmithersObservabilityOptions = {},
): ResolvedSmithersObservabilityOptions {
  return {
    enabled: resolveEnabled(options.enabled),
    endpoint:
      options.endpoint ??
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
      "http://localhost:4318",
    serviceName:
      options.serviceName ?? process.env.OTEL_SERVICE_NAME ?? "smithers",
    logFormat: options.logFormat
      ? resolveLogFormat(options.logFormat)
      : resolveLogFormat(process.env.SMITHERS_LOG_FORMAT),
    logLevel: resolveLogLevel(
      options.logLevel ?? process.env.SMITHERS_LOG_LEVEL,
    ),
  };
}

export function createSmithersOtelLayer(
  options: SmithersObservabilityOptions = {},
) {
  const resolved = resolveSmithersObservabilityOptions(options);
  if (!resolved.enabled) {
    return Layer.empty;
  }
  return Otlp.layerJson({
    baseUrl: resolved.endpoint,
    resource: { serviceName: resolved.serviceName },
  }).pipe(Layer.provide(FetchHttpClient.layer));
}

export function createSmithersObservabilityLayer(
  options: SmithersObservabilityOptions = {},
) {
  const resolved = resolveSmithersObservabilityOptions(options);
  return Layer.mergeAll(
    BunContext.layer,
    Logger.replace(Logger.defaultLogger, resolveLogger(resolved.logFormat)),
    Logger.minimumLogLevel(resolved.logLevel),
    createSmithersOtelLayer(resolved),
    Layer.succeed(SmithersObservability, makeService(resolved)),
  );
}

export const createSmithersRuntimeLayer = createSmithersObservabilityLayer;


export function toError(cause: unknown, label?: string): Error {
  if (cause instanceof Error) {
    if (!label) return cause;
    return new Error(`${label}: ${cause.message}`, { cause });
  }
  return new Error(label ? `${label}: ${String(cause)}` : String(cause));
}

export function fromPromise<A>(
  label: string,
  evaluate: () => PromiseLike<A>,
): Effect.Effect<A, Error> {
  return Effect.tryPromise({
    try: () => evaluate(),
    catch: (cause) => toError(cause, label),
  });
}

export function fromSync<A>(
  label: string,
  evaluate: () => A,
): Effect.Effect<A, Error> {
  return Effect.try({
    try: () => evaluate(),
    catch: (cause) => toError(cause, label),
  });
}

export function dieSync<A>(
  label: string,
  evaluate: () => A,
): Effect.Effect<A> {
  return Effect.sync(() => {
    try {
      return evaluate();
    } catch (cause) {
      throw toError(cause, label);
    }
  });
}


const SmithersRuntimeLayer = createSmithersRuntimeLayer();

const runtime = ManagedRuntime.make(SmithersRuntimeLayer);

function decorate<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(Effect.annotateLogs("service", "smithers"));
}

function normalizeRejection(cause: unknown) {
  if (cause instanceof Error) return cause;
  return new Error(String(cause));
}

export async function runPromise<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options?: { signal?: AbortSignal },
) {
  const exit = await runtime.runPromiseExit(
    decorate(effect) as Effect.Effect<A, E, never>,
    options,
  );
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  const failure = Cause.failureOption(exit.cause);
  if (failure._tag === "Some") {
    throw normalizeRejection(failure.value);
  }
  throw normalizeRejection(Cause.squash(exit.cause));
}

export function runPromiseExit<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options?: { signal?: AbortSignal },
) {
  return runtime.runPromiseExit(
    decorate(effect) as Effect.Effect<A, E, never>,
    options,
  );
}

export function runFork<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return runtime.runFork(decorate(effect) as Effect.Effect<A, E, never>);
}

export function runSync<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return runtime.runSync(decorate(effect) as Effect.Effect<A, E, never>);
}

export { SmithersRuntimeLayer };


type LogAnnotations = Record<string, unknown> | undefined;

function emitLog(
  effect: Effect.Effect<void, never, never>,
  annotations?: LogAnnotations,
  span?: string,
) {
  let program = effect;
  if (annotations) {
    program = program.pipe(Effect.annotateLogs(annotations));
  }
  if (span) {
    program = program.pipe(Effect.withLogSpan(span));
  }
  void runFork(program);
}

export function logDebug(
  message: string,
  annotations?: LogAnnotations,
  span?: string,
) {
  emitLog(Effect.logDebug(message), annotations, span);
}

export function logInfo(
  message: string,
  annotations?: LogAnnotations,
  span?: string,
) {
  emitLog(Effect.logInfo(message), annotations, span);
}

export function logWarning(
  message: string,
  annotations?: LogAnnotations,
  span?: string,
) {
  emitLog(Effect.logWarning(message), annotations, span);
}

export function logError(
  message: string,
  annotations?: LogAnnotations,
  span?: string,
) {
  emitLog(Effect.logError(message), annotations, span);
}

// ---------------------------------------------------------------------------
// Counters — existing
// ---------------------------------------------------------------------------

export const runsTotal = Metric.counter("smithers.runs.total");
export const nodesStarted = Metric.counter("smithers.nodes.started");
export const nodesFinished = Metric.counter("smithers.nodes.finished");
export const nodesFailed = Metric.counter("smithers.nodes.failed");
export const toolCallsTotal = Metric.counter("smithers.tool_calls.total");
export const cacheHits = Metric.counter("smithers.cache.hits");
export const cacheMisses = Metric.counter("smithers.cache.misses");
export const dbRetries = Metric.counter("smithers.db.retries");
export const hotReloads = Metric.counter("smithers.hot.reloads");
export const hotReloadFailures = Metric.counter("smithers.hot.reload_failures");
export const httpRequests = Metric.counter("smithers.http.requests");
export const approvalsRequested = Metric.counter("smithers.approvals.requested");
export const approvalsGranted = Metric.counter("smithers.approvals.granted");
export const approvalsDenied = Metric.counter("smithers.approvals.denied");

// ---------------------------------------------------------------------------
// Counters — token usage
// ---------------------------------------------------------------------------

export const tokensInputTotal = Metric.counter("smithers.tokens.input_total");
export const tokensOutputTotal = Metric.counter("smithers.tokens.output_total");
export const tokensCacheReadTotal = Metric.counter("smithers.tokens.cache_read_total");
export const tokensCacheWriteTotal = Metric.counter("smithers.tokens.cache_write_total");
export const tokensReasoningTotal = Metric.counter("smithers.tokens.reasoning_total");

// ---------------------------------------------------------------------------
// Counters — run lifecycle
// ---------------------------------------------------------------------------

export const runsFinishedTotal = Metric.counter("smithers.runs.finished_total");
export const runsFailedTotal = Metric.counter("smithers.runs.failed_total");
export const runsCancelledTotal = Metric.counter("smithers.runs.cancelled_total");
export const runsResumedTotal = Metric.counter("smithers.runs.resumed_total");

// ---------------------------------------------------------------------------
// Counters — errors & retries
// ---------------------------------------------------------------------------

export const errorsTotal = Metric.counter("smithers.errors.total");
export const nodeRetriesTotal = Metric.counter("smithers.node.retries_total");
export const toolCallErrorsTotal = Metric.counter("smithers.tool_calls.errors_total");
export const toolOutputTruncatedTotal = Metric.counter("smithers.tool.output_truncated_total");

// ---------------------------------------------------------------------------
// Counters — events
// ---------------------------------------------------------------------------

export const eventsEmittedTotal = Metric.counter("smithers.events.emitted_total");

// ---------------------------------------------------------------------------
// Gauges — existing
// ---------------------------------------------------------------------------

export const activeRuns = Metric.gauge("smithers.runs.active");
export const activeNodes = Metric.gauge("smithers.nodes.active");
export const schedulerQueueDepth = Metric.gauge("smithers.scheduler.queue_depth");

// ---------------------------------------------------------------------------
// Gauges — new
// ---------------------------------------------------------------------------

export const approvalPending = Metric.gauge("smithers.approval.pending");
export const schedulerConcurrencyUtilization = Metric.gauge("smithers.scheduler.concurrency_utilization");
export const processUptimeSeconds = Metric.gauge("smithers.process.uptime_seconds");
export const processMemoryRssBytes = Metric.gauge("smithers.process.memory_rss_bytes");
export const processHeapUsedBytes = Metric.gauge("smithers.process.heap_used_bytes");

// ---------------------------------------------------------------------------
// Histograms — buckets
// ---------------------------------------------------------------------------

const durationBuckets = MetricBoundaries.exponential({
  start: 100,
  factor: 2,
  count: 12,
}); // ~100ms to ~200s

const fastBuckets = MetricBoundaries.exponential({
  start: 1,
  factor: 2,
  count: 12,
}); // ~1ms to ~2s

const toolBuckets = MetricBoundaries.exponential({
  start: 10,
  factor: 2,
  count: 14,
}); // ~10ms to ~80s

const tokenBuckets = MetricBoundaries.exponential({
  start: 10,
  factor: 2,
  count: 18,
}); // ~10 to ~1.3M tokens

const sizeBuckets = MetricBoundaries.exponential({
  start: 100,
  factor: 2,
  count: 16,
}); // ~100 bytes to ~3.2MB

// ---------------------------------------------------------------------------
// Histograms — existing
// ---------------------------------------------------------------------------

export const nodeDuration = Metric.histogram(
  "smithers.node.duration_ms",
  durationBuckets,
);

export const attemptDuration = Metric.histogram(
  "smithers.attempt.duration_ms",
  durationBuckets,
);

export const toolDuration = Metric.histogram(
  "smithers.tool.duration_ms",
  toolBuckets,
);

export const dbQueryDuration = Metric.histogram(
  "smithers.db.query_ms",
  fastBuckets,
);

export const httpRequestDuration = Metric.histogram(
  "smithers.http.request_duration_ms",
  fastBuckets,
);

export const hotReloadDuration = Metric.histogram(
  "smithers.hot.reload_duration_ms",
  durationBuckets,
);

export const vcsDuration = Metric.histogram(
  "smithers.vcs.duration_ms",
  fastBuckets,
);

// ---------------------------------------------------------------------------
// Histograms — new
// ---------------------------------------------------------------------------

export const tokensInputPerCall = Metric.histogram(
  "smithers.tokens.input_per_call",
  tokenBuckets,
);

export const tokensOutputPerCall = Metric.histogram(
  "smithers.tokens.output_per_call",
  tokenBuckets,
);

export const runDuration = Metric.histogram(
  "smithers.run.duration_ms",
  durationBuckets,
);

export const promptSizeBytes = Metric.histogram(
  "smithers.prompt.size_bytes",
  sizeBuckets,
);

export const responseSizeBytes = Metric.histogram(
  "smithers.response.size_bytes",
  sizeBuckets,
);

export const approvalWaitDuration = Metric.histogram(
  "smithers.approval.wait_duration_ms",
  durationBuckets,
);

export const schedulerWaitDuration = Metric.histogram(
  "smithers.scheduler.wait_duration_ms",
  durationBuckets,
);

// ---------------------------------------------------------------------------
// Process-level metric snapshot (call periodically)
// ---------------------------------------------------------------------------

const processStartMs = Date.now();

export function updateProcessMetrics(): Effect.Effect<void> {
  const uptimeS = (Date.now() - processStartMs) / 1000;
  const mem = process.memoryUsage();
  return Effect.all([
    Metric.set(processUptimeSeconds, uptimeS),
    Metric.set(processMemoryRssBytes, mem.rss),
    Metric.set(processHeapUsedBytes, mem.heapUsed),
  ], { discard: true });
}

// ---------------------------------------------------------------------------
// Event-driven metric tracking
// ---------------------------------------------------------------------------

export function trackEvent(event: SmithersEvent): Effect.Effect<void> {
  // Always count the event by type
  const countEvent = Metric.increment(eventsEmittedTotal);

  switch (event.type) {
    case "RunStarted":
      return Effect.all([
        countEvent,
        Metric.increment(runsTotal),
        Metric.update(activeRuns, 1),
      ], { discard: true });

    case "RunFinished":
      return Effect.all([
        countEvent,
        Metric.update(activeRuns, -1),
        Metric.increment(runsFinishedTotal),
      ], { discard: true });

    case "RunFailed":
      return Effect.all([
        countEvent,
        Metric.update(activeRuns, -1),
        Metric.increment(runsFailedTotal),
        Metric.increment(errorsTotal),
      ], { discard: true });

    case "RunCancelled":
      return Effect.all([
        countEvent,
        Metric.update(activeRuns, -1),
        Metric.increment(runsCancelledTotal),
      ], { discard: true });

    case "NodeStarted":
      return Effect.all([
        countEvent,
        Metric.increment(nodesStarted),
        Metric.update(activeNodes, 1),
      ], { discard: true });

    case "NodeFinished":
      return Effect.all([
        countEvent,
        Metric.increment(nodesFinished),
        Metric.update(activeNodes, -1),
      ], { discard: true });

    case "NodeFailed":
      return Effect.all([
        countEvent,
        Metric.increment(nodesFailed),
        Metric.update(activeNodes, -1),
        Metric.increment(errorsTotal),
      ], { discard: true });

    case "NodeCancelled":
      return Effect.all([
        countEvent,
        Metric.update(activeNodes, -1),
      ], { discard: true });

    case "NodeRetrying":
      return Effect.all([
        countEvent,
        Metric.increment(nodeRetriesTotal),
      ], { discard: true });

    case "ToolCallStarted":
      return Effect.all([
        countEvent,
        Metric.increment(toolCallsTotal),
      ], { discard: true });

    case "ToolCallFinished":
      return event.status === "error"
        ? Effect.all([
            countEvent,
            Metric.increment(toolCallErrorsTotal),
          ], { discard: true })
        : countEvent;

    case "ApprovalRequested":
      return Effect.all([
        countEvent,
        Metric.increment(approvalsRequested),
        Metric.update(approvalPending, 1),
      ], { discard: true });

    case "ApprovalGranted":
      return Effect.all([
        countEvent,
        Metric.increment(approvalsGranted),
        Metric.update(approvalPending, -1),
      ], { discard: true });

    case "ApprovalDenied":
      return Effect.all([
        countEvent,
        Metric.increment(approvalsDenied),
        Metric.update(approvalPending, -1),
      ], { discard: true });

    case "TokenUsageReported": {
      const effects: Effect.Effect<void>[] = [countEvent];
      if (event.inputTokens > 0) {
        effects.push(
          Metric.incrementBy(tokensInputTotal, event.inputTokens),
          Metric.update(tokensInputPerCall, event.inputTokens),
        );
      }
      if (event.outputTokens > 0) {
        effects.push(
          Metric.incrementBy(tokensOutputTotal, event.outputTokens),
          Metric.update(tokensOutputPerCall, event.outputTokens),
        );
      }
      if (event.cacheReadTokens && event.cacheReadTokens > 0) {
        effects.push(Metric.incrementBy(tokensCacheReadTotal, event.cacheReadTokens));
      }
      if (event.cacheWriteTokens && event.cacheWriteTokens > 0) {
        effects.push(Metric.incrementBy(tokensCacheWriteTotal, event.cacheWriteTokens));
      }
      if (event.reasoningTokens && event.reasoningTokens > 0) {
        effects.push(Metric.incrementBy(tokensReasoningTotal, event.reasoningTokens));
      }
      return Effect.all(effects, { discard: true });
    }

    default:
      return countEvent;
  }
}
