/**
 * TreeNerd Worker
 *  - serves the static front end (public/) via Workers Static Assets
 *  - /data/*  -> R2 objects (PMTiles with HTTP Range, search/species/meta JSON, CSV export)
 *  - /api/*   -> D1 queries + in-memory search index, rate-limited and edge-cached per data build
 *  - cron     -> checks the upstream source for new data and requests a rebuild
 */
import { cleanQuery, parseOnemap, type OnemapHit } from "./geocode";
import { PAGE_HEADERS, pageMeta, sitemap, withMeta } from "./pages";
import { serveTiles } from "./tiles";
import { SearchIndex, type Entry } from "./search";

export interface Env {
  DB: D1Database; // the live database, chosen per request from DB_A / DB_B (see activeDb)
  DB_A: D1Database;
  DB_B: D1Database;
  DATA: R2Bucket;
  ASSETS: Fetcher;
  API_LIMIT?: RateLimit;
  GITHUB_REPO: string;
  GITHUB_WORKFLOW: string;
  GITHUB_REF: string;
  ARCGIS_TREES_LAYER: string;
  GITHUB_TOKEN?: string;
  ONEMAP_EMAIL?: string; // optional secrets: OneMap account used for address search
  ONEMAP_PASSWORD?: string;
}

const PLACE_COLUMN: Record<string, string> = {
  road: "road_id", park: "park_id", subzone: "subzone_id", planning_area: "pa_id",
  pcn: "pcn_id", constituency: "ed_id", heritage_road: "hr_id",
};
const R2_PUBLIC = new Set(["trees.pmtiles", "search.json", "species.json", "meta.json", "trees.csv.gz"]);
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,119}$/;
const ID_RE = /^\d{1,12}$/;

// Query parameters each endpoint accepts. Anything else is dropped, so it can't
// fragment the edge cache or reach the handlers.
const ALLOWED_PARAMS: Record<string, string[]> = {
  search: ["q", "kind", "limit"],
  near: ["lat", "lng", "r", "limit"],
  place: ["species", "sort", "limit", "offset"],
  geocode: ["q"],
  top: ["kind", "by"],
};

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "cross-origin-resource-policy": "same-origin",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
};

// ---------------------------------------------------------------- isolate cache
let searchIndex: { version: string; index: SearchIndex } | null = null;
let buildMeta: { at: number; db: D1Database | null; value: Record<string, unknown> | null } = { at: 0, db: null, value: null };
let active: { at: number; which: "a" | "b" } = { at: 0, which: "a" };

/**
 * Blue/green databases: the data pipeline loads whichever database is idle, verifies it, then
 * writes its name to the R2 object "active-db". Visitors never query a database mid-load.
 */
async function activeDb(env: Env): Promise<D1Database> {
  if (Date.now() - active.at > 30_000) {
    try {
      const obj = await env.DATA.get("active-db");
      const which = obj ? (await obj.text()).trim() : "a";
      active = { at: Date.now(), which: which === "b" ? "b" : "a" };
    } catch {
      active = { ...active, at: Date.now() }; // keep the last known database
    }
  }
  return active.which === "b" ? env.DB_B : env.DB_A;
}

async function getMeta(env: Env) {
  if (buildMeta.db === env.DB && Date.now() - buildMeta.at < 60_000) return buildMeta.value;
  try {
    const row = await env.DB.prepare("SELECT value FROM meta WHERE key='build'").first<{ value: string }>();
    buildMeta = { at: Date.now(), db: env.DB, value: row ? JSON.parse(row.value) : null };
  } catch {
    buildMeta = { at: Date.now(), db: env.DB, value: null }; // database not loaded yet
  }
  return buildMeta.value;
}

async function version(env: Env) {
  return String((await getMeta(env))?.built_at ?? "none");
}

async function getSearch(env: Env) {
  const v = await version(env);
  if (searchIndex?.version === v) return searchIndex.index;
  const obj = await env.DATA.get("search.json");
  if (!obj) throw new HttpError(503, "search is not available yet");
  searchIndex = { version: v, index: new SearchIndex(await obj.json<Entry[]>()) };
  return searchIndex.index;
}

// ---------------------------------------------------------------- helpers
type Row = Record<string, unknown>;

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function withSecurityHeaders(res: Response) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!out.headers.has(k)) out.headers.set(k, v);
  return out;
}

/** Preview hosts (dev.*) must never be indexed. */
const isPreview = (url: URL) => url.hostname.startsWith("dev.");
function noIndex(res: Response) {
  const out = new Response(res.body, res);
  out.headers.set("x-robots-tag", "noindex, nofollow");
  return out;
}

const json = (data: unknown, status = 200, maxAge = 3600) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": status === 200 ? `public, max-age=${maxAge}, stale-while-revalidate=86400` : "no-store",
    },
  });

const parseJSON = <T>(s: unknown, fallback: T): T => {
  if (typeof s !== "string") return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
};

function intParam(url: URL, name: string, def: number, min: number, max: number) {
  const v = Number(url.searchParams.get(name) ?? def);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, Math.trunc(v))) : def;
}

function cellOf(lat: number, lng: number) {
  return Math.trunc((lat - 1.1) * 500) * 1000 + Math.trunc((lng - 103.5) * 500);
}

function haversine(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371000, r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lng2 - lng1) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Neutralise spreadsheet formula injection in CSV cells. */
function csvCell(v: unknown) {
  if (v == null) return "";
  let s = String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function speciesNames(env: Env, ids: number[]) {
  if (!ids.length) return new Map<number, Row>();
  const { results } = await env.DB.prepare(
    `SELECT id, common, scientific, family, native FROM species WHERE id IN (${ids.map(() => "?").join(",")})`,
  ).bind(...ids).all<Row>();
  return new Map(results.map((r) => [r.id as number, r]));
}

async function getPlace(env: Env, kind: string, slug: string) {
  const col = PLACE_COLUMN[kind];
  if (!col || !SLUG_RE.test(slug)) throw new HttpError(404, "not found");
  const place = await env.DB.prepare("SELECT * FROM places WHERE kind=? AND slug=?").bind(kind, slug).first();
  if (!place) throw new HttpError(404, "not found");
  return { place, col };
}

// ---------------------------------------------------------------- API routes
async function apiSearch(url: URL, env: Env) {
  const q = (url.searchParams.get("q") ?? "").slice(0, 100);
  const kinds = url.searchParams.get("kind")?.split(",").filter((k) => k in PLACE_COLUMN || k === "species").slice(0, 8);
  const idx = await getSearch(env);
  return json({ q, results: idx.search(q, { kinds: kinds?.length ? kinds : undefined, limit: intParam(url, "limit", 12, 1, 50) }) });
}

async function apiPlace(env: Env, kind: string, slug: string) {
  const { place, col } = await getPlace(env, kind, slug);
  const [cats, sizes, heights, natives] = await env.DB.batch([
    env.DB.prepare(`SELECT category k, count(*) n FROM trees WHERE ${col}=? GROUP BY 1 ORDER BY 2 DESC`).bind(place.id),
    env.DB.prepare(`SELECT size k, count(*) n FROM trees WHERE ${col}=? GROUP BY 1`).bind(place.id),
    env.DB.prepare(`SELECT height_band k, count(*) n FROM trees WHERE ${col}=? GROUP BY 1`).bind(place.id),
    env.DB.prepare(
      `SELECT s.native k, count(*) n FROM trees t LEFT JOIN species s ON s.id=t.species_id WHERE t.${col}=? GROUP BY 1`,
    ).bind(place.id),
  ]);
  const top = parseJSON<[number, number][]>(place.top_species, []);
  const names = await speciesNames(env, top.map(([id]) => id));
  // which place ids are in the tiles depends on the data build (older builds have fewer)
  const tileKeys = ((await getMeta(env))?.tile_keys ?? { road: "r", park: "p", planning_area: "a" }) as Record<string, string>;
  return json({
    kind, slug, name: place.name, alt: parseJSON(place.alt, []),
    tree_count: place.tree_count, species_count: place.species_count,
    heritage_count: place.heritage_count, carbon_kg: place.carbon_kg,
    bbox: parseJSON(place.bbox, null), extra: parseJSON(place.extra, {}),
    tile_key: tileKeys[kind] ?? null,
    place_id: place.id,
    top_species: top.map(([id, n]) => ({ id, n, ...(names.get(id) ?? {}) })),
    categories: cats.results, sizes: sizes.results, heights: heights.results, native: natives.results,
  });
}

async function apiPlaceTrees(url: URL, env: Env, kind: string, slug: string, format: "json" | "csv" | "ids") {
  const { place, col } = await getPlace(env, kind, slug);
  const species = url.searchParams.get("species");
  if (species && !ID_RE.test(species)) throw new HttpError(400, "invalid species");
  const where = `t.${col}=?` + (species ? " AND t.species_id=?" : "");
  const binds: unknown[] = [place.id, ...(species ? [Number(species)] : [])];

  if (format === "ids") {
    const rows = await env.DB.prepare(`SELECT t.id FROM trees t WHERE ${where} LIMIT 60000`)
      .bind(...binds).raw<[number]>();
    return json({ ids: rows.map((r) => r[0]) });
  }
  // Column names come from this fixed map only, never from user input.
  const SORTS: Record<string, string> = {
    girth: "t.girth_m DESC NULLS LAST", age: "t.age DESC NULLS LAST",
    height: "t.height_m DESC NULLS LAST", species: "s.common COLLATE NOCASE, t.id",
  };
  const sort = SORTS[url.searchParams.get("sort") ?? "girth"] ?? SORTS.girth;
  const limit = format === "csv" ? 100000 : intParam(url, "limit", 50, 1, 500);
  const offset = format === "csv" ? 0 : intParam(url, "offset", 0, 0, 1e6);
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.lng, t.lat, t.species_id, s.common, s.scientific, s.family, t.girth_m, t.height_band,
            t.age, t.category, t.carbon_kg, t.ht_no
       FROM trees t LEFT JOIN species s ON s.id=t.species_id
      WHERE ${where} ORDER BY ${sort} LIMIT ? OFFSET ?`,
  ).bind(...binds, limit, offset).all<Row>();

  if (format === "csv") {
    const cols = ["id", "lat", "lng", "common", "scientific", "family", "girth_m", "height_band", "age",
      "category", "carbon_kg", "ht_no"];
    const body = [cols.join(","), ...results.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n");
    return new Response(body, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="treenerd-${kind}-${slug}.csv"`,
        "cache-control": "public, max-age=3600",
      },
    });
  }
  return json({ total: place.tree_count, offset, limit, trees: results });
}

async function apiTree(env: Env, id: number) {
  const t = await env.DB.prepare("SELECT * FROM trees WHERE id=?").bind(id).first();
  if (!t) throw new HttpError(404, "not found");
  const placeIds = ["road_id", "park_id", "subzone_id", "pa_id", "pcn_id", "ed_id", "hr_id"]
    .map((k) => t[k]).filter((v): v is number => typeof v === "number");
  const [sp, pl] = await env.DB.batch<Row>([
    env.DB.prepare("SELECT * FROM species WHERE id=?").bind(t.species_id ?? -1),
    env.DB.prepare(`SELECT id, kind, slug, name FROM places WHERE id IN (${placeIds.map(() => "?").join(",") || "NULL"})`)
      .bind(...placeIds),
  ]);
  const species = sp.results[0] ?? null;
  if (species) species.aliases = parseJSON(species.aliases, []);
  const places = Object.fromEntries(pl.results.map((p) => [p.kind, { slug: p.slug, name: p.name }]));
  return json({ ...t, species, places }, 200, 21600);
}

async function apiNear(url: URL, env: Env) {
  const lat = Number(url.searchParams.get("lat")), lng = Number(url.searchParams.get("lng"));
  if (!(lat > 1.1 && lat < 1.5 && lng > 103.5 && lng < 104.2)) throw new HttpError(400, "location must be in Singapore");
  const r = intParam(url, "r", 150, 10, 600);
  const limit = intParam(url, "limit", 100, 1, 500);
  const dLat = r / 111320, dLng = r / (111320 * Math.cos((lat * Math.PI) / 180));
  const cells = new Set<number>();
  for (let y = lat - dLat; y <= lat + dLat + 0.002; y += 0.002)
    for (let x = lng - dLng; x <= lng + dLng + 0.002; x += 0.002) cells.add(cellOf(Math.min(y, lat + dLat), Math.min(x, lng + dLng)));
  const ids = [...cells];
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.lng, t.lat, t.species_id, s.common, s.scientific, t.girth_m, t.height_band, t.category
       FROM trees t LEFT JOIN species s ON s.id=t.species_id
      WHERE t.cell IN (${ids.map(() => "?").join(",")}) AND t.lat BETWEEN ? AND ? AND t.lng BETWEEN ? AND ?`,
  ).bind(...ids, lat - dLat, lat + dLat, lng - dLng, lng + dLng).all<Row>();
  const trees = results
    .map((t): Row & { dist_m: number } => ({ ...t, dist_m: Math.round(haversine(lat, lng, t.lat as number, t.lng as number)) }))
    .filter((t) => t.dist_m <= r)
    .sort((a, b) => a.dist_m - b.dist_m);
  const species = new Map<string, number>();
  for (const t of trees) {
    const k = String(t.common ?? t.scientific ?? "Unknown");
    species.set(k, (species.get(k) ?? 0) + 1);
  }
  return json({
    lat, lng, r, count: trees.length,
    species: [...species].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, n]) => ({ name, n })),
    trees: trees.slice(0, limit),
  }, 200, 600);
}

async function apiSpecies(env: Env, id: number) {
  const s = await env.DB.prepare("SELECT * FROM species WHERE id=?").bind(id).first();
  if (!s) throw new HttpError(404, "not found");
  const [roads, parks, areas] = await env.DB.batch(["road_id", "park_id", "pa_id"].map((col) =>
    env.DB.prepare(
      `SELECT p.kind, p.slug, p.name, x.n FROM (SELECT ${col} pid, count(*) n FROM trees
         WHERE species_id=? AND ${col} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 10) x
       JOIN places p ON p.id=x.pid ORDER BY x.n DESC`,
    ).bind(id)));
  return json({
    ...s, aliases: parseJSON(s.aliases, []),
    top_roads: roads.results, top_parks: parks.results, top_planning_areas: areas.results,
  }, 200, 21600);
}

/** Rankings: places of one kind by trees / species / carbon, or the trees with the widest trunks. */
const TOP_BY: Record<string, string> = { trees: "tree_count", species: "species_count", carbon: "carbon_kg" };
async function apiTop(url: URL, env: Env) {
  const kind = url.searchParams.get("kind") ?? "road";
  if (kind === "tree") {
    const { results } = await env.DB.prepare(
      `SELECT t.id, t.lng, t.lat, t.girth_m, t.height_band, t.ht_no, s.common, s.scientific, p.name place
         FROM trees t LEFT JOIN species s ON s.id=t.species_id LEFT JOIN places p ON p.id=coalesce(t.park_id, t.road_id)
        WHERE t.girth_m IS NOT NULL AND coalesce(t.measure_flag, 0)=0 ORDER BY t.girth_m DESC LIMIT 25`,
    ).all<Row>();
    return json({ kind, by: "girth", trees: results }, 200, 21600);
  }
  const by = url.searchParams.get("by") ?? "trees";
  if (!(kind in PLACE_COLUMN) || !(by in TOP_BY)) throw new HttpError(400, "invalid ranking");
  // The column name comes from the fixed TOP_BY map, never from user input.
  const { results } = await env.DB.prepare(
    `SELECT kind, slug, name, tree_count, species_count, carbon_kg FROM places WHERE kind=? ORDER BY ${TOP_BY[by]} DESC LIMIT 25`,
  ).bind(kind).all<Row>();
  return json({ kind, by, places: results }, 200, 21600);
}

// ---------------------------------------------------------------- address search (OneMap)
const ONEMAP = "https://www.onemap.gov.sg";
let onemapToken: { value: string; exp: number } | null = null;

/** Token from the configured OneMap account, cached until shortly before it expires. */
async function getOnemapToken(env: Env, force = false) {
  if (!env.ONEMAP_EMAIL || !env.ONEMAP_PASSWORD) return null;
  if (!force && onemapToken && onemapToken.exp - Date.now() > 3600_000) return onemapToken.value;
  const res = await fetch(`${ONEMAP}/api/auth/post/getToken`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: env.ONEMAP_EMAIL, password: env.ONEMAP_PASSWORD }),
  });
  if (!res.ok) { console.error("OneMap token request failed:", res.status); return null; }
  const d = await res.json<{ access_token?: string; expiry_timestamp?: string | number }>();
  if (!d.access_token) return null;
  const exp = Number(d.expiry_timestamp) * 1000 || Date.now() + 2 * 86400_000;
  onemapToken = { value: d.access_token, exp };
  return onemapToken.value;
}

async function apiGeocode(url: URL, env: Env) {
  const q = cleanQuery(url.searchParams.get("q") ?? "");
  if (q.length < 3) return json({ q, results: [] });
  const search = async (token: string | null) => fetch(
    `${ONEMAP}/api/common/elastic/search?${new URLSearchParams({ searchVal: q, returnGeom: "Y", getAddrDetails: "Y", pageNum: "1" })}`,
    { headers: { "user-agent": "TreeNerd (+https://treenerd.fyi)", ...(token ? { authorization: token } : {}) } },
  );
  let res: Response;
  try {
    res = await search(await getOnemapToken(env));
    if (res.status === 401 && env.ONEMAP_EMAIL) res = await search(await getOnemapToken(env, true));
  } catch (e) {
    console.error("OneMap unreachable:", String(e));
    throw new HttpError(502, "address search is unavailable right now");
  }
  if (!res.ok) throw new HttpError(502, "address search is unavailable right now");
  const d = await res.json<{ results?: OnemapHit[] }>();
  const results = parseOnemap(d.results ?? []);
  return json({ q, results }, 200, 86400);
}

function pathParts(url: URL) {
  try {
    return url.pathname.replace(/\/+$/, "").split("/").slice(2).map(decodeURIComponent);
  } catch {
    throw new HttpError(400, "bad request");
  }
}

async function api(env: Env, url: URL): Promise<Response> {
  const p = pathParts(url);
  if (p[0] === "meta") return json((await getMeta(env)) ?? { built_at: null }, 200, 300);
  if (p[0] === "search") return apiSearch(url, env);
  if (p[0] === "near") return apiNear(url, env);
  if (p[0] === "top") return apiTop(url, env);
  if (p[0] === "geocode") return apiGeocode(url, env);
  if (p[0] === "tree" && ID_RE.test(p[1] ?? "") && p.length === 2) return apiTree(env, Number(p[1]));
  if (p[0] === "species" && ID_RE.test(p[1] ?? "") && p.length === 2) return apiSpecies(env, Number(p[1]));
  if (p[0] === "place" && p[1] && p[2]) {
    if (p.length === 3) return apiPlace(env, p[1], p[2]);
    if (p.length === 4 && p[3] === "trees") return apiPlaceTrees(url, env, p[1], p[2], "json");
    if (p.length === 4 && p[3] === "trees.csv") return apiPlaceTrees(url, env, p[1], p[2], "csv");
    if (p.length === 4 && p[3] === "ids") return apiPlaceTrees(url, env, p[1], p[2], "ids");
  }
  throw new HttpError(404, "not found");
}

/** Rate-limit, normalise the URL, then serve from the edge cache (keyed by data build). */
async function cachedApi(request: Request, env: Env, ctx: ExecutionContext, url: URL) {
  if (env.API_LIMIT) {
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const { success } = await env.API_LIMIT.limit({ key: ip });
    if (!success) {
      const res = json({ error: "too many requests, slow down" }, 429);
      res.headers.set("retry-after", "60");
      return res;
    }
  }
  const allowed = ALLOWED_PARAMS[url.pathname.split("/")[2] ?? ""] ?? [];
  const clean = new URL(url.origin + url.pathname);
  for (const k of allowed) {
    const v = url.searchParams.get(k);
    if (v !== null) clean.searchParams.set(k, v.slice(0, 200));
  }
  clean.searchParams.sort();
  const v = await version(env);
  const key = new Request(`${clean.href}${clean.search ? "&" : "?"}__v=${encodeURIComponent(v)}`);
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await api(env, clean);
  if (res.status === 200) ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

// ---------------------------------------------------------------- R2 data files
async function data(request: Request, env: Env, url: URL) {
  const key = url.pathname.slice("/data/".length);
  if (!R2_PUBLIC.has(key)) throw new HttpError(404, "not found");
  const obj = await env.DATA.get(key, { range: request.headers, onlyIf: request.headers });
  if (!obj) throw new HttpError(404, "not found");
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", key === "trees.pmtiles" ? "public, max-age=86400" : "public, max-age=3600");
  if (!("body" in obj)) return new Response(null, { status: 304, headers });
  const range = obj.range as { offset?: number; length?: number; suffix?: number } | undefined;
  if (range && request.headers.has("range")) {
    const offset = range.offset ?? (range.suffix != null ? obj.size - range.suffix : 0);
    const length = range.length ?? obj.size - offset;
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    headers.set("content-length", String(length));
    return new Response(request.method === "HEAD" ? null : obj.body, { status: 206, headers });
  }
  headers.set("content-length", String(obj.size));
  return new Response(request.method === "HEAD" ? null : obj.body, { headers });
}

// ---------------------------------------------------------------- cron: freshness check
async function checkForNewData(env: Env) {
  const res = await fetch(`${env.ARCGIS_TREES_LAYER}?f=json`, { headers: { "user-agent": "TreeNerd (+https://treenerd.fyi)" } });
  if (!res.ok) throw new Error(`upstream returned ${res.status}`);
  const layer = await res.json<{ editingInfo?: { lastEditDate?: number } }>();
  const lastEdit = layer.editingInfo?.lastEditDate;
  const meta = await getMeta(env);
  const built = meta?.source_last_edit ? Date.parse(String(meta.source_last_edit)) : 0;
  const last = await env.DB.prepare("SELECT value FROM meta WHERE key='last_dispatch'").first<{ value: string }>()
    .catch(() => null);
  const sinceDispatch = Date.now() - Number(last?.value ?? 0);
  if (!lastEdit || lastEdit <= built + 60_000 || sinceDispatch < 20 * 3600_000) return;
  if (!env.GITHUB_TOKEN) return console.warn("upstream data changed; automatic rebuild is not configured");
  const gh = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${env.GITHUB_WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json",
        "user-agent": "TreeNerd (+https://treenerd.fyi)", "content-type": "application/json",
      },
      body: JSON.stringify({ ref: env.GITHUB_REF || "main", inputs: { reason: "upstream data changed" } }),
    },
  );
  console.log("rebuild requested:", gh.status);
  if (gh.ok) {
    await env.DB.prepare("INSERT OR REPLACE INTO meta VALUES ('last_dispatch', ?)").bind(String(Date.now())).run();
  }
}

// ---------------------------------------------------------------- entry
export default {
  async fetch(request, baseEnv, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (!isPreview(url)) return handle(request, baseEnv, ctx, url);
    if (url.pathname === "/robots.txt") {
      return noIndex(new Response("User-agent: *\nDisallow: /\n", { headers: { "content-type": "text/plain; charset=utf-8" } }));
    }
    return noIndex(await handle(request, baseEnv, ctx, url));
  },
  async scheduled(_event, baseEnv, ctx) {
    const env: Env = { ...baseEnv, DB: await activeDb(baseEnv) };
    ctx.waitUntil(checkForNewData(env).catch((e) => console.error("freshness check failed:", String(e))));
  },
} satisfies ExportedHandler<Env>;

async function handle(request: Request, baseEnv: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
    const env: Env = { ...baseEnv, DB: await activeDb(baseEnv) };
    try {
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/data/")) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return withSecurityHeaders(new Response(null, { status: 405, headers: { allow: "GET, HEAD" } }));
        }
        const res = url.pathname.startsWith("/api/")
          ? await cachedApi(request, env, ctx, url)
          : await data(request, env, url);
        return withSecurityHeaders(res);
      }
      if (url.pathname.startsWith("/tiles/")) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return withSecurityHeaders(new Response(null, { status: 405, headers: { allow: "GET, HEAD" } }));
        }
        // cache at the edge: tiles are immutable per build (?v=)
        const cache = caches.default;
        const hit = await cache.match(request);
        if (hit) return hit;
        const res = (await serveTiles(url, env.DATA)) ?? new Response("not found", { status: 404 });
        const out = withSecurityHeaders(res);
        if (out.status === 200 || out.status === 204) ctx.waitUntil(cache.put(request, out.clone()));
        return out;
      }
      if (url.pathname === "/sitemap.xml") {
        return withSecurityHeaders(await sitemap(env.DB, String((await getMeta(env))?.built_at ?? "") || null));
      }
      if (url.pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
        // the app shell, with a title/description matching the shared link (?p= / ?s= / ?t=)
        const shell = await env.ASSETS.fetch(new Request(new URL("/", url), request));
        const res = withMeta(new Response(shell.body, shell), await pageMeta(env.DB, url));
        const out = new Response(res.body, res);
        for (const [k, v] of Object.entries(PAGE_HEADERS)) out.headers.set(k, v);
        out.headers.set("cache-control", "public, max-age=0, must-revalidate");
        out.headers.delete("etag"); // body differs per query string
        return out;
      }
      return env.ASSETS.fetch(request); // static assets get their headers from public/_headers
    } catch (e) {
      if (e instanceof HttpError) return withSecurityHeaders(json({ error: e.message }, e.status));
      console.error(e);
      return withSecurityHeaders(json({ error: "internal error" }, 500));
    }
}
