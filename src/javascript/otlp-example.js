import { LogLevel } from "shared/logger";
import { OtlpClient } from "shared/otlpTelemetry";
/**
 * Example: pure user-space OpenTelemetry (logs + metrics + traces) with no game
 * (ns.telemetry) dependency. OtlpClient formats OTLP/JSON and POSTs it straight to your
 * collector via `fetch`. Point it at the CORS-open OTLP receiver from collector/
 * (http://localhost:4318), which forwards to Loki / Prometheus / Tempo.
 *
 *   run otlp-example.js                         // uses http://localhost:4318
 *   run otlp-example.js http://localhost:4318   // explicit endpoint
 *
 * RAM note: uses the global `fetch` (no RAM cost). It never references `window`/`document`
 * (which would cost 25 GB each).
 */
export async function main(ns) {
    const endpoint = ns.args[0] ?? "http://localhost:4318";
    const otel = new OtlpClient(ns, {
        endpoint,
        serviceName: "my-scripts", // service_name in Grafana
        level: LogLevel.DEBUG,
        resourceAttributes: { "deployment.environment": "home" },
        // maxBatch: 64, flushIntervalMs: 5000, headers: { Authorization: "Bearer <token>" },
    });
    ns.disableLog("ALL");
    ns.print(`Sending OTLP to ${endpoint} (v1/logs, v1/metrics, v1/traces)`);
    // ---- LOGS (client.logs.*) — structured, with attributes ----
    otel.logs.info("script started", { host: ns.getHostname() });
    otel.logs.debug("config loaded", { batch: 64 });
    // ---- TRACES (client.traces.*) — handle-based; each startSpan is its own root trace ----
    const batch = otel.traces.startSpan("hackBatch", { attributes: { target: "n00dles" } });
    for (let i = 0; i < 5; i++) {
        // A child span nested under the batch (pass the parent handle).
        const cycle = otel.traces.startSpan("cycle", { parent: batch, attributes: { i } });
        const start = Date.now();
        await ns.sleep(200);
        const elapsed = Date.now() - start;
        // ---- METRICS (client.metrics.*) — define-on-first-use, attributes = dimensions ----
        otel.metrics.counter("cycles", 1, { target: "n00dles" });
        otel.metrics.histogram("cycle_ms", elapsed, { target: "n00dles" });
        otel.metrics.gauge("home_money", ns.getServerMoneyAvailable("home"));
        otel.metrics.upDownCounter("in_flight", 1);
        otel.traces.spanEvent(cycle, "slept", { ms: elapsed });
        otel.traces.endSpan(cycle);
        otel.metrics.upDownCounter("in_flight", -1);
        otel.logs.info("cycle done", { i, elapsed });
    }
    // Error + span error status.
    try {
        throw new Error("example failure");
    }
    catch (err) {
        otel.logs.error("caught an error", { reason: String(err) });
        otel.traces.setSpanAttributes(batch, { failed: true });
        otel.traces.endSpan(batch, { error: true });
    }
    // Flush everything before exit. (OtlpClient also registers an ns.atExit flush.)
    await otel.flush();
    ns.print('flushed — check Grafana: logs {service_name="my-scripts"}, metrics my_scripts_* / cycles, traces service.name=my-scripts');
}
