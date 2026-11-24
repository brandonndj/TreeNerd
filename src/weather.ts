/**
 * Live conditions near a point, from NEA's real-time feeds on data.gov.sg. Pure functions: each takes
 * a feed's parsed JSON, the point and the current time, and returns what to show or null. A reading
 * is null when it is missing, malformed or older than its limit below, so nothing old is ever
 * presented as current. tests/weather.test.mjs runs them on saved NEA responses.
 */

export const FEEDS = {
  temperature: "https://api-open.data.gov.sg/v2/real-time/api/air-temperature",
  heat: "https://api-open.data.gov.sg/v2/real-time/api/weather?api=wbgt",
  forecast: "https://api-open.data.gov.sg/v2/real-time/api/two-hr-forecast",
  rain: "https://api-open.data.gov.sg/v2/real-time/api/rainfall",
  lightning: "https://api-open.data.gov.sg/v2/real-time/api/weather?api=lightning",
  uv: "https://api-open.data.gov.sg/v2/real-time/api/uv",
  air: "https://api-open.data.gov.sg/v2/real-time/api/pm25",
} as const;
export type Feed = keyof typeof FEEDS;

const MIN = 60_000;
/** How old a reading may be and still be shown. Each feed's normal publishing interval, with slack. */
export const MAX_AGE = {
  temperature: 30 * MIN, // every minute
  heat: 45 * MIN, // every 15 minutes
  rain: 20 * MIN, // every 5 minutes
  lightning: 15 * MIN, // each strike's own time
  uv: 150 * MIN, // hourly, published up to about 90 minutes after the hour
  air: 120 * MIN, // hourly, published about 45 minutes after the hour
};
/** Lightning is mentioned only when a strike is this close. Our choice, not an NEA threshold: shown as the distance itself. */
export const LIGHTNING_KM = 10;

export function haversine(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371000, r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lng2 - lng1) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

type Json = any; // NEA's responses, checked field by field below
const num = (v: unknown) => (v === null || v === undefined || v === "" ? NaN : Number(v));
const fresh = (at: string | undefined, now: number, max: number) => {
  const t = Date.parse(at ?? "");
  return Number.isFinite(t) && now - t <= max && t - now <= 10 * MIN; // tolerate a little clock skew, nothing from the future
};
function nearest<T>(items: T[], lat: number, lng: number, pos: (t: T) => [number, number] | null) {
  let best: { item: T; dist_m: number } | null = null;
  for (const item of items) {
    const p = pos(item);
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const d = haversine(lat, lng, p[0], p[1]);
    if (!best || d < best.dist_m) best = { item, dist_m: d };
  }
  return best && { item: best.item, dist_m: Math.round(best.dist_m) };
}

/** Station feeds (air temperature, rainfall): the latest value at the nearest station that reported one. */
function stationReading(d: Json, lat: number, lng: number, now: number, max: number) {
  const latest = d?.data?.readings?.[0];
  if (!fresh(latest?.timestamp, now, max)) return null;
  const values = new Map<string, number>();
  for (const r of latest.data ?? []) if (Number.isFinite(num(r?.value))) values.set(r.stationId, num(r.value));
  const near = nearest((d.data.stations ?? []).filter((s: Json) => values.has(s?.id)), lat, lng,
    (s: Json) => s.location ? [num(s.location.latitude), num(s.location.longitude)] : null);
  if (!near) return null;
  return { value: values.get(near.item.id)!, station: String(near.item.name), dist_m: near.dist_m, at: String(latest.timestamp) };
}

export function temperature(d: Json, lat: number, lng: number, now: number) {
  const r = stationReading(d, lat, lng, now, MAX_AGE.temperature);
  return r && { celsius: r.value, station: r.station, dist_m: r.dist_m, at: r.at };
}

/** Rain in the last 5 minutes at the nearest rain gauge; null when it recorded none (we don't claim "dry"). */
export function rain(d: Json, lat: number, lng: number, now: number) {
  const r = stationReading(d, lat, lng, now, MAX_AGE.rain);
  return r && r.value > 0 ? { mm: r.value, station: r.station, dist_m: r.dist_m, at: r.at } : null;
}

/** Heat stress (wet-bulb globe temperature) at the nearest station, with NEA's own rating. */
export function heat(d: Json, lat: number, lng: number, now: number) {
  const rec = d?.data?.records?.[0];
  if (!fresh(rec?.datetime, now, MAX_AGE.heat)) return null;
  const ok = (rec.item?.readings ?? []).filter((r: Json) => Number.isFinite(num(r?.wbgt)) && ["Low", "Moderate", "High"].includes(r?.heatStress));
  const near = nearest(ok, lat, lng, (r: Json) => r.location ? [num(r.location.latitude), num(r.location.longitude)] : null);
  if (!near) return null;
  const r = near.item as Json;
  return { level: String(r.heatStress), wbgt: num(r.wbgt), station: String(r.station?.townCenter || r.station?.name || ""), dist_m: near.dist_m, at: String(rec.datetime) };
}

/** NEA's 2-hour forecast for the forecast area whose centre is nearest, while it is still valid. */
export function forecast(d: Json, lat: number, lng: number, now: number) {
  const item = d?.data?.items?.[0];
  const start = Date.parse(item?.valid_period?.start ?? ""), end = Date.parse(item?.valid_period?.end ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end) || now >= end || start - now > 30 * MIN) return null;
  const text = new Map<string, string>();
  for (const f of item.forecasts ?? []) if (f?.area && f?.forecast) text.set(f.area, String(f.forecast));
  const near = nearest((d.data.area_metadata ?? []).filter((a: Json) => text.has(a?.name)), lat, lng,
    (a: Json) => a.label_location ? [num(a.label_location.latitude), num(a.label_location.longitude)] : null);
  if (!near) return null;
  return { area: String(near.item.name), text: text.get(near.item.name)!, from: String(item.valid_period.start), until: String(item.valid_period.end) };
}

/** The nearest lightning strike within LIGHTNING_KM in the last 15 minutes, and how many there were. */
export function lightning(d: Json, lat: number, lng: number, now: number) {
  const strikes = (d?.data?.records ?? []).flatMap((rec: Json) => rec?.item?.readings ?? [])
    .filter((s: Json) => fresh(s?.datetime, now, MAX_AGE.lightning))
    .map((s: Json) => ({ s, dist_m: haversine(lat, lng, num(s.location?.latitude), num(s.location?.longitude)) }))
    .filter((x: { dist_m: number }) => Number.isFinite(x.dist_m) && x.dist_m <= LIGHTNING_KM * 1000);
  if (!strikes.length) return null;
  strikes.sort((a: { dist_m: number }, b: { dist_m: number }) => a.dist_m - b.dist_m);
  const n = strikes[0];
  return { dist_m: Math.round(n.dist_m), at: String(n.s.datetime), kind: String(n.s.text || ""), count: strikes.length };
}

/** WHO / NEA exposure categories of the UV index. */
export const uvLevel = (i: number) => (i >= 11 ? "Extreme" : i >= 8 ? "Very high" : i >= 6 ? "High" : i >= 3 ? "Moderate" : "Low");
/** The latest hourly UV index (measured at Changi, one reading for Singapore). Not shown at night (0). */
export function uv(d: Json, now: number) {
  const hours = (d?.data?.records?.[0]?.index ?? [])
    .filter((h: Json) => Number.isFinite(num(h?.value)) && Date.parse(h?.hour) <= now + 10 * MIN);
  hours.sort((a: Json, b: Json) => Date.parse(b.hour) - Date.parse(a.hour));
  const h = hours[0];
  if (!h || !fresh(h.hour, now, MAX_AGE.uv) || num(h.value) <= 0) return null;
  return { index: num(h.value), level: uvLevel(num(h.value)), at: String(h.hour) };
}

/** NEA's 1-hour PM2.5 bands (µg/m³) and their advice, as published on haze.gov.sg. */
export const PM25_BANDS = [
  { max: 55, band: "Normal", advice: null },
  { max: 150, band: "Elevated", advice: "Healthy people: reduce strenuous outdoor activities for the next hour. Vulnerable people: avoid them." },
  { max: 250, band: "High", advice: "Healthy people: avoid strenuous outdoor activities for the next hour. Vulnerable people: avoid all outdoor activities; a mask may help." },
  { max: Infinity, band: "Very high", advice: "Healthy people: minimise all outdoor activities for the next hour. Vulnerable people: avoid them. A mask may help." },
];
/** 1-hour PM2.5 for the NEA region (north, south, east, west, central) whose centre is nearest. NEA doesn't
 * publish the regions' boundaries in this feed, so the page names the region rather than say it's "here". */
export function air(d: Json, lat: number, lng: number, now: number) {
  const item = d?.data?.items?.[0], values = item?.readings?.pm25_one_hourly ?? {};
  if (!fresh(item?.timestamp, now, MAX_AGE.air)) return null;
  const near = nearest((d.data.regionMetadata ?? []).filter((r: Json) => Number.isFinite(num(values[r?.name]))), lat, lng,
    (r: Json) => r.labelLocation ? [num(r.labelLocation.latitude), num(r.labelLocation.longitude)] : null);
  if (!near) return null;
  const pm25 = num(values[near.item.name]), b = PM25_BANDS.find((x) => Math.round(pm25) <= x.max)!;
  return { pm25, band: b.band, advice: b.advice, region: String(near.item.name), at: String(item.timestamp) };
}
