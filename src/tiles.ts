// Serve vector tiles as ordinary small requests (/tiles/{z}/{x}/{y}.mvt) by reading the PMTiles
// archive in R2 on the server. Browsers then never need HTTP Range requests, which some corporate
// proxies and web filters strip, rewrite or block.
import { PMTiles, type RangeResponse, type Source } from "pmtiles";

/** PMTiles source backed by an R2 object, pinned to one version (etag) of the archive. */
class R2Source implements Source {
  constructor(private bucket: R2Bucket, private key: string, private etag: string) {}

  getKey() {
    return `r2:${this.key}:${this.etag}`;
  }

  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const obj = await this.bucket.get(this.key, { range: { offset, length }, onlyIf: { etagMatches: this.etag } });
    if (!obj || !("body" in obj)) throw new Error("tile archive changed or missing");
    return { data: await obj.arrayBuffer(), etag: obj.etag };
  }
}

let archive: { key: string; etag: string; at: number; pmtiles: PMTiles } | null = null;

/**
 * One PMTiles reader per isolate. `keys` are tried in order: the archive that belongs to the live
 * database first, then the shared one. The object is re-checked at most every 30 s, so a tile
 * normally costs one storage read, not two.
 */
async function getArchive(bucket: R2Bucket, keys: string[]) {
  if (archive && keys[0] === archive.key && Date.now() - archive.at < 30_000) return archive.pmtiles;
  for (const key of keys) {
    const head = await bucket.head(key);
    if (!head) continue;
    if (archive?.key !== keys[0] || archive.etag !== head.etag) {
      archive = { key: keys[0], etag: head.etag, at: Date.now(), pmtiles: new PMTiles(new R2Source(bucket, key, head.etag)) };
    } else archive.at = Date.now();
    return archive.pmtiles;
  }
  return null;
}

const TILE_RE = /^\/tiles\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.mvt$/;

/**
 * GET /tiles/trees.json (TileJSON) and /tiles/{z}/{x}/{y}.mvt. Returns null for other paths.
 * `url` must already be normalised by the caller: it carries ?v= only when that is the live build.
 */
export async function serveTiles(url: URL, bucket: R2Bucket, keys: string[]): Promise<Response | null> {
  if (url.pathname === "/tiles/trees.json") {
    const pm = await getArchive(bucket, keys);
    if (!pm) return new Response("not found", { status: 404 });
    const h = await pm.getHeader();
    const v = url.searchParams.get("v") ?? "";
    return new Response(JSON.stringify({
      tilejson: "3.0.0",
      tiles: [`${url.origin}/tiles/{z}/{x}/{y}.mvt${v ? `?v=${encodeURIComponent(v)}` : ""}`],
      minzoom: h.minZoom, maxzoom: h.maxZoom,
      bounds: [h.minLon, h.minLat, h.maxLon, h.maxLat],
      vector_layers: [{ id: "trees", fields: {} }],
    }), { headers: { "content-type": "application/json", "cache-control": "public, max-age=300" } });
  }

  const m = TILE_RE.exec(url.pathname);
  if (!m) return null;
  const [z, x, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (z > 22 || x >= 2 ** z || y >= 2 ** z) return new Response("not found", { status: 404 });
  const pm = await getArchive(bucket, keys);
  if (!pm) return new Response("not found", { status: 404 });
  const tile = await pm.getZxy(z, x, y);
  // URLs carrying the live build (?v=) never change, so they can be cached for a long time.
  const cache = url.searchParams.has("v") ? "public, max-age=604800, immutable" : "public, max-age=3600";
  if (!tile || tile.data.byteLength === 0) return new Response(null, { status: 204, headers: { "cache-control": cache } });
  // Content-Encoding makes the Workers runtime gzip the tile on the way out (about 3x smaller).
  return new Response(tile.data, {
    headers: { "content-type": "application/vnd.mapbox-vector-tile", "content-encoding": "gzip", "cache-control": cache, vary: "accept-encoding" },
  });
}
