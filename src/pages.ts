// HTML page metadata (titles, descriptions, link previews) and sitemap.xml.
const SITE = "https://treenerd.fyi";
const DEFAULT_DESC = "Explore every one of Singapore's ~890,000 trees. Search by road, park, area, postal code or species.";

// Must match public/_headers (static assets get theirs from that file).
export const PAGE_HEADERS: Record<string, string> = {
  "content-security-policy": "default-src 'none'; script-src 'self' https://static.cloudflareinsights.com; worker-src 'self' blob:; child-src blob:; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob: https://www.onemap.gov.sg; connect-src 'self' https://www.onemap.gov.sg https://cloudflareinsights.com; font-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; upgrade-insecure-requests",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "geolocation=(self), camera=(), microphone=(), payment=(), usb=()",
  "cross-origin-opener-policy": "same-origin",
};

const KIND_LABEL: Record<string, string> = {
  road: "Road", park: "Park", subzone: "Subzone", planning_area: "Planning area", pcn: "Park connector",
  constituency: "Constituency", heritage_road: "Heritage road",
};
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,119}$/;
const fmt = new Intl.NumberFormat("en-SG");

interface Meta { title: string; description: string; url: string }

/** Title/description for a shared or crawled URL, from the database. Falls back to the defaults. */
export async function pageMeta(db: D1Database, url: URL): Promise<Meta> {
  const base = { title: "TreeNerd · Every tree in Singapore", description: DEFAULT_DESC, url: `${SITE}/` };
  try {
    const p = url.searchParams.get("p"), s = url.searchParams.get("s"), t = url.searchParams.get("t");
    if (t && /^\d{1,12}$/.test(t)) {
      const r = await db.prepare(
        `SELECT t.girth_m, t.height_band, sp.common, sp.scientific, rd.name road, pk.name park
           FROM trees t LEFT JOIN species sp ON sp.id=t.species_id
           LEFT JOIN places rd ON rd.id=t.road_id LEFT JOIN places pk ON pk.id=t.park_id WHERE t.id=?`,
      ).bind(Number(t)).first<Record<string, string | number | null>>();
      if (r) {
        const name = String(r.common ?? r.scientific ?? "Tree");
        const where = r.road ?? r.park;
        const facts = [r.scientific && r.common ? `${r.scientific}` : "", r.girth_m ? `girth ${Number(r.girth_m).toFixed(1)} m` : "",
          r.height_band ? `${r.height_band} m tall` : ""].filter(Boolean).join(", ");
        return { title: `${name}${where ? ` on ${where}` : ""} · TreeNerd`,
          description: `${name}${where ? ` on ${where}` : ""}${facts ? ` (${facts})` : ""}. Explore every tree in Singapore on TreeNerd.`,
          url: `${SITE}/?t=${t}` };
      }
    }
    if (p) {
      const [kind, slug] = [p.split("/")[0], p.split("/").slice(1).join("/")];
      if (KIND_LABEL[kind] && SLUG_RE.test(slug)) {
        const r = await db.prepare("SELECT name, tree_count, species_count, top_species FROM places WHERE kind=? AND slug=?")
          .bind(kind, slug).first<{ name: string; tree_count: number; species_count: number; top_species: string }>();
        if (r) {
          const ids = (JSON.parse(r.top_species || "[]") as [number, number][]).slice(0, 3).map(([id]) => id);
          const names = ids.length
            ? (await db.prepare(`SELECT id, common, scientific FROM species WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids)
              .all<{ id: number; common: string | null; scientific: string }>()).results
            : [];
          const top = ids.map((id) => names.find((n) => n.id === id)).filter(Boolean).map((n) => n!.common ?? n!.scientific);
          return { title: `${r.name} trees · TreeNerd`,
            description: `${r.name} (${KIND_LABEL[kind].toLowerCase()}): ${fmt.format(r.tree_count)} trees, ${fmt.format(r.species_count)} species${top.length ? `. Most common: ${top.join(", ")}` : ""}.`,
            url: `${SITE}/?p=${kind}/${slug}` };
        }
      }
    }
    if (s && /^\d{1,12}$/.test(s)) {
      const r = await db.prepare("SELECT common, scientific, family, tree_count FROM species WHERE id=?").bind(Number(s))
        .first<{ common: string | null; scientific: string; family: string | null; tree_count: number }>();
      if (r) {
        const name = r.common ?? r.scientific;
        const plural = /tree$/i.test(name) ? `${name}s` : `${name} trees`;
        return { title: `${plural} in Singapore · TreeNerd`,
          description: `${name}${r.common ? ` (${r.scientific})` : ""}${r.family ? `, ${r.family}` : ""}: ${fmt.format(r.tree_count)} trees in Singapore. See where they grow.`,
          url: `${SITE}/?s=${s}` };
      }
    }
  } catch { /* database not ready: use defaults */ }
  return base;
}

/** Inject page metadata into the static index.html. */
export function withMeta(res: Response, meta: Meta) {
  return new HTMLRewriter()
    .on("title", { element(e) { e.setInnerContent(meta.title); } })
    .on('meta[name="description"]', { element(e) { e.setAttribute("content", meta.description); } })
    .on('meta[property="og:title"]', { element(e) { e.setAttribute("content", meta.title); } })
    .on('meta[property="og:description"]', { element(e) { e.setAttribute("content", meta.description); } })
    .on('meta[property="og:url"]', { element(e) { e.setAttribute("content", meta.url); } })
    .on('meta[name="twitter:title"]', { element(e) { e.setAttribute("content", meta.title); } })
    .on('meta[name="twitter:description"]', { element(e) { e.setAttribute("content", meta.description); } })
    .on('link[rel="canonical"]', { element(e) { e.setAttribute("href", meta.url); } })
    .transform(res);
}

const xmlEsc = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]!));

/** Sitemap of the home page plus every place and species with trees. */
export async function sitemap(db: D1Database, lastmod: string | null) {
  const urls: string[] = [`${SITE}/`];
  try {
    const places = await db.prepare("SELECT kind, slug FROM places WHERE tree_count >= 5 ORDER BY tree_count DESC").all<{ kind: string; slug: string }>();
    for (const r of places.results) urls.push(`${SITE}/?p=${r.kind}/${r.slug}`);
    const species = await db.prepare("SELECT id FROM species WHERE tree_count >= 5 ORDER BY tree_count DESC").all<{ id: number }>();
    for (const r of species.results) urls.push(`${SITE}/?s=${r.id}`);
  } catch { /* database not ready */ }
  const mod = lastmod ? `<lastmod>${xmlEsc(lastmod.slice(0, 10))}</lastmod>` : "";
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
    urls.slice(0, 50000).map((u) => `<url><loc>${xmlEsc(u)}</loc>${mod}</url>`).join("\n")}\n</urlset>\n`;
  return new Response(body, { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=86400" } });
}
