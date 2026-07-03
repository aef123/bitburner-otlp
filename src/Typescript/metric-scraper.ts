import { NS } from "../../NetScriptDefinitions";
import { ILogger, LogLevel } from "shared/logger";
import { Attributes, DEFAULT_OTLP_ENDPOINT, OtlpClient, OtlpLogger } from "shared/otlpTelemetry";
import { listServers } from "shared/serverWalker";

/**
 * Turnkey game-metrics exporter. Run it on home, leave it running, and get a live
 * OpenTelemetry picture of your game: it polls the ns API on an interval and emits
 * metrics (service.name "bitburner") through the pure user-space OtlpClient — no
 * game modifications, no per-script instrumentation needed.
 *
 * Metrics emitted:
 *   bitburner.player.money            gauge
 *   bitburner.player.skill            gauge, per {skill}
 *   bitburner.player.karma            gauge
 *   bitburner.player.hp.current/.max  gauges
 *   bitburner.scripts.running         gauge (all running scripts, network-wide)
 *   bitburner.servers.ram_used/_total gauges (owned servers: home + purchased + cloud)
 *   bitburner.player.income           counter, per {source} (from ns.getMoneySources deltas)
 *   bitburner.faction.reputation      gauge, per {faction}   — REQUIRES Singularity (SF-4)
 *   bitburner.gang.*                  gauges (respect, wanted_level, wanted_penalty,
 *                                     territory, power, *_gain_rate, member_count)
 *   bitburner.gang.member.stat        gauge, per {member, stat}
 *   bitburner.gang.member.earned_respect  gauge, per {member}
 *   bitburner.gang.faction_reputation gauge — REQUIRES Singularity (SF-4)
 *
 * Singularity-gated metrics are feature-detected once at startup and skipped (with a log)
 * when SF-4 isn't available. Gang metrics are skipped when you're not in a gang. Every
 * series carries a {bitnode} attribute.
 *
 * The income counter works by diffing ns.getMoneySources().sinceInstall each pass and
 * counting POSITIVE deltas per source (negative deltas are expenses, not income, and are
 * skipped). Income earned before the scraper starts is not counted.
 *
 *   run metric-scraper.js
 *   run metric-scraper.js --interval 5000
 *   run metric-scraper.js --endpoint http://localhost:4318
 */

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  const flags = ns.flags([
    ["endpoint", DEFAULT_OTLP_ENDPOINT], // OTLP collector base URL (CORS-open receiver)
    ["interval", 10000], // ms between scrapes
    ["logLevel", LogLevel.INFO],
  ]);
  const endpoint = flags.endpoint as string;
  const interval = flags.interval as number;

  const log: ILogger = new OtlpLogger(ns, { endpoint, level: flags.logLevel as number });

  // All game metrics share one service.name so dashboards can key off it.
  const otel = new OtlpClient(ns, {
    endpoint,
    serviceName: "bitburner",
    flushIntervalMs: interval,
  });

  // Every series is tagged with the current BitNode.
  const base: Attributes = { bitnode: ns.getResetInfo().currentNode };

  // Feature-detect Singularity (SF-4) once: faction reputation needs it. The ns.singularity
  // object always exists, but its functions throw without SF-4.
  let hasSingularity = false;
  try {
    ns.singularity.getCurrentServer();
    hasSingularity = true;
  } catch {
    log.log("Singularity (SF-4) unavailable — skipping faction/gang reputation metrics.", LogLevel.INFO);
  }

  // Baseline for the income counter: first pass records current totals without emitting,
  // so we only count income earned while the scraper is running.
  let prevIncome = readIncome(ns);

  log.log(`metric-scraper started — ${endpoint}, every ${ns.format.time(interval)}.`, LogLevel.INFO);

  while (true) {
    try {
      scrapePlayer(ns, otel, base);
      scrapeServers(ns, otel, base);
      prevIncome = scrapeIncome(ns, otel, base, prevIncome, log);
      if (hasSingularity) scrapeFactionRep(ns, otel, base);
      scrapeGang(ns, otel, base, hasSingularity);
    } catch (err) {
      log.log(`scrape pass failed: ${String(err)}`, LogLevel.ERROR);
    }
    await otel.flush();
    await ns.sleep(interval);
  }
}

/** Player money, per-skill levels, karma, and HP. */
function scrapePlayer(ns: NS, otel: OtlpClient, base: Attributes): void {
  const player = ns.getPlayer();
  otel.metrics.gauge("bitburner.player.money", player.money, base);
  for (const [skill, value] of Object.entries(player.skills)) {
    otel.metrics.gauge("bitburner.player.skill", value, { ...base, skill });
  }
  otel.metrics.gauge("bitburner.player.karma", player.karma, base);
  otel.metrics.gauge("bitburner.player.hp.current", player.hp.current, base);
  otel.metrics.gauge("bitburner.player.hp.max", player.hp.max, base);
}

/**
 * Network-wide running-script count (every running script on every reachable server),
 * plus RAM used/total across OWNED servers only (home + purchased + cloud).
 */
function scrapeServers(ns: NS, otel: OtlpClient, base: Attributes): void {
  // All reachable servers, plus purchased cloud servers that may not be in the scan.
  const all = new Set<string>(listServers(ns));
  try {
    for (const host of ns.cloud.getServerNames()) all.add(host);
  } catch {
    /* cloud API unavailable in this build — fine */
  }

  let running = 0;
  let ramUsed = 0;
  let ramTotal = 0;
  for (const host of all) {
    running += ns.ps(host).length;
    // Owned = home or purchased (purchasedByPlayer covers cloud servers too).
    if (host === "home" || ns.getServer(host).purchasedByPlayer) {
      ramUsed += ns.getServerUsedRam(host);
      ramTotal += ns.getServerMaxRam(host);
    }
  }
  otel.metrics.gauge("bitburner.scripts.running", running, base);
  otel.metrics.gauge("bitburner.servers.ram_used", ramUsed, base);
  otel.metrics.gauge("bitburner.servers.ram_total", ramTotal, base);
}

/** Cumulative money per source since the last augmentation install (skips "total"). */
function readIncome(ns: NS): Map<string, number> {
  const out = new Map<string, number>();
  for (const [source, amount] of Object.entries(ns.getMoneySources().sinceInstall)) {
    if (source !== "total") out.set(source, amount);
  }
  return out;
}

/**
 * Emit bitburner.player.income{source} counter increments: the positive delta of each
 * money source since the previous pass. Negative deltas (spending) are skipped — this
 * counter tracked income, not net worth. Returns the new baseline.
 */
function scrapeIncome(
  ns: NS,
  otel: OtlpClient,
  base: Attributes,
  prev: Map<string, number>,
  log: ILogger,
): Map<string, number> {
  const cur = readIncome(ns);
  const emitted: string[] = [];
  for (const [source, amount] of cur) {
    const delta = amount - (prev.get(source) ?? 0);
    if (delta > 0) {
      otel.metrics.counter("bitburner.player.income", delta, { ...base, source });
      emitted.push(`${source} +$${ns.format.number(delta)}`);
    }
  }
  // Run `metric-scraper.js --logLevel 3` and tail it to watch the raw per-source deltas.
  if (emitted.length > 0) log.log(`income: ${emitted.join(", ")}`, LogLevel.VERBOSE);
  return cur;
}

/** Reputation with every joined faction. Caller guards on Singularity availability. */
function scrapeFactionRep(ns: NS, otel: OtlpClient, base: Attributes): void {
  for (const faction of ns.getPlayer().factions) {
    otel.metrics.gauge("bitburner.faction.reputation", ns.singularity.getFactionRep(faction), { ...base, faction });
  }
}

/** Per-member stat fields, mapped to the same names the player-skill metric uses. */
const GANG_MEMBER_STATS = [
  ["hacking", "hack"],
  ["strength", "str"],
  ["defense", "def"],
  ["dexterity", "dex"],
  ["agility", "agi"],
  ["charisma", "cha"],
] as const;

/**
 * Gang gauges + per-member stats, all tagged {faction}. Emits
 * nothing when you're not in a gang (or the gang API is unavailable pre-SF2 — inGang is
 * wrapped so a throwing API just skips). gang.faction_reputation additionally needs
 * Singularity, so it's gated on `hasSingularity`.
 */
function scrapeGang(ns: NS, otel: OtlpClient, base: Attributes, hasSingularity: boolean): void {
  let inGang = false;
  try {
    inGang = ns.gang.inGang();
  } catch {
    return; // gang API unavailable in this node/save
  }
  if (!inGang) return;

  const gang = ns.gang.getGangInformation();
  const attrs: Attributes = { ...base, faction: gang.faction };

  otel.metrics.gauge("bitburner.gang.respect", gang.respect, attrs);
  otel.metrics.gauge("bitburner.gang.wanted_level", gang.wantedLevel, attrs);
  otel.metrics.gauge("bitburner.gang.wanted_penalty", gang.wantedPenalty, attrs);
  otel.metrics.gauge("bitburner.gang.territory", gang.territory, attrs);
  otel.metrics.gauge("bitburner.gang.power", gang.power, attrs);
  otel.metrics.gauge("bitburner.gang.respect_gain_rate", gang.respectGainRate, attrs);
  otel.metrics.gauge("bitburner.gang.wanted_gain_rate", gang.wantedLevelGainRate, attrs);
  otel.metrics.gauge("bitburner.gang.money_gain_rate", gang.moneyGainRate, attrs);

  const members = ns.gang.getMemberNames();
  otel.metrics.gauge("bitburner.gang.member_count", members.length, attrs);

  if (hasSingularity) {
    otel.metrics.gauge("bitburner.gang.faction_reputation", ns.singularity.getFactionRep(gang.faction), attrs);
  }

  // Per-member stats (bounded cardinality: member count is small, stats are fixed).
  for (const name of members) {
    const info = ns.gang.getMemberInformation(name);
    for (const [stat, field] of GANG_MEMBER_STATS) {
      otel.metrics.gauge("bitburner.gang.member.stat", info[field], { ...attrs, member: name, stat });
    }
    otel.metrics.gauge("bitburner.gang.member.earned_respect", info.earnedRespect, { ...attrs, member: name });
  }
}
