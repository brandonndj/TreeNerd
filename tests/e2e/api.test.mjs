// API and HTTP behaviour of the Worker, against the local fixture site (see run.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const B = process.env.E2E_BASE || "http://127.0.0.1:8799";
const get = (path, init) => fetch(B + path, init);
const getJson = async (path) => { const r = await get(path); assert.equal(r.status, 200, path); return r.json(); };
/** Request with a chosen Host header (fetch can't set one). */
const asHost = (host, path) => new Promise((resolve, reject) => {
  const u = new URL(B + path);
  http.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: { host } }, (res) => {
    let body = ""; res.on("data", (c) => (body += c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
  }).on("error", reject);
});

test("meta describes the build", async () => {
  const m = await getJson("/api/meta");
  assert.equal(m.tree_count, 1246);
  assert.deepEqual(Object.keys(m.tile_keys).sort(), ["constituency", "park", "planning_area", "road", "subzone"]);
});

test("search tolerates typos and returns stations with coordinates", async () => {
  const typo = await getJson("/api/search?q=orchad+rd");
  assert.equal(typo.results[0].slug, "orchard-road");
  const mrt = (await getJson("/api/search?q=dhoby+ghaut+mrt")).results[0];
  assert.equal(mrt.kind, "mrt");
  assert.ok(Math.abs(mrt.lat - 1.2994) < 0.001 && Math.abs(mrt.lng - 103.8455) < 0.001);
  assert.deepEqual((await getJson("/api/search?q=zzzzzz")).results, []);
});

test("place summary, tree list, CSV and changes", async () => {
  const p = await getJson("/api/place/road/orchard-road");
  assert.equal(p.name, "Orchard Road");
  assert.equal(p.tree_count, 670);
  assert.equal(p.tile_key, "r");
  assert.equal(p.changes.filter((c) => c.change === "added").length, 3);
  assert.equal(p.changes.filter((c) => c.change === "removed").length, 3);
  const list = await getJson("/api/place/road/orchard-road/trees?limit=5");
  assert.equal(list.trees.length, 5);
  assert.ok(list.trees[0].girth_m >= list.trees[4].girth_m, "sorted by girth");
  const csv = await get("/api/place/road/orchard-road/trees.csv");
  assert.match(csv.headers.get("content-type"), /text\/csv/);
  const lines = (await csv.text()).trim().split("\n");
  assert.equal(lines[0].split(",")[0], "id");
  assert.equal(lines.length, 671);
  // constituencies highlight from the tiles
  assert.equal((await getJson("/api/place/constituency/tanjong-pagar-grc")).tile_key, "e");
});

test("tree and species carry the wood density used for carbon", async () => {
  const t = await getJson("/api/tree/10687021");
  assert.equal(t.species.common, "Rain Tree");
  assert.equal(t.species.wood_density, 0.53);
  assert.equal(t.places.road.slug, "orchard-road");
  const s = await getJson("/api/species/3106");
  assert.equal(s.wood_density_src, "species");
  assert.ok(s.top_roads.length > 0);
});

test("carbon is only estimated where the model applies", async () => {
  const palm = await getJson("/api/tree/13197918");
  assert.equal(palm.carbon_kg, null);
  assert.equal(palm.carbon_skip, "palm");
  const wide = await getJson("/api/tree/12975949");
  assert.ok(wide.girth_m > 6.66);
  assert.deepEqual([wide.carbon_kg, wide.carbon_skip], [null, "wide"]);
  const ordinary = await getJson("/api/tree/10687021");
  assert.ok(ordinary.carbon_kg > 0 && ordinary.carbon_kg < 30000);
  assert.equal(ordinary.carbon_skip, null);
});

test("health: everything present and fresh", async () => {
  const r = await get("/api/health");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const h = await r.json();
  assert.equal(h.ok, true);
  assert.deepEqual(h.checks, { database: true, build: true, search: true, tiles: true, fresh: true });
  assert.ok(h.age_days < 2);
});

test("nearby trees, sorted by distance, only inside Singapore", async () => {
  const n = await getJson("/api/near?lat=1.2994&lng=103.8455&r=100");
  assert.ok(n.count > 0);
  assert.ok(n.trees.every((t, i) => t.dist_m <= 100 && (i === 0 || t.dist_m >= n.trees[i - 1].dist_m)));
  assert.equal((await get("/api/near?lat=48.85&lng=2.35")).status, 400);
});

test("rankings and recent changes", async () => {
  const roads = await getJson("/api/top?kind=road&by=trees");
  assert.ok(roads.places.length > 1 && roads.places[0].tree_count >= roads.places[1].tree_count);
  const widest = await getJson("/api/top?kind=tree");
  assert.ok(widest.trees[0].girth_m >= widest.trees[1].girth_m);
  assert.equal((await get("/api/top?kind=road&by=password")).status, 400);
  const ch = await getJson("/api/changes");
  assert.equal(ch.trees.length, 6);
  assert.deepEqual(ch.builds.map((b) => [b.change, b.n]).sort(), [["added", 3], ["removed", 3]]);
});

test("tiles: TileJSON, a tile with trees, an empty tile, a bad address", async () => {
  const v = encodeURIComponent((await getJson("/api/meta")).built_at);
  const tj = await getJson(`/tiles/trees.json?v=${v}`);
  assert.equal(tj.minzoom, 10);
  assert.ok(tj.tiles[0].endsWith(`/tiles/{z}/{x}/{y}.mvt?v=${v}`), tj.tiles[0]);
  const tile = await get(`/tiles/14/12917/8132.mvt?v=${v}`);
  assert.equal(tile.status, 200);
  assert.equal(tile.headers.get("content-type"), "application/vnd.mapbox-vector-tile");
  assert.match(tile.headers.get("cache-control"), /immutable/);
  assert.ok((await tile.arrayBuffer()).byteLength > 500);
  assert.equal((await get(`/tiles/14/12000/8000.mvt?v=${v}`)).status, 204);
  // a version that isn't the live build, or junk parameters, never earns a long-lived cache entry
  const junk = await get("/tiles/14/12917/8132.mvt?v=not-a-build&x=1");
  assert.equal(junk.status, 200);
  assert.doesNotMatch(junk.headers.get("cache-control"), /immutable/);
  assert.ok((await getJson("/tiles/trees.json?v=not-a-build")).tiles[0].endsWith(".mvt"));
  assert.equal((await get("/tiles/14/99999999/1.mvt")).status, 404);
  assert.equal((await get("/tiles/abc")).status, 404);
});

test("only GET, only known files, bad input rejected", async () => {
  assert.equal((await get("/api/search?q=x", { method: "POST" })).status, 405);
  assert.equal((await get("/data/active-db")).status, 404);
  assert.equal((await get("/data/../wrangler.jsonc")).status, 404);
  assert.equal((await get("/api/tree/abc")).status, 404);
  assert.equal((await get("/api/place/road/Orchard%20Road'--")).status, 404);
  assert.equal((await get("/api/place/road/orchard-road/trees?species=1%20OR%201=1")).status, 400);
  assert.equal((await get("/api/nope")).status, 404);
});

test("security headers on the page and the API", async () => {
  const page = await get("/");
  const csp = page.headers.get("content-security-policy");
  assert.match(csp, /default-src 'none'/);
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  const api = await get("/api/meta");
  assert.equal(api.headers.get("x-content-type-options"), "nosniff");
  assert.match(api.headers.get("content-security-policy"), /default-src 'none'/);
});

test("link previews are filled in on the server", async () => {
  const html = await (await get("/?p=road/orchard-road")).text();
  assert.match(html, /<title>Orchard Road trees · TreeNerd<\/title>/);
  assert.match(html, /670 trees/);
  assert.match(await (await get("/sitemap.xml")).text(), /\?p=road\/orchard-road/);
});

test("the dev preview host is kept out of search engines; the real host isn't", async () => {
  const dev = await asHost("dev.treenerd.fyi", "/");
  assert.equal(dev.headers["x-robots-tag"], "noindex, nofollow");
  assert.match((await asHost("dev.treenerd.fyi", "/robots.txt")).body, /Disallow: \/\n/);
  const live = await asHost("treenerd.fyi", "/");
  assert.equal(live.headers["x-robots-tag"], undefined);
  assert.match((await asHost("treenerd.fyi", "/robots.txt")).body, /Allow: \//);
});
