import { NS } from "../../../NetScriptDefinitions";
import { ILogger, LogLevel } from "./logger";

/**
 * Pure user-space OpenTelemetry client for Bitburner — logs, metrics, and traces — with no
 * game modifications and ZERO script RAM cost. It formats OTLP/JSON and POSTs straight to a
 * collector using the browser's global `fetch` (Bitburner scripts run as ES modules in the
 * page realm, so `fetch` is in scope). Bare `fetch(...)` costs no RAM; this never references
 * `window`/`document` (which would cost 25 GB each under Bitburner's static RAM analysis).
 *
 * API shape: `client.logs.*`, `client.metrics.*`, `client.traces.*`, with a single `flush()`
 * that ships all three signals to `${endpoint}/v1/{logs,metrics,traces}`. Buffers flush on
 * size, on `flushIntervalMs`, on `flush()`, and (best-effort) on `ns.atExit`.
 *
 * Your collector must allow the browser origin (CORS) — without it the browser blocks the
 * POST before it leaves. The docker-compose stack in this repo's `collector/` folder ships a
 * CORS-open OTLP receiver on `:4318` that forwards to Loki, Prometheus, and Tempo.
 */

export type AttrValue = string | number | boolean;
export type Attributes = Record<string, AttrValue>;

export interface OtlpConfig {
  /** Base collector URL, e.g. "http://localhost:4318". Per-signal paths are appended. */
  endpoint: string;
  /** Resource service.name. Default "bitburner-scripts". */
  serviceName?: string;
  /** Minimum log level to emit (metrics/traces are always emitted). Default LogLevel.INFO. */
  level?: LogLevel;
  /** Extra resource-level attributes. */
  resourceAttributes?: Attributes;
  /** Extra HTTP headers (e.g. an auth token). */
  headers?: Record<string, string>;
  /** Flush when buffered logs/spans reach this many. Default 64. */
  maxBatch?: number;
  /** Also flush if this many ms have passed since the last flush. Default 5000. */
  flushIntervalMs?: number;
  /** Auto-tag logs/spans with the calling script's pid/filename/server/args. Default true. */
  includeScriptInfo?: boolean;
  /** Explicit histogram bucket boundaries. */
  histogramBounds?: number[];
  /** Also ns.print each emitted log to the script's own tail. Default false (OtlpLogger: true). */
  echoToScriptLog?: boolean;
}

/** Default collector endpoint — the CORS-open receiver from this repo's collector stack. */
export const DEFAULT_OTLP_ENDPOINT = "http://localhost:4318";

interface AnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string;
  doubleValue?: number;
}
interface KeyValue {
  key: string;
  value: AnyValue;
}
interface LogRecord {
  timeUnixNano: string;
  severityNumber: number;
  severityText: string;
  body: { stringValue: string };
  attributes: KeyValue[];
}
interface SpanEvent {
  timeUnixNano: string;
  name: string;
  attributes: KeyValue[];
}
interface OpenSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  attributes: KeyValue[];
  events: SpanEvent[];
}
interface FinishedSpan extends OpenSpan {
  endTimeUnixNano: string;
  status: { code: number };
}

interface SumSeries {
  attributes: KeyValue[];
  value: number;
}
interface HistSeries {
  attributes: KeyValue[];
  count: number;
  sum: number;
  min: number;
  max: number;
  buckets: number[];
}

const DEFAULT_BOUNDS = [0, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

function nowNano(): string {
  return String(Date.now() * 1_000_000);
}
function randHex(bytes: number): string {
  let s = "";
  for (let i = 0; i < bytes; i++) s += Math.floor(Math.random() * 256).toString(16).padStart(2, "0");
  return s;
}
function toAnyValue(v: AttrValue): AnyValue {
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  return { stringValue: String(v) };
}
function toKeyValues(attrs: Attributes): KeyValue[] {
  return Object.entries(attrs).map(([key, value]) => ({ key, value: toAnyValue(value) }));
}
function attrsKey(attrs: Attributes): string {
  return JSON.stringify(Object.entries(attrs).sort((a, b) => a[0].localeCompare(b[0])));
}
function toSeverity(level: LogLevel): [number, string] {
  switch (level) {
    case LogLevel.ERROR:
      return [17, "ERROR"];
    case LogLevel.WARNING:
      return [13, "WARN"];
    case LogLevel.INFO:
    case LogLevel.GLOBAL:
      return [9, "INFO"];
    default:
      return [5, "DEBUG"];
  }
}

export interface SpanStartOptions {
  attributes?: Attributes;
  /** Handle of another span to nest under. Omit for an independent root trace. */
  parent?: string;
}
export interface SpanEndOptions {
  error?: boolean;
  attributes?: Attributes;
}

export class OtlpClient {
  private readonly ns: NS;
  private readonly base: string;
  private readonly level: LogLevel;
  private readonly headers: Record<string, string>;
  private readonly maxBatch: number;
  private readonly flushIntervalMs: number;
  private readonly resource: KeyValue[];
  private readonly scriptInfo: KeyValue[];
  private readonly startTimeUnixNano = nowNano();
  private readonly bounds: number[];
  private readonly echo: boolean;

  private logBuffer: LogRecord[] = [];
  private finishedSpans: FinishedSpan[] = [];
  private openSpans = new Map<string, OpenSpan>();
  private counters = new Map<string, Map<string, SumSeries>>();
  private upDowns = new Map<string, Map<string, SumSeries>>();
  private gauges = new Map<string, Map<string, SumSeries>>();
  private histograms = new Map<string, Map<string, HistSeries>>();
  private lastFlush = Date.now();

  readonly logs = {
    debug: (message: string, attributes?: Attributes) => this.emitLog(message, LogLevel.DEBUG, attributes),
    info: (message: string, attributes?: Attributes) => this.emitLog(message, LogLevel.INFO, attributes),
    warn: (message: string, attributes?: Attributes) => this.emitLog(message, LogLevel.WARNING, attributes),
    error: (message: string, attributes?: Attributes) => this.emitLog(message, LogLevel.ERROR, attributes),
    log: (message: string, level: LogLevel = LogLevel.INFO) => this.emitLog(message, level),
  };

  readonly metrics = {
    counter: (name: string, value = 1, attributes: Attributes = {}) => this.recordSum(this.counters, name, value, attributes),
    upDownCounter: (name: string, value: number, attributes: Attributes = {}) =>
      this.recordSum(this.upDowns, name, value, attributes),
    gauge: (name: string, value: number, attributes: Attributes = {}) => this.recordGauge(name, value, attributes),
    histogram: (name: string, value: number, attributes: Attributes = {}) => this.recordHistogram(name, value, attributes),
  };

  readonly traces = {
    startSpan: (name: string, options: SpanStartOptions = {}) => this.startSpan(name, options),
    endSpan: (handle: string, options: SpanEndOptions = {}) => this.endSpan(handle, options),
    spanEvent: (handle: string, name: string, attributes: Attributes = {}) => this.spanEvent(handle, name, attributes),
    setSpanAttributes: (handle: string, attributes: Attributes) => this.setSpanAttributes(handle, attributes),
  };

  constructor(ns: NS, config: OtlpConfig) {
    this.ns = ns;
    this.base = config.endpoint.replace(/\/+$/, "");
    this.level = config.level ?? LogLevel.INFO;
    this.headers = { "Content-Type": "application/json", ...(config.headers ?? {}) };
    this.maxBatch = config.maxBatch ?? 64;
    this.flushIntervalMs = config.flushIntervalMs ?? 5000;
    this.bounds = config.histogramBounds ?? DEFAULT_BOUNDS;
    this.echo = config.echoToScriptLog ?? false;
    this.resource = toKeyValues({
      "service.name": config.serviceName ?? "bitburner-scripts",
      ...(config.resourceAttributes ?? {}),
    });
    this.scriptInfo =
      (config.includeScriptInfo ?? true)
        ? toKeyValues({
            "script.pid": ns.pid,
            "script.filename": ns.getScriptName(),
            "script.server": ns.getHostname(),
            "script.args": JSON.stringify(ns.args),
          })
        : [];
    ns.atExit(() => void this.flush(), "otlpClient-flush");
  }

  // --- logs ---
  private emitLog(message: string, level: LogLevel, attributes?: Attributes): boolean {
    if (level !== LogLevel.GLOBAL && level > this.level) return false;
    const [severityNumber, severityText] = toSeverity(level);
    if (this.echo) this.ns.print(`[${severityText}] ${message}`);
    this.logBuffer.push({
      timeUnixNano: nowNano(),
      severityNumber,
      severityText,
      body: { stringValue: message },
      attributes: [...this.scriptInfo, ...toKeyValues(attributes ?? {})],
    });
    this.maybeFlush();
    return true;
  }

  // --- metrics ---
  private recordSum(map: Map<string, Map<string, SumSeries>>, name: string, value: number, attributes: Attributes): void {
    const series = this.getSeries(map, name, attributes, () => ({ attributes: toKeyValues(attributes), value: 0 }));
    series.value += value;
    this.maybeFlush();
  }
  private recordGauge(name: string, value: number, attributes: Attributes): void {
    const series = this.getSeries(this.gauges, name, attributes, () => ({ attributes: toKeyValues(attributes), value: 0 }));
    series.value = value;
    this.maybeFlush();
  }
  private recordHistogram(name: string, value: number, attributes: Attributes): void {
    const series = this.getSeries(this.histograms, name, attributes, () => ({
      attributes: toKeyValues(attributes),
      count: 0,
      sum: 0,
      min: value,
      max: value,
      buckets: new Array<number>(this.bounds.length + 1).fill(0),
    }));
    series.count += 1;
    series.sum += value;
    series.min = Math.min(series.min, value);
    series.max = Math.max(series.max, value);
    let idx = this.bounds.findIndex((b) => value <= b);
    if (idx === -1) idx = this.bounds.length;
    series.buckets[idx] += 1;
    this.maybeFlush();
  }
  private getSeries<T>(map: Map<string, Map<string, T>>, name: string, attributes: Attributes, make: () => T): T {
    let byAttrs = map.get(name);
    if (!byAttrs) map.set(name, (byAttrs = new Map<string, T>()));
    const key = attrsKey(attributes);
    let series = byAttrs.get(key);
    if (!series) byAttrs.set(key, (series = make()));
    return series;
  }

  // --- traces ---
  private startSpan(name: string, options: SpanStartOptions): string {
    const parent = options.parent ? this.openSpans.get(options.parent) : undefined;
    const spanId = randHex(8);
    const span: OpenSpan = {
      traceId: parent ? parent.traceId : randHex(16),
      spanId,
      parentSpanId: parent?.spanId,
      name,
      startTimeUnixNano: nowNano(),
      attributes: toKeyValues(options.attributes ?? {}),
      events: [],
    };
    this.openSpans.set(spanId, span);
    return spanId;
  }
  private endSpan(handle: string, options: SpanEndOptions): void {
    const span = this.openSpans.get(handle);
    if (!span) return;
    this.openSpans.delete(handle);
    if (options.attributes) span.attributes.push(...toKeyValues(options.attributes));
    this.finishedSpans.push({
      ...span,
      endTimeUnixNano: nowNano(),
      status: { code: options.error ? 2 : 0 },
    });
    this.maybeFlush();
  }
  private spanEvent(handle: string, name: string, attributes: Attributes): void {
    this.openSpans.get(handle)?.events.push({ timeUnixNano: nowNano(), name, attributes: toKeyValues(attributes) });
  }
  private setSpanAttributes(handle: string, attributes: Attributes): void {
    this.openSpans.get(handle)?.attributes.push(...toKeyValues(attributes));
  }

  // --- flushing ---
  private maybeFlush(): void {
    if (
      this.logBuffer.length >= this.maxBatch ||
      this.finishedSpans.length >= this.maxBatch ||
      Date.now() - this.lastFlush >= this.flushIntervalMs
    ) {
      void this.flush();
    }
  }

  /** Ships all buffered signals to the collector. Safe to call any time. */
  async flush(): Promise<void> {
    this.lastFlush = Date.now();
    const jobs: Promise<void>[] = [];

    if (this.logBuffer.length > 0) {
      const logRecords = this.logBuffer;
      this.logBuffer = [];
      jobs.push(
        this.post("/v1/logs", {
          resourceLogs: [
            { resource: { attributes: this.resource }, scopeLogs: [{ scope: { name: "bitburner-scripts" }, logRecords }] },
          ],
        }),
      );
    }

    const metrics = this.buildMetrics();
    if (metrics.length > 0) {
      jobs.push(
        this.post("/v1/metrics", {
          resourceMetrics: [
            { resource: { attributes: this.resource }, scopeMetrics: [{ scope: { name: "bitburner-scripts" }, metrics }] },
          ],
        }),
      );
    }

    if (this.finishedSpans.length > 0) {
      const spans = this.finishedSpans;
      this.finishedSpans = [];
      jobs.push(
        this.post("/v1/traces", {
          resourceSpans: [
            { resource: { attributes: this.resource }, scopeSpans: [{ scope: { name: "bitburner-scripts" }, spans }] },
          ],
        }),
      );
    }

    await Promise.all(jobs);
  }

  private buildMetrics(): unknown[] {
    const now = nowNano();
    const out: unknown[] = [];
    const addSums = (map: Map<string, Map<string, SumSeries>>, isMonotonic: boolean) => {
      for (const [name, series] of map) {
        out.push({
          name,
          sum: {
            aggregationTemporality: 2, // CUMULATIVE
            isMonotonic,
            dataPoints: [...series.values()].map((s) => ({
              asDouble: s.value,
              startTimeUnixNano: this.startTimeUnixNano,
              timeUnixNano: now,
              attributes: s.attributes,
            })),
          },
        });
      }
    };
    addSums(this.counters, true);
    addSums(this.upDowns, false);
    for (const [name, series] of this.gauges) {
      out.push({
        name,
        gauge: {
          dataPoints: [...series.values()].map((s) => ({ asDouble: s.value, timeUnixNano: now, attributes: s.attributes })),
        },
      });
    }
    for (const [name, series] of this.histograms) {
      out.push({
        name,
        histogram: {
          aggregationTemporality: 2,
          dataPoints: [...series.values()].map((s) => ({
            count: String(s.count),
            sum: s.sum,
            min: s.min,
            max: s.max,
            bucketCounts: s.buckets.map(String),
            explicitBounds: this.bounds,
            startTimeUnixNano: this.startTimeUnixNano,
            timeUnixNano: now,
            attributes: s.attributes,
          })),
        },
      });
    }
    return out;
  }

  private async post(path: string, payload: unknown): Promise<void> {
    try {
      await fetch(this.base + path, { method: "POST", headers: this.headers, body: JSON.stringify(payload) });
    } catch (error) {
      this.ns.print(`OTLP ${path} flush failed: ${String(error)}`);
    }
  }
}

/**
 * Logs-only convenience that implements the repo's ILogger interface, so it drops into
 * anything that takes an ILogger. Wraps an OtlpClient. This is the replacement for the
 * old engine-backed TelemetryLogger (stock Bitburner has no ns.telemetry): zero-config
 * `new OtlpLogger(ns)` ships to http://localhost:4318 and echoes to the script's tail.
 */
export class OtlpLogger implements ILogger {
  /** The underlying full client — use it to emit traces/metrics through the same connection. */
  readonly client: OtlpClient;
  constructor(ns: NS, config: Partial<OtlpConfig> = {}) {
    this.client = new OtlpClient(ns, { endpoint: DEFAULT_OTLP_ENDPOINT, echoToScriptLog: true, ...config });
  }
  log(message: string, level: LogLevel = LogLevel.INFO): boolean {
    return this.client.logs.log(message, level);
  }
  debug(message: string, attributes?: Attributes): boolean {
    return this.client.logs.debug(message, attributes);
  }
  info(message: string, attributes?: Attributes): boolean {
    return this.client.logs.info(message, attributes);
  }
  warn(message: string, attributes?: Attributes): boolean {
    return this.client.logs.warn(message, attributes);
  }
  error(message: string, attributes?: Attributes): boolean {
    return this.client.logs.error(message, attributes);
  }
  flush(): Promise<void> {
    return this.client.flush();
  }
}
