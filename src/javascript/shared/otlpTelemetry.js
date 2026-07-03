import { LogLevel } from "./logger";
/** Default collector endpoint — the CORS-open receiver from this repo's collector stack. */
export const DEFAULT_OTLP_ENDPOINT = "http://localhost:4318";
const DEFAULT_BOUNDS = [0, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
function nowNano() {
    return String(Date.now() * 1_000_000);
}
function randHex(bytes) {
    let s = "";
    for (let i = 0; i < bytes; i++)
        s += Math.floor(Math.random() * 256).toString(16).padStart(2, "0");
    return s;
}
function toAnyValue(v) {
    if (typeof v === "boolean")
        return { boolValue: v };
    if (typeof v === "number")
        return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
    return { stringValue: String(v) };
}
function toKeyValues(attrs) {
    return Object.entries(attrs).map(([key, value]) => ({ key, value: toAnyValue(value) }));
}
function attrsKey(attrs) {
    return JSON.stringify(Object.entries(attrs).sort((a, b) => a[0].localeCompare(b[0])));
}
function toSeverity(level) {
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
export class OtlpClient {
    ns;
    base;
    level;
    headers;
    maxBatch;
    flushIntervalMs;
    resource;
    scriptInfo;
    startTimeUnixNano = nowNano();
    bounds;
    echo;
    logBuffer = [];
    finishedSpans = [];
    openSpans = new Map();
    counters = new Map();
    upDowns = new Map();
    gauges = new Map();
    histograms = new Map();
    lastFlush = Date.now();
    logs = {
        debug: (message, attributes) => this.emitLog(message, LogLevel.DEBUG, attributes),
        info: (message, attributes) => this.emitLog(message, LogLevel.INFO, attributes),
        warn: (message, attributes) => this.emitLog(message, LogLevel.WARNING, attributes),
        error: (message, attributes) => this.emitLog(message, LogLevel.ERROR, attributes),
        log: (message, level = LogLevel.INFO) => this.emitLog(message, level),
    };
    metrics = {
        counter: (name, value = 1, attributes = {}) => this.recordSum(this.counters, name, value, attributes),
        upDownCounter: (name, value, attributes = {}) => this.recordSum(this.upDowns, name, value, attributes),
        gauge: (name, value, attributes = {}) => this.recordGauge(name, value, attributes),
        histogram: (name, value, attributes = {}) => this.recordHistogram(name, value, attributes),
    };
    traces = {
        startSpan: (name, options = {}) => this.startSpan(name, options),
        endSpan: (handle, options = {}) => this.endSpan(handle, options),
        spanEvent: (handle, name, attributes = {}) => this.spanEvent(handle, name, attributes),
        setSpanAttributes: (handle, attributes) => this.setSpanAttributes(handle, attributes),
    };
    constructor(ns, config) {
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
    emitLog(message, level, attributes) {
        if (level !== LogLevel.GLOBAL && level > this.level)
            return false;
        const [severityNumber, severityText] = toSeverity(level);
        if (this.echo)
            this.ns.print(`[${severityText}] ${message}`);
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
    recordSum(map, name, value, attributes) {
        const series = this.getSeries(map, name, attributes, () => ({ attributes: toKeyValues(attributes), value: 0 }));
        series.value += value;
        this.maybeFlush();
    }
    recordGauge(name, value, attributes) {
        const series = this.getSeries(this.gauges, name, attributes, () => ({ attributes: toKeyValues(attributes), value: 0 }));
        series.value = value;
        this.maybeFlush();
    }
    recordHistogram(name, value, attributes) {
        const series = this.getSeries(this.histograms, name, attributes, () => ({
            attributes: toKeyValues(attributes),
            count: 0,
            sum: 0,
            min: value,
            max: value,
            buckets: new Array(this.bounds.length + 1).fill(0),
        }));
        series.count += 1;
        series.sum += value;
        series.min = Math.min(series.min, value);
        series.max = Math.max(series.max, value);
        let idx = this.bounds.findIndex((b) => value <= b);
        if (idx === -1)
            idx = this.bounds.length;
        series.buckets[idx] += 1;
        this.maybeFlush();
    }
    getSeries(map, name, attributes, make) {
        let byAttrs = map.get(name);
        if (!byAttrs)
            map.set(name, (byAttrs = new Map()));
        const key = attrsKey(attributes);
        let series = byAttrs.get(key);
        if (!series)
            byAttrs.set(key, (series = make()));
        return series;
    }
    // --- traces ---
    startSpan(name, options) {
        const parent = options.parent ? this.openSpans.get(options.parent) : undefined;
        const spanId = randHex(8);
        const span = {
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
    endSpan(handle, options) {
        const span = this.openSpans.get(handle);
        if (!span)
            return;
        this.openSpans.delete(handle);
        if (options.attributes)
            span.attributes.push(...toKeyValues(options.attributes));
        this.finishedSpans.push({
            ...span,
            endTimeUnixNano: nowNano(),
            status: { code: options.error ? 2 : 0 },
        });
        this.maybeFlush();
    }
    spanEvent(handle, name, attributes) {
        this.openSpans.get(handle)?.events.push({ timeUnixNano: nowNano(), name, attributes: toKeyValues(attributes) });
    }
    setSpanAttributes(handle, attributes) {
        this.openSpans.get(handle)?.attributes.push(...toKeyValues(attributes));
    }
    // --- flushing ---
    maybeFlush() {
        if (this.logBuffer.length >= this.maxBatch ||
            this.finishedSpans.length >= this.maxBatch ||
            Date.now() - this.lastFlush >= this.flushIntervalMs) {
            void this.flush();
        }
    }
    /** Ships all buffered signals to the collector. Safe to call any time. */
    async flush() {
        this.lastFlush = Date.now();
        const jobs = [];
        if (this.logBuffer.length > 0) {
            const logRecords = this.logBuffer;
            this.logBuffer = [];
            jobs.push(this.post("/v1/logs", {
                resourceLogs: [
                    { resource: { attributes: this.resource }, scopeLogs: [{ scope: { name: "bitburner-scripts" }, logRecords }] },
                ],
            }));
        }
        const metrics = this.buildMetrics();
        if (metrics.length > 0) {
            jobs.push(this.post("/v1/metrics", {
                resourceMetrics: [
                    { resource: { attributes: this.resource }, scopeMetrics: [{ scope: { name: "bitburner-scripts" }, metrics }] },
                ],
            }));
        }
        if (this.finishedSpans.length > 0) {
            const spans = this.finishedSpans;
            this.finishedSpans = [];
            jobs.push(this.post("/v1/traces", {
                resourceSpans: [
                    { resource: { attributes: this.resource }, scopeSpans: [{ scope: { name: "bitburner-scripts" }, spans }] },
                ],
            }));
        }
        await Promise.all(jobs);
    }
    buildMetrics() {
        const now = nowNano();
        const out = [];
        const addSums = (map, isMonotonic) => {
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
    async post(path, payload) {
        try {
            await fetch(this.base + path, { method: "POST", headers: this.headers, body: JSON.stringify(payload) });
        }
        catch (error) {
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
export class OtlpLogger {
    /** The underlying full client — use it to emit traces/metrics through the same connection. */
    client;
    constructor(ns, config = {}) {
        this.client = new OtlpClient(ns, { endpoint: DEFAULT_OTLP_ENDPOINT, echoToScriptLog: true, ...config });
    }
    log(message, level = LogLevel.INFO) {
        return this.client.logs.log(message, level);
    }
    debug(message, attributes) {
        return this.client.logs.debug(message, attributes);
    }
    info(message, attributes) {
        return this.client.logs.info(message, attributes);
    }
    warn(message, attributes) {
        return this.client.logs.warn(message, attributes);
    }
    error(message, attributes) {
        return this.client.logs.error(message, attributes);
    }
    flush() {
        return this.client.flush();
    }
}
