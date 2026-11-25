// Live conditions (src/weather.ts) on NEA responses saved on 24 Nov 2026 around 10.50 pm.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const W = await import("../src/weather.ts");
const load = (n) => JSON.parse(readFileSync(new URL(`./fixtures/nea/${n}.json`, import.meta.url)));
const NOW = Date.parse("2026-11-24T22:50:00+08:00");
const MIN = 60_000;
const BISHAN = [1.3508, 103.8485], BEDOK = [1.3236, 103.9273], ORCHARD = [1.3048, 103.8318];

test("every feed gives null, not an error, for missing or malformed data", () => {
  for (const bad of [null, undefined, {}, { data: null }, { data: { records: [{}] } }, "x", 42]) {
    assert.equal(W.temperature(bad, ...BISHAN, NOW), null);
    assert.equal(W.rain(bad, ...BISHAN, NOW), null);
    assert.equal(W.heat(bad, ...BISHAN, NOW), null);
    assert.equal(W.forecast(bad, ...BISHAN, NOW), null);
    assert.equal(W.lightning(bad, ...BISHAN, NOW), null);
    assert.equal(W.uv(bad, NOW), null);
    assert.equal(W.air(bad, ...BISHAN, NOW), null);
  }
});

test("air temperature: nearest reporting station, hidden after 30 minutes", () => {
  const d = load("temperature");
  const t = W.temperature(d, ...ORCHARD, NOW);
  // check against a brute-force nearest station
  const vals = new Map(d.data.readings[0].data.map((r) => [r.stationId, r.value]));
  const best = d.data.stations.filter((s) => vals.has(s.id))
    .map((s) => [W.haversine(...ORCHARD, s.location.latitude, s.location.longitude), s]).sort((a, b) => a[0] - b[0])[0];
  assert.equal(t.station, best[1].name);
  assert.equal(t.celsius, vals.get(best[1].id));
  assert.equal(t.dist_m, Math.round(best[0]));
  assert.equal(W.temperature(d, ...ORCHARD, Date.parse(t.at) + 31 * MIN), null);
});

test("heat stress: NEA's own rating at the nearest station", () => {
  const h = W.heat(load("heat"), ...BISHAN, NOW);
  assert.equal(h.station, "Bishan Stadium");
  assert.equal(h.level, "Low");
  assert.equal(typeof h.wbgt, "number");
  assert.ok(h.dist_m < 1500, JSON.stringify(h));
  assert.equal(W.heat(load("heat"), ...BISHAN, Date.parse(h.at) + 46 * MIN), null);
  const d = load("heat");
  for (const r of d.data.records[0].item.readings) r.heatStress = "Unknown"; // only NEA's three ratings are shown
  assert.equal(W.heat(d, ...BISHAN, NOW), null);
});

test("2-hour forecast: nearest forecast area, only while valid", () => {
  assert.deepEqual(W.forecast(load("forecast"), ...BISHAN, NOW),
    { area: "Bishan", text: "Cloudy", from: "2026-11-24T22:30:00+08:00", until: "2026-11-25T00:30:00+08:00" });
  assert.equal(W.forecast(load("forecast"), ...BEDOK, NOW).text, "Light Rain");
  assert.equal(W.forecast(load("forecast"), ...BISHAN, Date.parse("2026-11-25T00:30:00+08:00")), null);
});

test("rain: shown only when the nearest gauge recorded some", () => {
  const d = load("rain");
  assert.equal(W.rain(d, ...BISHAN, NOW), null); // dry everywhere at 10.45 pm: nothing is claimed
  const vals = new Set(d.data.readings[0].data.map((r) => r.stationId));
  const near = d.data.stations.filter((s) => vals.has(s.id))
    .sort((a, b) => W.haversine(...BISHAN, a.location.latitude, a.location.longitude) - W.haversine(...BISHAN, b.location.latitude, b.location.longitude))[0];
  d.data.readings[0].data.find((r) => r.stationId === near.id).value = 0.4;
  const r = W.rain(d, ...BISHAN, NOW);
  assert.equal(r.mm, 0.4);
  assert.equal(r.station, near.name);
  assert.equal(W.rain(d, ...BISHAN, NOW + 21 * MIN), null);
});

test("lightning: only strikes within 10 km in the last 15 minutes", () => {
  const d = load("lightning");
  assert.equal(W.lightning(d, ...BISHAN, NOW), null); // tonight's strikes were ~50 km west, over the Riau islands
  const strike = (lat, lng, at, text = "Cloud to Ground") => ({ location: { latitude: String(lat), longitude: String(lng) }, type: "G", text, datetime: at });
  d.data.records[0].item.readings.push(
    strike(1.3778, 103.8485, "2026-11-24T22:45:00+08:00"),            // ~3 km north of Bishan
    strike(1.3508, 103.9100, "2026-11-24T22:46:00+08:00", "Cloud to Cloud"), // ~6.8 km east
    strike(1.3510, 103.8490, "2026-11-24T22:30:00+08:00"));           // close, but 20 minutes old
  const l = W.lightning(d, ...BISHAN, NOW);
  assert.ok(l.dist_m > 2900 && l.dist_m < 3100, JSON.stringify(l));
  assert.equal(l.kind, "Cloud to Ground");
  assert.equal(l.count, 2);
});

test("UV: the latest hour that has happened, by WHO / NEA category, not shown at night", () => {
  const d = load("uv");
  assert.equal(W.uv(d, NOW), null); // 7 pm reading is 0
  assert.deepEqual(W.uv(d, Date.parse("2026-11-24T14:20:00+08:00")), { index: 6, level: "High", at: "2026-11-24T14:00:00+08:00" });
  assert.equal(W.uv(d, Date.parse("2026-11-24T13:30:00+08:00")).index, 9);
  assert.equal(W.uv(d, Date.parse("2026-11-25T09:00:00+08:00")), null); // yesterday's reading is too old
  assert.deepEqual([0, 2, 3, 5, 6, 7, 8, 10, 11, 14].map(W.uvLevel),
    ["Low", "Low", "Moderate", "Moderate", "High", "High", "Very high", "Very high", "Extreme", "Extreme"]);
});

test("PM2.5: the region whose centre is nearest, with NEA's 1-hour bands and advice", () => {
  const d = load("air");
  assert.equal(W.air(d, ...BISHAN, NOW).region, "central");
  const a = W.air(d, ...ORCHARD, NOW); // nearer the south region's centre (1.296, 103.82) than central's (1.357, 103.82)
  assert.equal(a.region, "south");
  assert.equal(a.pm25, 15);
  assert.equal(a.band, "Normal");
  assert.equal(a.advice, null);
  for (const [v, band] of [[55, "Normal"], [56, "Elevated"], [150, "Elevated"], [151, "High"], [250, "High"], [251, "Very high"]]) {
    d.data.items[0].readings.pm25_one_hourly.south = v;
    const r = W.air(d, ...ORCHARD, NOW);
    assert.equal(r.band, band, String(v));
    assert.equal(r.advice === null, band === "Normal");
  }
  assert.equal(W.air(d, ...ORCHARD, Date.parse(a.at) + 121 * MIN), null);
});

test("feed check: quiet when every feed is healthy, names the feed that isn't", () => {
  const feeds = Object.fromEntries(["temperature", "heat", "forecast", "rain", "lightning", "uv", "air"].map((f) => [f, load(f)]));
  // the lightning fixture is from 22.46, so check at 22.50
  assert.deepEqual(W.feedProblems(feeds, NOW), []);
  assert.deepEqual(W.feedProblems({ ...feeds, air: null }, NOW), ["air: NEA could not be reached"]);
  const renamed = load("heat"); renamed.data.records[0].item.readings.forEach((r) => { r.heat_stress = r.heatStress; delete r.heatStress; });
  assert.deepEqual(W.feedProblems({ ...feeds, heat: renamed }, NOW), ["heat: no heat stress reading under 45 minutes old"]);
  // two hours later everything is stale; at night UV isn't expected
  const later = W.feedProblems(feeds, NOW + 2 * 3600_000).map((p) => p.split(":")[0]);
  assert.deepEqual(later, ["temperature", "heat", "forecast", "air", "rain", "lightning"]);
  assert.deepEqual(W.feedProblems({ ...feeds, uv: { data: { records: [{ index: [] }] } } }, Date.parse("2026-11-24T13:00:00+08:00"))
    .filter((p) => p.startsWith("uv")), ["uv: no UV reading in the last 2.5 hours of daylight"]);
});
