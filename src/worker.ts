/**
 * TreeNerd Worker
 *  - serves the static front end (public/) via Workers Static Assets
 *  - /data/*  -> R2 objects (CSV export, tile archive, search/species/meta/changes JSON)
 *  - /tiles/* -> vector tiles read from the PMTiles archive in R2 (see tiles.ts)
 *  - /api/*   -> D1 queries + in-memory search index, rate-limited and edge-cached per data build
 *  - cron     -> requests a rebuild only if the weekly data update was missed
 */
import { cleanQuery, parseOnemap, type OnemapHit } from "./geocode";
import { PAGE_HEADERS, pageMeta, sitemap, withMeta } from "./pages";
import { serveTiles } from "./tiles";
import { type Check, type Level, type Report, ago, overall, renderStatus } from "./status";
import { FEEDS, type Feed, air, feedProblems, forecast, heat, lightning, rain, temperature, uv } from "./weather";
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
  CF_VERSION_METADATA?: { id: string; tag: string; timestamp: string }; // when this Worker version was deployed
  DATAGOVSG_API_KEY?: string; // optional secret: data.gov.sg key, sent with NEA requests for higher rate limits
  ONEMAP_EMAIL?: string; // optional secrets: OneMap account used for address search
  ONEMAP_PASSWORD?: string;
}

const PLACE_COLUMN: Record<string, string> = {
  road: "road_id", park: "park_id", subzone: "subzone_id", planning_area: "pa_id",
  pcn: "pcn_id", constituency: "ed_id", heritage_road: "hr_id",
};
const R2_PUBLIC = new Set(["trees.pmtiles", "search.json", "species.json", "meta.json", "trees.csv.gz", "changes.json", "trails.geojson", "tca.geojson"]);
// Files that belong to one database build ("<name>-a.<ext>" / "-b"); see getSlotObject.
const SLOT_FILES: Record<string, [string, string]> = {
  "species.json": ["species", "json"], "trails.geojson": ["trails", "geojson"], "tca.geojson": ["tca", "geojson"],
};
/**
 * Kinds of place that have a page: the column-based ones, plus trails (a tree can be on several) and
 * Tree Conservation Areas ("tca": large areas whose figures the build works out, so their pages run no
 * tree queries and need no index; their trees aren't listed).
 */
const PLACE_KINDS = new Set([...Object.keys(PLACE_COLUMN), "trail", "tca"]);
const PRECOMPUTED_KINDS = new Set(["tca"]);
// Place columns present in the changes table (trees added to / gone from the records).
const CHANGE_COLUMN: Record<string, string> = {
  road: "road_id", park: "park_id", subzone: "subzone_id", planning_area: "pa_id", constituency: "ed_id",
};
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
  weather: ["lat", "lng"],
  changes: [],
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

/** Files that belong to one database: "<name>-a.<ext>" / "-b", falling back to the shared file. */
const slotKeys = (name: string, ext: string) => [`${name}-${active.which}.${ext}`, `${name}.${ext}`];
async function getSlotObject(env: Env, name: string, ext: string, options?: R2GetOptions): Promise<R2ObjectBody | R2Object | null> {
  for (const key of slotKeys(name, ext)) {
    const obj: R2ObjectBody | R2Object | null = await env.DATA.get(key, options);
    if (obj) return obj;
  }
  return null;
}

async function getSearch(env: Env) {
  const v = await version(env);
  if (searchIndex?.version === v) return searchIndex.index;
  const obj = await getSlotObject(env, "search", "json");
  if (!obj || !("body" in obj)) throw new HttpError(503, "search is not available yet");
  searchIndex = { version: v, index: new SearchIndex(await (obj as R2ObjectBody).json<Entry[]>()) };
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

/**
 * The SQL condition (on trees aliased "t", one bound parameter: the place id) that selects a place's
 * trees. Column names come only from the fixed PLACE_COLUMN map, never from user input.
 */
function placeCondition(kind: string) {
  if (PRECOMPUTED_KINDS.has(kind)) return "0"; // never queried: see apiPlace and apiPlaceTrees
  if (kind === "trail") return "t.id IN (SELECT tree_id FROM trail_trees WHERE trail_id=?)";
  return `t.${PLACE_COLUMN[kind]}=?`;
}

async function getPlace(env: Env, kind: string, slug: string) {
  if (!PLACE_KINDS.has(kind) || !SLUG_RE.test(slug)) throw new HttpError(404, "not found");
  const place = await env.DB.prepare("SELECT * FROM places WHERE kind=? AND slug=?").bind(kind, slug).first();
  if (!place) throw new HttpError(404, "not found");
  return { place, cond: placeCondition(kind) };
}

// ---------------------------------------------------------------- points of interest
const POI_COLUMN: Record<string, string> = { park: "park_id", subzone: "subzone_id", planning_area: "pa_id" };
const POI_FIELDS = "id, kind, class, name, description, url, lng, lat";

/** Amenities, hawker centres and heritage sites inside a park or area. Builds before this feature have no table. */
async function placePois(env: Env, kind: string, id: number) {
  const col = POI_COLUMN[kind];
  if (!col) return null;
  try {
    const { results } = await env.DB.prepare(
      `SELECT ${POI_FIELDS} FROM pois WHERE ${col}=? ORDER BY kind DESC, class, name LIMIT 400`,
    ).bind(id).all<Row>();
    return results;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- API routes
async function apiSearch(url: URL, env: Env) {
  const q = (url.searchParams.get("q") ?? "").slice(0, 100);
  const kinds = url.searchParams.get("kind")?.split(",").filter((k) => PLACE_KINDS.has(k) || k === "species" || k === "mrt").slice(0, 8);
  const idx = await getSearch(env);
  return json({ q, results: idx.search(q, { kinds: kinds?.length ? kinds : undefined, limit: intParam(url, "limit", 12, 1, 50) }) });
}

async function apiPlace(env: Env, kind: string, slug: string) {
  const { place, cond } = await getPlace(env, kind, slug);
  if (PRECOMPUTED_KINDS.has(kind)) return apiPrecomputedPlace(env, kind, slug, place);
  const [cats, sizes, heights, natives] = await env.DB.batch([
    env.DB.prepare(`SELECT t.category k, count(*) n FROM trees t WHERE ${cond} GROUP BY 1 ORDER BY 2 DESC`).bind(place.id),
    env.DB.prepare(`SELECT t.size k, count(*) n FROM trees t WHERE ${cond} GROUP BY 1`).bind(place.id),
    env.DB.prepare(`SELECT t.height_band k, count(*) n FROM trees t WHERE ${cond} GROUP BY 1`).bind(place.id),
    env.DB.prepare(
      `SELECT s.native k, count(*) n FROM trees t LEFT JOIN species s ON s.id=t.species_id WHERE ${cond} GROUP BY 1`,
    ).bind(place.id),
  ]);
  const top = parseJSON<[number, number][]>(place.top_species, []);
  const names = await speciesNames(env, top.map(([id]) => id));
  // which place ids are in the tiles depends on the data build (older builds have fewer)
  const tileKeys = ((await getMeta(env))?.tile_keys ?? { road: "r", park: "p", planning_area: "a" }) as Record<string, string>;
  return json({
    changes: await placeChanges(env, kind, place.id as number),
    pois: await placePois(env, kind, place.id as number),
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

/** A Tree Conservation Area: everything comes from the place row the build wrote; no tree queries. */
async function apiPrecomputedPlace(env: Env, kind: string, slug: string, place: Record<string, unknown>) {
  const extra = parseJSON<Record<string, unknown>>(place.extra as string, {});
  const top = parseJSON<[number, number][]>(place.top_species as string, []);
  const names = await speciesNames(env, top.map(([id]) => id));
  const cats = Object.entries((extra.categories ?? {}) as Record<string, number>).map(([k, n]) => ({ k, n }));
  return json({
    changes: null, pois: null, kind, slug, name: place.name, alt: parseJSON(place.alt as string, []),
    tree_count: place.tree_count, species_count: place.species_count,
    heritage_count: place.heritage_count, carbon_kg: place.carbon_kg,
    bbox: parseJSON(place.bbox as string, null), extra, tile_key: null, place_id: place.id, trees_listed: false,
    top_species: top.map(([id, n]) => ({ id, n, ...(names.get(id) ?? {}) })),
    categories: cats, sizes: [], heights: [], native: [],
  });
}

async function apiPlaceTrees(url: URL, env: Env, kind: string, slug: string, format: "json" | "csv" | "ids") {
  if (PRECOMPUTED_KINDS.has(kind)) throw new HttpError(404, "this area's trees aren't listed one by one");
  const { place, cond } = await getPlace(env, kind, slug);
  const species = url.searchParams.get("species");
  if (species && !ID_RE.test(species)) throw new HttpError(400, "invalid species");
  const where = cond + (species ? " AND t.species_id=?" : "");
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
    `SELECT t.id, t.lng, t.lat, t.species_id, s.common, s.scientific, t.girth_m, t.height_band, t.category, t.ht_no
       FROM trees t LEFT JOIN species s ON s.id=t.species_id
      WHERE t.cell IN (${ids.map(() => "?").join(",")}) AND t.lat BETWEEN ? AND ? AND t.lng BETWEEN ? AND ?`,
  ).bind(...ids, lat - dLat, lat + dLat, lng - dLng, lng + dLng).all<Row>();
  const trees = results
    .map((t): Row & { dist_m: number } => ({ ...t, dist_m: Math.round(haversine(lat, lng, t.lat as number, t.lng as number)) }))
    .filter((t) => t.dist_m <= r)
    .sort((a, b) => a.dist_m - b.dist_m);
  // amenities, hawker centres and heritage sites in the same circle (none before this feature's first build)
  const poiRows = await env.DB.prepare(
    `SELECT ${POI_FIELDS} FROM pois WHERE cell IN (${ids.map(() => "?").join(",")}) AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`,
  ).bind(...ids, lat - dLat, lat + dLat, lng - dLng, lng + dLng).all<Row>().then((r) => r.results, () => null);
  const pois = poiRows === null ? null : poiRows
    .map((p): Row & { dist_m: number } => ({ ...p, dist_m: Math.round(haversine(lat, lng, p.lat as number, p.lng as number)) }))
    .filter((p) => p.dist_m <= r).sort((a, b) => a.dist_m - b.dist_m);
  const species = new Map<string, number>();
  for (const t of trees) {
    const k = String(t.common ?? t.scientific ?? "Unknown");
    species.set(k, (species.get(k) ?? 0) + 1);
  }
  return json({
    lat, lng, r, count: trees.length,
    species: [...species].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, n]) => ({ name, n })),
    trees: trees.slice(0, limit),
    pois,
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

/** Trees added to / no longer in the records for one place. Builds made before this feature have no table. */
async function placeChanges(env: Env, kind: string, id: number) {
  const col = CHANGE_COLUMN[kind];
  if (!col) return null;
  try {
    const { results } = await env.DB.prepare(
      `SELECT tree_id, change, seen, since, lng, lat, common, scientific, girth_m FROM changes
        WHERE ${col}=? ORDER BY seen DESC, change, tree_id LIMIT 300`,
    ).bind(id).all<Row>();
    return results;
  } catch {
    return null;
  }
}

/** Recent changes across Singapore: a count per build, and the latest trees. */
async function apiChanges(env: Env) {
  try {
    const [builds, rows] = await env.DB.batch<Row>([
      env.DB.prepare("SELECT seen, since, change, count(*) n FROM changes GROUP BY seen, since, change ORDER BY seen DESC LIMIT 60"),
      env.DB.prepare(
        `SELECT c.tree_id, c.change, c.seen, c.lng, c.lat, c.common, c.scientific, c.girth_m, p.name place
           FROM changes c LEFT JOIN places p ON p.id=coalesce(c.park_id, c.road_id)
          ORDER BY c.seen DESC, c.change, c.tree_id LIMIT 300`),
    ]);
    return json({ builds: builds.results, trees: rows.results }, 200, 3600);
  } catch {
    return json({ builds: [], trees: [] }, 200, 300);
  }
}

/** How old the data may get before the site reports itself unhealthy (updates run weekly). */
const STALE_AFTER_DAYS = 10;

/**
 * GET /api/health: for uptime monitors. 200 when the live database, search index and tiles are all
 * present and the data is fresh; 503 otherwise. Never cached.
 */
async function apiHealth(env: Env) {
  const meta = await getMeta(env);
  const builtAt = meta?.built_at ? Date.parse(String(meta.built_at)) : NaN;
  const ageDays = Number.isFinite(builtAt) ? (Date.now() - builtAt) / 86400_000 : null;
  const present = async (name: string, ext: string) => {
    for (const key of slotKeys(name, ext)) if (await env.DATA.head(key).catch(() => null)) return true;
    return false;
  };
  const checks = {
    database: await env.DB.prepare("SELECT 1 FROM trees LIMIT 1").first().then((r) => !!r, () => false),
    build: !!meta,
    search: await present("search", "json"),
    tiles: await present("trees", "pmtiles"),
    fresh: ageDays !== null && ageDays <= STALE_AFTER_DAYS,
  };
  const ok = Object.values(checks).every(Boolean);
  return new Response(JSON.stringify({
    ok, checks, built_at: meta?.built_at ?? null, age_days: ageDays === null ? null : Math.round(ageDays * 10) / 10,
    stale_after_days: STALE_AFTER_DAYS, database: active.which,
  }), { status: ok ? 200 : 503, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

/** Rankings: places of one kind by trees / species / carbon, or the trees with the widest trunks. */
const TOP_BY: Record<string, string> = {
  trees: "tree_count", species: "species_count", carbon: "carbon_kg",
  per_km: "json_extract(extra, '$.trees_per_km')", per_resident: "json_extract(extra, '$.trees_per_1000_residents')",
};
// Rankings that only make sense for some kinds of place.
const TOP_ONLY: Record<string, string[]> = { per_km: ["trail"], per_resident: ["planning_area", "subzone"] };
async function apiTop(url: URL, env: Env) {
  const kind = url.searchParams.get("kind") ?? "road";
  if (kind === "tree") {
    const cols = `t.id, t.lng, t.lat, t.girth_m, t.height_band, t.ht_no, s.common, s.scientific, p.name place`;
    const joins = `LEFT JOIN species s ON s.id=t.species_id LEFT JOIN places p ON p.id=coalesce(t.park_id, t.road_id)`;
    // The build stores the widest trunks in top_trees. Builds made before that have no such table:
    // fall back to scanning the tree table.
    const { results } = await env.DB.prepare(
      `SELECT ${cols} FROM top_trees w JOIN trees t ON t.id=w.tree_id ${joins} ORDER BY w.rank`,
    ).all<Row>().catch(() => env.DB.prepare(
      `SELECT ${cols} FROM trees t ${joins}
        WHERE t.girth_m IS NOT NULL AND coalesce(t.measure_flag, 0)=0 ORDER BY t.girth_m DESC, t.id LIMIT 25`,
    ).all<Row>());
    return json({ kind, by: "girth", trees: results }, 200, 21600);
  }
  const by = url.searchParams.get("by") ?? "trees";
  if (!PLACE_KINDS.has(kind) || !(by in TOP_BY) || (TOP_ONLY[by] && !TOP_ONLY[by].includes(kind))) {
    throw new HttpError(400, "invalid ranking");
  }
  // The expression comes from the fixed TOP_BY map, never from user input. Places without the
  // figure (e.g. areas with too few residents) are left out, not ranked last.
  const { results } = await env.DB.prepare(
    `SELECT kind, slug, name, tree_count, species_count, carbon_kg, extra FROM places
      WHERE kind=? AND ${TOP_BY[by]} IS NOT NULL ORDER BY ${TOP_BY[by]} DESC LIMIT 25`,
  ).bind(kind).all<Row>();
  for (const r of results) r.extra = parseJSON(r.extra, {});
  return json({ kind, by, places: results }, 200, 21600);
}

// ---------------------------------------------------------------- live conditions (NEA)
/** One NEA feed, from the edge cache (two minutes) or upstream; null if NEA can't be reached. */
const neaHeaders = (env: Env): Record<string, string> => ({
  "user-agent": "TreeNerd (+https://treenerd.fyi)", ...(env.DATAGOVSG_API_KEY ? { "x-api-key": env.DATAGOVSG_API_KEY } : {}),
});
// data.gov.sg allows 12 real-time requests per 10 s with a development key (30 with a production key,
// 6 without). Everything that reads NEA (visitors' cards, the hourly check, /status) goes through this
// one shared cache, so all of them together make at most 7 requests per feed interval per data centre.
const NEA_CACHE_S = 120;
const NEA_BACKOFF_S = 20; // after a refusal (429) or an NEA error, don't ask again for this long
interface NeaFetch { body: unknown; status: number; fetched_at: number; cached: boolean; error?: string }

/** One NEA feed from the shared edge cache, or from NEA. A refusal is remembered briefly, so callers back off. */
async function neaFetch(feed: Feed, env: Env, ctx: ExecutionContext, signal?: AbortSignal): Promise<NeaFetch> {
  const cache = caches.default, key = new Request(FEEDS[feed]);
  const hit = await cache.match(key);
  if (hit) {
    const status = Number(hit.headers.get("x-nea-status") ?? 200), fetched_at = Number(hit.headers.get("x-fetched-at") ?? 0);
    if (status !== 200) return { body: null, status, fetched_at, cached: true };
    try { return { body: await hit.json(), status, fetched_at, cached: true }; } catch { /* corrupt entry: fetch again */ }
  }
  const remember = (body: string, status: number, maxAge: number) => ctx.waitUntil(cache.put(key, new Response(body, { headers: {
    "content-type": "application/json", "cache-control": `public, max-age=${maxAge}`, "x-nea-status": String(status), "x-fetched-at": String(Date.now()) } })));
  try {
    const up = await fetch(FEEDS[feed], { headers: neaHeaders(env), signal });
    if (!up.ok) {
      console.error(`NEA ${feed}: HTTP ${up.status}`);
      remember("", up.status, NEA_BACKOFF_S);
      return { body: null, status: up.status, fetched_at: Date.now(), cached: false };
    }
    const text = await up.text();
    remember(text, 200, NEA_CACHE_S);
    return { body: JSON.parse(text), status: 200, fetched_at: Date.now(), cached: false };
  } catch (e) {
    console.error(`NEA ${feed} unavailable:`, String(e));
    return { body: null, status: 0, fetched_at: Date.now(), cached: false, error: String(e) };
  }
}
const neaFeed = async (feed: Feed, env: Env, ctx: ExecutionContext) => (await neaFetch(feed, env, ctx)).body;

/**
 * Live conditions near a point: air temperature (`reading`, unchanged for older pages), heat stress,
 * the 2-hour forecast, rain now, lightning, UV and PM2.5 (see src/weather.ts). Each is null when NEA
 * has no fresh reading; one failing feed never hides the others. At most one upstream request per
 * feed every two minutes, whoever asks.
 */
async function apiWeather(url: URL, env: Env, ctx: ExecutionContext) {
  const lat = Number(url.searchParams.get("lat")), lng = Number(url.searchParams.get("lng"));
  if (!(lat > 1.1 && lat < 1.5 && lng > 103.5 && lng < 104.2)) throw new HttpError(400, "location must be in Singapore");
  const names = Object.keys(FEEDS) as Feed[];
  const feeds = Object.fromEntries(names.map((f, i) => [f, i])) as Record<Feed, number>;
  const got = await Promise.all(names.map((f) => neaFeed(f, env, ctx)));
  const now = Date.now(), d = (f: Feed) => got[feeds[f]];
  const safe = <T>(fn: () => T) => { try { return fn(); } catch (e) { console.error("NEA parse:", String(e)); return null; } };
  const body = {
    reading: safe(() => temperature(d("temperature"), lat, lng, now)),
    heat: safe(() => heat(d("heat"), lat, lng, now)),
    forecast: safe(() => forecast(d("forecast"), lat, lng, now)),
    rain: safe(() => rain(d("rain"), lat, lng, now)),
    lightning: safe(() => lightning(d("lightning"), lat, lng, now)),
    uv: safe(() => uv(d("uv"), now)),
    air: safe(() => air(d("air"), lat, lng, now)),
    source: "National Environment Agency, via data.gov.sg",
  };
  // live readings: no stale copies in browsers (json() would allow a day of stale-while-revalidate)
  const res = json(body, 200, 60);
  res.headers.set("cache-control", "public, max-age=60");
  return res;
}

// ---------------------------------------------------------------- address search (OneMap)
const ONEMAP = "https://www.onemap.gov.sg";
let onemapToken: { value: string; exp: number } | null = null;

/**
 * Token from the configured OneMap account, cached until shortly before it expires. `signal` lets a
 * caller with a time limit (the status page) abort the sign-in.
 */
async function getOnemapToken(env: Env, force = false, signal?: AbortSignal) {
  if (!env.ONEMAP_EMAIL || !env.ONEMAP_PASSWORD) return null;
  if (!force && onemapToken && onemapToken.exp - Date.now() > 3600_000) return onemapToken.value;
  const res = await fetch(`${ONEMAP}/api/auth/post/getToken`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: env.ONEMAP_EMAIL, password: env.ONEMAP_PASSWORD }),
    signal,
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

async function api(env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  const p = pathParts(url);
  if (p[0] === "meta") return json((await getMeta(env)) ?? { built_at: null }, 200, 300);
  if (p[0] === "search") return apiSearch(url, env);
  if (p[0] === "near") return apiNear(url, env);
  if (p[0] === "top") return apiTop(url, env);
  if (p[0] === "weather" && p.length === 1) return apiWeather(url, env, ctx);
  if (p[0] === "changes" && p.length === 1) return apiChanges(env);
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
  if (url.pathname === "/api/health") return apiHealth(env); // live state: never from the cache
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
  const res = await api(env, clean, ctx);
  if (res.status === 200) ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

// ---------------------------------------------------------------- R2 data files
async function data(request: Request, env: Env, url: URL) {
  const key = url.pathname.slice("/data/".length);
  if (!R2_PUBLIC.has(key)) throw new HttpError(404, "not found");
  // the species list and trail lines must match the live database; everything else is the latest published file
  const obj: R2ObjectBody | R2Object | null = SLOT_FILES[key]
    ? await getSlotObject(env, ...SLOT_FILES[key], { range: request.headers, onlyIf: request.headers })
    : await env.DATA.get(key, { range: request.headers, onlyIf: request.headers });
  if (!obj) throw new HttpError(404, "not found");
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", key === "trees.pmtiles" ? "public, max-age=86400" : "public, max-age=3600");
  if (!("body" in obj)) return new Response(null, { status: 304, headers });
  const body = (obj as R2ObjectBody).body;
  const range = obj.range as { offset?: number; length?: number; suffix?: number } | undefined;
  if (range && request.headers.has("range")) {
    const offset = range.offset ?? (range.suffix != null ? obj.size - range.suffix : 0);
    const length = range.length ?? obj.size - offset;
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    headers.set("content-length", String(length));
    return new Response(request.method === "HEAD" ? null : body, { status: 206, headers });
  }
  headers.set("content-length", String(obj.size));
  return new Response(request.method === "HEAD" ? null : body, { headers });
}

// ---------------------------------------------------------------- cron: freshness check
async function checkForNewData(env: Env) {
  // what the status page shows as the last freshness check (one row, ~120 writes a month)
  await env.DB.prepare("INSERT OR REPLACE INTO meta VALUES ('freshness_last_check', ?)").bind(String(Date.now())).run().catch(() => {});
  const res = await fetch(`${env.ARCGIS_TREES_LAYER}?f=json`, { headers: { "user-agent": "TreeNerd (+https://treenerd.fyi)" } });
  if (!res.ok) throw new Error(`upstream returned ${res.status}`);
  const layer = await res.json<{ editingInfo?: { lastEditDate?: number } }>();
  const lastEdit = layer.editingInfo?.lastEditDate;
  const meta = await getMeta(env);
  const built = meta?.source_last_edit ? Date.parse(String(meta.source_last_edit)) : 0;
  const last = await env.DB.prepare("SELECT value FROM meta WHERE key='last_dispatch'").first<{ value: string }>()
    .catch(() => null);
  const sinceDispatch = Date.now() - Number(last?.value ?? 0);
  // Data is rebuilt once a week by the data workflow's own schedule. This check only steps in when
  // that was missed: a build older than 8 days means a run failed or never started.
  // It does NOT rebuild whenever the source changes. The source changes almost daily, and every
  // rebuild rewrites the whole database, which is billed per row written (see schema.sql).
  const builtAt = meta?.built_at ? Date.parse(String(meta.built_at)) : 0;
  const overdue = Date.now() - builtAt > 8 * 86400_000;
  const changed = !!lastEdit && lastEdit > built + 60_000;
  if (overdue) console.error(`data is ${Math.round((Date.now() - builtAt) / 86400_000)} days old: the weekly update was missed`);
  if (!overdue || !changed || sinceDispatch < 20 * 3600_000) return;
  if (!env.GITHUB_TOKEN) return console.warn("a rebuild is needed; automatic rebuild is not configured");
  const gh = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${env.GITHUB_WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json",
        "user-agent": "TreeNerd (+https://treenerd.fyi)", "content-type": "application/json",
      },
      body: JSON.stringify({ ref: env.GITHUB_REF || "main", inputs: { reason: "weekly update missed" } }),
    },
  );
  console.log("rebuild requested:", gh.status);
  if (gh.ok) {
    await env.DB.prepare("INSERT OR REPLACE INTO meta VALUES ('last_dispatch', ?)").bind(String(Date.now())).run();
  }
}

// ---------------------------------------------------------------- cron: NEA feed check
const NEA_CRON = "43 * * * *";
const NEA_ALERT_AFTER = 3600_000; // a problem must last this long: NEA has brief gaps
const NEA_ALERT_EVERY = 24 * 3600_000; // while it lasts, remind at most once a day
/**
 * Hourly: fetch every NEA feed and check it still gives what the weather card needs (feedProblems).
 * A problem lasting over an hour runs the "NEA feed alert" workflow, which opens an issue; recovery
 * runs it again to close the issue. State is two rows in the meta table, written only when it changes.
 * It reads through the shared NEA cache, so it adds at most 7 requests an hour.
 */
async function checkNea(env: Env, ctx: ExecutionContext) {
  const names = Object.keys(FEEDS) as Feed[];
  const got = await Promise.all(names.map(async (f) => [f, (await neaFetch(f, env, ctx)).body] as const));
  const problems = feedProblems(Object.fromEntries(got), Date.now());
  // what the status page shows as the last hourly check (one row, ~720 writes a month)
  await env.DB.prepare("INSERT OR REPLACE INTO meta VALUES ('nea_last_check', ?)").bind(JSON.stringify({ at: Date.now(), problems })).run().catch(() => {});
  const get = async (k: string) => (await env.DB.prepare("SELECT value FROM meta WHERE key=?").bind(k).first<{ value: string }>().catch(() => null))?.value;
  const put = (k: string, v: string | null) => (v === null
    ? env.DB.prepare("DELETE FROM meta WHERE key=?").bind(k) : env.DB.prepare("INSERT OR REPLACE INTO meta VALUES (?, ?)").bind(k, v)).run();
  const since = Number(await get("nea_problem_since") ?? 0), alerted = Number(await get("nea_alerted_at") ?? 0);
  if (!problems.length) {
    if (since) await put("nea_problem_since", null);
    if (alerted) {
      console.log("NEA feeds have recovered");
      if (await dispatchNeaAlert(env, "recovered", "All NEA feeds give readings again.")) await put("nea_alerted_at", null);
    }
    return;
  }
  console.error("NEA feed problem:", problems.join("; "));
  if (!since) return void await put("nea_problem_since", String(Date.now()));
  if (Date.now() - since < NEA_ALERT_AFTER || Date.now() - alerted < NEA_ALERT_EVERY) return;
  const hours = Math.round((Date.now() - since) / 3600_000);
  if (await dispatchNeaAlert(env, "problem", `For about ${hours} h: ${problems.join("; ")}`)) await put("nea_alerted_at", String(Date.now()));
}

async function dispatchNeaAlert(env: Env, status: "problem" | "recovered", details: string) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) { console.warn("NEA alert not sent: GITHUB_TOKEN is not set"); return false; }
  const gh = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/nea-alert.yml/dispatches`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json",
      "user-agent": "TreeNerd (+https://treenerd.fyi)", "content-type": "application/json" },
    body: JSON.stringify({ ref: env.GITHUB_REF || "main", inputs: { status, details: details.slice(0, 900) } }),
  });
  console.log(`NEA alert (${status}) sent:`, gh.status);
  return gh.ok;
}

// ---------------------------------------------------------------- /status (owner's page; not linked or indexed)
let statusCache: { at: number; report: Report } | null = null;

/** Run fn with a time limit; returns its result, how long it took, or the error. */
async function timed<T>(fn: (signal: AbortSignal) => Promise<T>, ms = 8000) {
  const t0 = Date.now(), ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), ms);
  try { return { value: await fn(ctl.signal), ms: Date.now() - t0, error: null as string | null }; }
  catch (e) { return { value: null, ms: Date.now() - t0, error: ctl.signal.aborted ? `no answer in ${ms / 1000} s` : String(e) }; }
  finally { clearTimeout(timer); }
}

async function statusReport(env: Env, ctx: ExecutionContext): Promise<Report> {
  if (statusCache && Date.now() - statusCache.at < 30_000) return statusCache.report;
  const now = Date.now(), fmtN = new Intl.NumberFormat("en-SG");
  const meta = await getMeta(env);
  const stored = async (k: string) => (await env.DB.prepare("SELECT value FROM meta WHERE key=?").bind(k).first<{ value: string }>().catch(() => null))?.value ?? null;
  const present = async (name: string, ext: string) => {
    for (const key of slotKeys(name, ext)) if (await env.DATA.head(key).catch(() => null)) return true;
    return false;
  };
  const ua = { "user-agent": "TreeNerd (+https://treenerd.fyi)" };

  // ---- data
  const builtAt = meta?.built_at ? Date.parse(String(meta.built_at)) : NaN;
  const ageDays = Number.isFinite(builtAt) ? (now - builtAt) / 86400_000 : null;
  const dbOk = await env.DB.prepare("SELECT 1 FROM trees LIMIT 1").first().then((r) => !!r, () => false);
  const [searchOk, tilesOk] = await Promise.all([present("search", "json"), present("trees", "pmtiles")]);
  const data: Check[] = [
    { name: "Database", level: dbOk ? "ok" : "fail", detail: dbOk ? `live copy: ${active.which.toUpperCase()}` : "no trees found" },
    { name: "Data update", level: ageDays === null ? "fail" : ageDays > STALE_AFTER_DAYS ? "fail" : ageDays > 8 ? "warn" : "ok",
      detail: ageDays === null ? "no build found" : `built ${ago(builtAt, now)} (${String(meta!.built_at).slice(0, 10)}); ${fmtN.format(Number(meta?.tree_count) || 0)} trees; updates weekly` },
    { name: "NParks records", level: meta?.source_last_edit ? "ok" : "warn",
      detail: meta?.source_last_edit ? `last edited by NParks ${ago(Date.parse(String(meta.source_last_edit)), now)}, as seen at the last update` : "not recorded" },
    { name: "Search index", level: searchOk ? "ok" : "fail", detail: searchOk ? "present" : "missing" },
    { name: "Map tiles", level: tilesOk ? "ok" : "fail", detail: tilesOk ? "present" : "missing" },
  ];

  // ---- live checks, all at once
  const feeds = Object.keys(FEEDS) as Feed[];
  const [neaRes, arcgis, onemapSearch, basemap, github] = await Promise.all([
    Promise.all(feeds.map((f) => timed((signal) => neaFetch(f, env, ctx, signal)))),
    timed(async (signal) => {
      const r = await fetch(`${env.ARCGIS_TREES_LAYER}?f=json`, { headers: ua, signal });
      return { status: r.status, edit: r.ok ? (await r.json<{ editingInfo?: { lastEditDate?: number } }>()).editingInfo?.lastEditDate : undefined };
    }),
    timed(async (signal) => {
      const token = await getOnemapToken(env, false, signal); // the sign-in counts toward the time limit too
      const r = await fetch(`${ONEMAP}/api/common/elastic/search?searchVal=238823&returnGeom=N&getAddrDetails=N&pageNum=1`,
        { headers: { ...ua, ...(token ? { authorization: token } : {}) }, signal });
      return { status: r.status, token: !!token };
    }),
    timed(async (signal) => (await fetch(`${ONEMAP}/maps/tiles/Grey/12/3230/2033.png`, { headers: ua, signal })).status),
    timed(async (signal) => {
      if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return null;
      return (await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}`, {
        headers: { ...ua, authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json" }, signal })).status;
    }),
  ]);

  const problems = feedProblems(Object.fromEntries(feeds.map((f, i) => [f, neaRes[i].value?.body ?? null])), now);
  const nea: Check[] = feeds.map((f, i) => {
    const r = neaRes[i], v = r.value, p = problems.find((x) => x.startsWith(`${f}:`));
    const when = v ? ` (${v.cached ? `fetched ${ago(v.fetched_at, now)}, shared cache` : "fetched now"})` : "";
    // a refusal (429) is brief and the card just leaves that reading out; the hourly check alerts if it lasts
    const level: Level = r.error || !v || v.error || v.status === 0 ? "fail" : v.status === 429 ? "warn" : v.status !== 200 ? "fail" : p ? "warn" : "ok";
    const detail = r.error ? `unreachable: ${r.error}` : v!.error || v!.status === 0 ? `unreachable: ${v!.error ?? "no answer"}`
      : v!.status === 429 ? `data.gov.sg asked us to slow down (HTTP 429)${when}; the card leaves this reading out meanwhile`
      : v!.status !== 200 ? `HTTP ${v!.status}${v!.status === 401 || v!.status === 403 ? " (is the API key valid?)" : ""}${when}`
      : p ? `${p.slice(f.length + 2)}${when}` : `giving readings${when}`;
    return { name: `NEA ${f}`, level, detail, ms: v?.cached ? undefined : r.ms };
  });
  const [neaLast, neaSince, neaAlerted, freshLast, lastDispatch] = await Promise.all(
    ["nea_last_check", "nea_problem_since", "nea_alerted_at", "freshness_last_check", "last_dispatch"].map(stored));
  const neaLastParsed = (() => { try { return neaLast ? JSON.parse(neaLast) as { at: number; problems: string[] } : null; } catch { return null; } })();

  const services: Check[] = [
    { name: "NParks tree layer (ArcGIS)", level: arcgis.error || arcgis.value?.status !== 200 ? "fail" : "ok", ms: arcgis.ms,
      detail: arcgis.error ? `unreachable: ${arcgis.error}` : arcgis.value!.status !== 200 ? `HTTP ${arcgis.value!.status}`
        : `reachable; NParks last edited ${ago(arcgis.value!.edit, now)}` },
    { name: "OneMap address search", level: onemapSearch.error || onemapSearch.value?.status !== 200 ? "fail" : "ok", ms: onemapSearch.ms,
      detail: onemapSearch.error ? `unreachable: ${onemapSearch.error}` : onemapSearch.value!.status !== 200 ? `HTTP ${onemapSearch.value!.status}`
        : onemapSearch.value!.token ? "working, signed in with the OneMap account" : "working, without an account" },
    { name: "OneMap basemap", level: basemap.error || basemap.value !== 200 ? "fail" : "ok", ms: basemap.ms,
      detail: basemap.error ? `unreachable: ${basemap.error}` : basemap.value !== 200 ? `HTTP ${basemap.value}` : "tiles loading (visitors' browsers fetch these directly)" },
  ];

  const set = (v?: string) => !!v && v.length > 0;
  const keys: Check[] = [
    { name: "data.gov.sg API key (Worker)", level: set(env.DATAGOVSG_API_KEY) ? (nea.some((c) => /API key/.test(c.detail)) ? "fail" : "ok") : "off",
      detail: set(env.DATAGOVSG_API_KEY) ? "set, and sent with every NEA request" : "not set: NEA is used without a key (optional; the weekly data update has its own key in GitHub)" },
    { name: "OneMap account", level: set(env.ONEMAP_EMAIL) && set(env.ONEMAP_PASSWORD) ? (onemapSearch.value?.token ? "ok" : "fail") : "off",
      detail: set(env.ONEMAP_EMAIL) && set(env.ONEMAP_PASSWORD) ? (onemapSearch.value?.token ? "set, and signing in works" : "set, but signing in failed") : "not set (optional)" },
    { name: "GitHub token", level: !set(env.GITHUB_TOKEN) ? "warn" : github.value === 200 ? "ok" : "fail", ms: set(env.GITHUB_TOKEN) ? github.ms : undefined,
      detail: !set(env.GITHUB_TOKEN) ? "not set: a missed weekly update won't be retried and NEA alerts can't open issues"
        : github.value === 200 ? `set, and accepted for ${env.GITHUB_REPO}` : `set, but GitHub answered ${github.value ?? github.error}` },
  ];

  // A job that hasn't run yet is expected for one interval after a deploy or a data update (each update
  // replaces the database where the jobs record their runs); only after that is it a problem.
  const deployedAt = Date.parse(env.CF_VERSION_METADATA?.timestamp ?? "");
  const since = Math.max(Number.isFinite(builtAt) ? builtAt : 0, Number.isFinite(deployedAt) ? deployedAt : 0);
  const notYet = (everyMs: number, name: string): Check => since && now - since < everyMs + 15 * 60_000
    ? { name, level: "ok", detail: `not run yet since the ${since === deployedAt ? "last deploy" : "last data update"} ${ago(since, now)}; it runs within ${Math.round(everyMs / 3600_000)} h` }
    : { name, level: "warn", detail: "no run recorded yet (runs are recorded in the live database, so this starts again after each weekly update)" };
  const jobs: Check[] = [
    !neaLastParsed ? notYet(3600_000, "Hourly NEA check")
      : { name: "Hourly NEA check", level: now - neaLastParsed.at > 2.5 * 3600_000 ? "fail" : neaLastParsed.problems.length ? "warn" : "ok",
        detail: `last ran ${ago(neaLastParsed.at, now)}: ${neaLastParsed.problems.length ? neaLastParsed.problems.join("; ") : "all feeds fine"}` },
    { name: "NEA alert", level: neaAlerted ? "fail" : neaSince ? "warn" : "ok",
      detail: neaAlerted ? `issue opened ${ago(Number(neaAlerted), now)}; problem since ${ago(Number(neaSince), now)}`
        : neaSince ? `a problem started ${ago(Number(neaSince), now)}; an issue opens if it lasts an hour` : "no open problem" },
    !freshLast ? notYet(6 * 3600_000, "Freshness check (every 6 h)")
      : { name: "Freshness check (every 6 h)", level: now - Number(freshLast) > 7 * 3600_000 ? "fail" : "ok",
        detail: `last ran ${ago(Number(freshLast), now)}${lastDispatch ? `; last asked for a rebuild ${ago(Number(lastDispatch), now)}` : ""}` },
  ];

  const sections = [
    { title: "Data", checks: data },
    { title: "NEA weather feeds", note: "Read through the same 2-minute cache the weather card uses, so this page adds no load on data.gov.sg (12 requests per 10 s with a development key, 30 with a production key). Rain, lightning and UV are often empty; for them the reply's format and time are checked.", checks: nea },
    { title: "Other services", checks: services },
    { title: "Keys and tokens", checks: keys },
    { title: "Scheduled jobs", checks: jobs },
  ];
  const report: Report = { generated_at: new Date(now).toISOString(), overall: overall(sections), sections };
  statusCache = { at: Date.now(), report };
  return report;
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
  async scheduled(event, baseEnv, ctx) {
    const env: Env = { ...baseEnv, DB: await activeDb(baseEnv) };
    if (event.cron === NEA_CRON) ctx.waitUntil(checkNea(env, ctx).catch((e) => console.error("NEA check failed:", String(e))));
    else ctx.waitUntil(checkForNewData(env).catch((e) => console.error("freshness check failed:", String(e))));
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
        // Normalise the address before it is used as a cache key: only ?v= survives, and only when
        // it names the live build. Junk parameters can't multiply cache entries or force storage reads.
        const tileUrl = new URL(url.origin + url.pathname);
        if (url.searchParams.get("v") === (await version(env))) tileUrl.searchParams.set("v", url.searchParams.get("v")!);
        // The key keeps the request's headers: without Accept-Encoding the cache hands back the
        // uncompressed variant, three times the size.
        const key = new Request(tileUrl.href, { method: "GET", headers: request.headers });
        // cache at the edge: tiles are immutable per build.
        // Not on localhost: the local emulator's cache compresses stored gzip responses a second time.
        const local = /^(localhost|127\.0\.0\.1|.*\.localhost)$/.test(url.hostname);
        const cache = caches.default;
        const hit = local ? undefined : await cache.match(key);
        if (hit) return hit;
        const res = (await serveTiles(tileUrl, env.DATA, slotKeys("trees", "pmtiles"))) ?? new Response("not found", { status: 404 });
        const out = withSecurityHeaders(res);
        if (!local && (out.status === 200 || out.status === 204)) ctx.waitUntil(cache.put(key, out.clone()));
        return out;
      }
      if (url.pathname === "/status" || url.pathname === "/status.json") {
        // the owner's status page: never cached, never indexed, no secret values (see src/status.ts).
        // It calls other services, so it shares the API's per-visitor rate limit.
        if (env.API_LIMIT && !(await env.API_LIMIT.limit({ key: request.headers.get("cf-connecting-ip") ?? "unknown" })).success) {
          return new Response("too many requests, slow down", { status: 429, headers: { "retry-after": "60" } });
        }
        const report = await statusReport(env, ctx);
        const res = url.pathname === "/status.json"
          ? new Response(JSON.stringify(report, null, 1), { headers: { "content-type": "application/json; charset=utf-8" } })
          : new Response(renderStatus(report), { headers: { "content-type": "text/html; charset=utf-8" } });
        for (const [k, v] of Object.entries(PAGE_HEADERS)) res.headers.set(k, v);
        res.headers.set("cache-control", "no-store");
        res.headers.set("x-robots-tag", "noindex, nofollow");
        return res;
      }
      if (url.pathname === "/sitemap.xml") {
        return withSecurityHeaders(await sitemap(env.DB, String((await getMeta(env))?.built_at ?? "") || null));
      }
      if (url.pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
        // the app shell, with a title/description matching the shared link (?p= / ?s= / ?t=)
        const shell = await env.ASSETS.fetch(new Request(new URL("/", url), request));
        const res = withMeta(new Response(shell.body, shell), await pageMeta(env.DB, url, Number((await getMeta(env))?.tree_count) || null));
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
