// Serve vector tiles as ordinary small requests (/tiles/{z}/{x}/{y}.mvt) by reading the PMTiles
// archive in R2 on the server. Browsers then never need HTTP Range requests, which some corporate
// proxies and web filters strip, rewrite or block.
import { PMTiles, type RangeResponse, type Source } from "pmtiles";

const KEY = "trees.pmtiles";

/** PMTiles source backed by an R2 object, pinned to one version (etag) of the archive. */
class R2Source implements Source {
  constructor(private bucket: R2Bucket, private etag: string) {}

  getKey() {
    return `r2:${KEY}:${this.etag}`;
  }

  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const obj = await this.bucket.get(KEY, { range: { offset, length }, onlyIf: { etagMatches: this.etag } });
    if (!obj || !("body" in obj)) throw new Error("tile archive changed or missing");
    return { data: await obj.arrayBuffer(), etag: obj.etag };
  }
}

let archive: { etag: string; pmtiles: PMTiles } | null = null;

/** One PMTiles reader per isolate, rebuilt when a new archive is uploaded. */
async function getArchive(bucket: R2Bucket) {
  const head = await bucket.head(KEY);
  if (!head) return null;
  if (archive?.etag !== head.etag) archive = { etag: head.etag, pmtiles: new PMTiles(new R2Source(bucket, head.etag)) };
  return archive.pmtiles;
}

const TILE_RE = /^\/tiles\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.mvt$/;

/** GET /tiles/trees.json (TileJSON) and /tiles/{z}/{x}/{y}.mvt. Returns null for other paths. */
export async function serveTiles(url: URL, bucket: R2Bucket): Promise<Response | null> {
  if (url.pathname === "/tiles/trees.json") {
    const pm = await getArchive(bucket);
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
  const pm = await getArchive(bucket);
  if (!pm) return new Response("not found", { status: 404 });
  const tile = await pm.getZxy(z, x, y);
  // Versioned URLs (?v=build) never change, so they can be cached for a long time.
  const cache = url.searchParams.has("v") ? "public, max-age=604800, immutable" : "public, max-age=3600";
  if (!tile || tile.data.byteLength === 0) return new Response(null, { status: 204, headers: { "cache-control": cache } });
  return new Response(tile.data, { headers: { "content-type": "application/vnd.mapbox-vector-tile", "cache-control": cache } });
}
