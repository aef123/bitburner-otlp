# bitburner-otlp

**OpenTelemetry for Bitburner — logs, metrics, and traces from plain user scripts.**

No game modifications. No `ns` API extensions. No npm dependencies in your scripts. Zero
script RAM cost. Your Bitburner scripts POST OTLP/JSON straight to an OpenTelemetry
Collector over the browser's built-in `fetch`, and a bundled docker-compose stack lands
everything in **Grafana** (Loki for logs, Prometheus for metrics, Tempo for traces) with a
ready-made dashboard.

I built this because I wanted real observability for my scripts — not `ns.print` and a
pile of tail windows — and I didn't want to mod the game or pay a RAM tax to get it.

```
Bitburner script ──OTLP/HTTP──> OTel Collector ──> Loki ──────┐
                                              ──> Prometheus ─┼──> Grafana
                                              ──> Tempo ──────┘
```

## Why this works (and costs 0 GB of RAM)

- Bitburner scripts run as ES modules in the game's browser page, so the global `fetch`
  is in scope — and Bitburner's static RAM analysis doesn't charge for it.
- The library speaks the OTLP/HTTP **JSON** wire format by hand (~450 lines, no
  `@opentelemetry/*` packages, no bundler needed), so there's nothing to install in-game.
  I looked at the official OpenTelemetry SDK first. It's a non-starter here: it wants a
  bundler, its browser builds touch APIs the game penalizes, and the whole
  auto-instrumentation ecosystem targets Node servers that don't exist in Bitburner. So I
  wrote the wire format directly.
- It never references `window` or `document`, which are the only globals Bitburner
  penalizes (25 GB each).

The one external requirement: your collector must send **CORS** headers, because the game
POSTs from a browser origin. The bundled collector config handles this.

## Quick start

### 1. Start the observability stack (needs Docker)

```bash
cd collector
docker compose up -d
```

| What | Where |
|------|-------|
| OTLP receiver (your scripts POST here) | `http://localhost:4318` |
| Grafana — pre-provisioned Bitburner dashboard, no login | `http://localhost:3000` |
| Prometheus (raw metrics, optional) | `http://localhost:9090` |

### 2. Get the library into your game

**Option A — plain JavaScript, no compiler (easiest).**
The files in [`src/javascript/`](src/javascript/) are ready to use as-is. Copy them into
your game at these paths (in-game `nano`, your usual sync tool, or `wget` from the game
terminal):

```
wget https://raw.githubusercontent.com/aef123/bitburner-otlp/main/src/javascript/shared/logger.js shared/logger.js
wget https://raw.githubusercontent.com/aef123/bitburner-otlp/main/src/javascript/shared/otlpTelemetry.js shared/otlpTelemetry.js
wget https://raw.githubusercontent.com/aef123/bitburner-otlp/main/src/javascript/shared/serverWalker.js shared/serverWalker.js
wget https://raw.githubusercontent.com/aef123/bitburner-otlp/main/src/javascript/metric-scraper.js metric-scraper.js
wget https://raw.githubusercontent.com/aef123/bitburner-otlp/main/src/javascript/otlp-example.js otlp-example.js
```

Then import from your own scripts exactly like any other in-game module:

```js
import { OtlpClient, OtlpLogger } from "shared/otlpTelemetry";
```

**Option B — TypeScript (recommended if you use an external editor).**
If you develop with the [official TypeScript template](https://github.com/bitburner-official/typescript-template)
or your own `tsc` + [bitburner-filesync](https://github.com/bitburner-official/bitburner-filesync)
pipeline, copy the sources from [`src/Typescript/`](src/Typescript/) into your project's
source tree instead (keep the `shared/` folder structure). You get full type checking and
IntelliSense against your `NetScriptDefinitions.d.ts`, and your normal build pushes the
compiled output into the game.

### 3. Send something

Run the example end-to-end test in-game:

```
run otlp-example.js
```

Then open Grafana at <http://localhost:3000> → **Bitburner** dashboard. You should see the
example's logs in the Logs panel, `cycles` / `cycle_ms` metrics, and a `hackBatch` trace.

### 4. Get game metrics without instrumenting anything

```
run metric-scraper.js
```

Leave it running on `home`. It polls the game every 10 seconds and exports player money,
income by source, skills, karma, HP, running-script count, fleet RAM, faction reputation,
and full gang stats — the dashboard lights up with no further work. Details below.

## Using the library in your own scripts

### Logs, metrics, and traces — the full client

```js
import { OtlpClient } from "shared/otlpTelemetry";

export async function main(ns) {
  const otel = new OtlpClient(ns, {
    endpoint: "http://localhost:4318",     // collector base URL
    serviceName: "my-scripts",             // becomes service.name / service_name
    resourceAttributes: { "deployment.environment": "home" },
  });

  // LOGS — structured, leveled, with attributes
  otel.logs.info("script started", { host: ns.getHostname() });
  otel.logs.error("something broke", { reason: "example" });

  // METRICS — define-on-first-use; attributes become dimensions
  otel.metrics.counter("hacks", 1, { target: "n00dles" });   // monotonic sum
  otel.metrics.gauge("money", ns.getServerMoneyAvailable("home"));
  otel.metrics.histogram("cycle_ms", 250, { target: "n00dles" });
  otel.metrics.upDownCounter("in_flight", 1);

  // TRACES — handle-based spans; pass `parent` to nest
  const batch = otel.traces.startSpan("hackBatch", { attributes: { target: "n00dles" } });
  const step = otel.traces.startSpan("weaken", { parent: batch });
  await ns.sleep(100); // ... do the work ...
  otel.traces.endSpan(step);
  otel.traces.spanEvent(batch, "milestone", { note: "halfway" });
  otel.traces.endSpan(batch, { error: false, attributes: { threads: 12 } });

  await otel.flush(); // buffers also auto-flush on size/interval and on script exit
}
```

### Drop-in logger (logs only)

`OtlpLogger` implements this repo's tiny `ILogger` interface and needs zero config — it
ships logs to `http://localhost:4318` AND echoes them to the script's own tail:

```js
import { LogLevel } from "shared/logger";
import { OtlpLogger } from "shared/otlpTelemetry";

export async function main(ns) {
  const log = new OtlpLogger(ns);           // or: new OtlpLogger(ns, { level: LogLevel.DEBUG })
  log.log("hello from Bitburner", LogLevel.INFO);

  // Need spans/metrics too? The full client is one property away:
  const otel = log.client;
  otel.metrics.counter("greetings");
}
```

### Configuration reference (`OtlpConfig`)

| Field | Default | Meaning |
|-------|---------|---------|
| `endpoint` | *(required; `OtlpLogger` defaults it to `http://localhost:4318`)* | Collector base URL — `/v1/logs`, `/v1/metrics`, `/v1/traces` are appended |
| `serviceName` | `"bitburner-scripts"` | `service.name` resource attribute |
| `level` | `LogLevel.INFO` | Minimum log level emitted (metrics/traces always emit) |
| `resourceAttributes` | `{}` | Extra resource attributes on every signal |
| `headers` | `{}` | Extra HTTP headers (e.g. auth token) |
| `maxBatch` | `64` | Flush when buffered logs/spans reach this count |
| `flushIntervalMs` | `5000` | Also flush (on the next emit) once this much time has passed — there's no background timer |
| `includeScriptInfo` | `true` | Tag logs/spans with the script's pid/filename/server/args |
| `histogramBounds` | 0…10000 (12 boundaries, 13 buckets) | Explicit histogram bucket boundaries |
| `echoToScriptLog` | `false` (`OtlpLogger`: `true`) | Also `ns.print` each log to the script's tail |

## The metric scraper

`metric-scraper.js` turns the game itself into a metrics source — one long-running script,
no instrumentation of your other code required.

```
run metric-scraper.js                              defaults: localhost:4318, every 10s
run metric-scraper.js --interval 5000
run metric-scraper.js --endpoint http://host:4318
run metric-scraper.js --logLevel 3                 tail it to watch raw income deltas
```

| Metric | Type | Labels | Notes |
|--------|------|--------|-------|
| `bitburner.player.money` | gauge | | |
| `bitburner.player.skill` | gauge | `skill` | one series per skill |
| `bitburner.player.karma` | gauge | | |
| `bitburner.player.hp.current` / `.max` | gauge | | |
| `bitburner.player.income` | counter | `source` | positive deltas of `ns.getMoneySources()`; income before scraper start isn't counted |
| `bitburner.scripts.running` | gauge | | every running script, network-wide |
| `bitburner.servers.ram_used` / `_total` | gauge | | owned servers only (home + purchased, incl. cloud servers) |
| `bitburner.faction.reputation` | gauge | `faction` | **requires Singularity (SF-4)** — skipped otherwise |
| `bitburner.gang.*` | gauge | `faction` | respect, wanted_level, wanted_penalty, territory, power, gain rates, member_count; skipped when not in a gang |
| `bitburner.gang.member.stat` | gauge | `faction`, `member`, `stat` | six stats per member |
| `bitburner.gang.member.earned_respect` | gauge | `faction`, `member` | |
| `bitburner.gang.faction_reputation` | gauge | `faction` | requires SF-4 |

Every series carries a `bitnode` label. Singularity- and gang-dependent metrics are
feature-detected and skipped cleanly when unavailable — the scraper runs fine on a fresh
BitNode 1 save.

In Prometheus/Grafana the names appear with underscores, and the counter gains a suffix:
`bitburner_player_money`, `bitburner_player_income_total`, etc.

## The Grafana dashboard

Provisioned automatically by the docker-compose stack (or import
[`collector/grafana/dashboards/bitburner-otlp.json`](collector/grafana/dashboards/bitburner-otlp.json)
by hand into any Grafana: Dashboards → New → Import).

- **Player** — money, karma, skills, and income-per-second by source. I log-scaled the
  income panel on purpose: hacking income runs orders of magnitude above everything else,
  and on a linear axis it flattens every other source to zero. I learned that one the
  hard way.
- **Fleet** — running scripts and RAM used vs. total across owned servers.
- **Factions & Gang** — reputation, gang gain rates (per 200 ms game cycle — multiply by 5
  for per-second), territory, power, member stats.
- **Logs** — everything your scripts emit, live, filterable by `service_name`.
- **Traces** — the 20 most recent traces; click through to the flame graph.

## Notes, limits, and honest caveats

This runs inside a game's browser sandbox. Some limits come with that territory, and I'd
rather you know them up front:

- **Flush on exit is best-effort.** `ns.atExit` can't await; a killed script fires its
  final flush but the browser may cancel the in-flight POST. I can't fully work around
  this. Long-running scripts flushing on an interval lose at most the final batch.
- **A downed collector doesn't lose your logs — up to a point.** Batches that fail with a
  network error are requeued and retried on the next flush, capped at 20× `maxBatch`
  (oldest dropped first) so a dead collector can't grow your script's memory forever.
  HTTP-level rejections aren't retried; a batch the collector refuses is a poison batch.
- **No automatic trace context across `await`.** There's no zone/async-hooks machinery in
  the game realm, so spans don't auto-parent — pass the `parent` handle explicitly. And
  don't start a child after its parent has ended; the child becomes a new root trace (the
  library warns in the tail when this happens).
- **Counters reset when their script restarts.** Cumulative sums are per-client-instance.
  Keep counters in long-lived scripts (like the scraper); Prometheus `rate()` handles
  occasional resets gracefully anyway.
- **Watch attribute cardinality.** Each unique attribute combination is a retained series
  in script memory until exit. Tags like `target` are fine; don't tag with timestamps.
- **CORS is mandatory.** If the browser devtools console shows a CORS error, your
  collector isn't sending the headers — use the bundled config, or add
  `cors: allowed_origins: ["*"]` to your own collector's OTLP HTTP receiver.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Nothing arrives at all | Is the stack up? `docker compose ps` in `collector/`. Is the endpoint right? Default is `http://localhost:4318`. |
| Browser console shows a CORS error | Collector config is missing the CORS block — use the bundled `otel-collector-config.yaml`. |
| `OTLP /v1/... flush failed` in a script's tail | Collector unreachable — wrong port or Docker not running. |
| Metrics in Prometheus but dashboard panels empty | Check the panel time range, and that the scraper has run long enough for `rate()` windows (give it a minute). |
| Small income sources look like zero | They're being drowned by a big source on a linear axis. The bundled panel is log-scale; keep it that way. |
| Logs missing below INFO | Raise the client's `level` (e.g. `new OtlpLogger(ns, { level: LogLevel.DEBUG })`). |

## Repository layout

```
src/Typescript/          TypeScript sources — copy into your TS project
  shared/otlpTelemetry.ts    the library (OtlpClient, OtlpLogger)
  shared/logger.ts           ILogger / LogLevel interfaces + plain in-game Logger
  shared/serverWalker.ts     network-walk helpers (used by the scraper)
  metric-scraper.ts          turnkey game-metrics exporter
  otlp-example.ts            end-to-end smoke test (logs + metrics + traces)
src/javascript/          Compiled, game-ready JS — copy into the game and use as-is
collector/               docker-compose observability stack
  docker-compose.yml         collector + Loki + Prometheus + Tempo + Grafana
  otel-collector-config.yaml CORS-open OTLP receiver, fan-out to the three backends
  prometheus.yml             scrapes the collector's :8889 metrics endpoint
  tempo.yaml                 minimal single-binary Tempo (local storage, 30d retention)
  grafana/                   auto-provisioned datasources + Bitburner dashboard
```

### Building the TypeScript yourself

```bash
npm install
npm run defs    # fetch NetScriptDefinitions.d.ts (stable; use defs:dev for the dev branch)
npm run build   # tsc: src/Typescript -> src/javascript
```
