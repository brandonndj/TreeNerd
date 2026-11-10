/* TreeNerd front end: MapLibre + the Worker API. No build step. */
const $ = (s, el = document) => el.querySelector(s);
const fmt = new Intl.NumberFormat("en-SG");
/** Only allow https links from data into href attributes. */
const safeUrl = (u) => { try { const x = new URL(u); return x.protocol === "https:" ? x.href : null; } catch { return null; } };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = (s) => { const d = new Date(s); return isNaN(d) ? "" : d.toLocaleDateString("en-SG", { day: "numeric", month: "short", year: "numeric" }); };

const CATS = [
  { code: 1, key: "street", label: "Street trees" },
  { code: 2, key: "park", label: "Park trees" },
  { code: 3, key: "botanic", label: "Botanic Gardens" },
  { code: 5, key: "conservation", label: "Conservation" },
  { code: 6, key: "heritage", label: "Heritage" },
  { code: 4, key: "user", label: "Planted by public" },
  { code: 0, key: "other", label: "Other" },
];
const KIND_LABEL = {
  road: "Road", park: "Park", subzone: "Subzone", planning_area: "Planning area", pcn: "Park connector",
  constituency: "Constituency", heritage_road: "Heritage road", species: "Species", address: "Address", mrt: "Station",
};
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const catColor = (key) => css(`--c-${key}`);
const isPhone = () => innerWidth <= 720;

// ------------------------------------------------------------------ dev preview banner (dev.treenerd.fyi)
if (location.hostname.startsWith("dev.")) {
  document.documentElement.classList.add("is-dev");
  document.title = `[DEV] ${document.title}`;
  const bar = document.createElement("div");
  bar.className = "dev-banner"; bar.setAttribute("role", "note");
  const live = document.createElement("a");
  const liveUrl = () => `https://treenerd.fyi/${location.search}${location.hash}`;
  live.href = liveUrl();
  live.addEventListener("click", () => { live.href = liveUrl(); }); // the same view as now, not as first loaded
  live.textContent = "Open the live site";
  bar.append("DEV PREVIEW · not the live site · ", live);
  document.body.prepend(bar);
}

// ------------------------------------------------------------------ theme: follows the device until toggled
// "auto" = follow the device. Clicking switches to the opposite of what's showing; switching back to
// what the device uses returns to "auto", so later device changes are followed again.
const svg = (d) => `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">${d}</svg>`;
const SUN = svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>');
const MOON = svg('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>');
const systemDark = matchMedia("(prefers-color-scheme: dark)");
let theme = (() => { try { return localStorage.getItem("theme") || "auto"; } catch { return "auto"; } })();
if (!["auto", "light", "dark"].includes(theme)) theme = "auto";
const dark = () => theme === "dark" || (theme === "auto" && systemDark.matches);
function applyThemeAttr() {
  if (theme === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  const btn = $("#theme");
  btn.innerHTML = dark() ? SUN : MOON; // shows what a tap switches to
  btn.title = dark() ? "Switch to light mode" : "Switch to dark mode";
  btn.setAttribute("aria-label", btn.title);
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.content = dark() ? "#0f1411" : "#f6f7f4";
}
applyThemeAttr();

/** Tree types to show: all of them, unless the link carries ?c=1,2,… */
function catsFromUrl() {
  const all = CATS.map((c) => c.code);
  const raw = new URL(location.href).searchParams.get("c");
  if (raw == null) return new Set(all);
  return new Set(raw.split(",").map(Number).filter((n) => all.includes(n)));
}
const state = {
  cats: catsFromUrl(),
  highlight: null,        // maplibre expression selecting highlighted trees
  place: null, species: null, tree: null,
  meta: null, speciesDict: {}, sheet: "half",
};

async function api(path) {
  const r = await fetch(path);
  if (r.status === 429) throw new Error("Too many requests. Please try again in a minute.");
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}
function toast(msg, ms = 3500) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms);
}

// Was a map view in the URL when the page opened? (maplibre writes its own hash on load)
const INITIAL_VIEW = location.hash.includes("map=");

// ------------------------------------------------------------------ map

const tileUrl = (style) => `https://www.onemap.gov.sg/maps/tiles/${style}/{z}/{x}/{y}.png`;
// The area OneMap actually draws (it clips Johor to a rectangle). The view is kept inside it, so its edges never show
// (on very wide screens this also limits how far you can zoom out).
const BASEMAP_AREA = [[103.582, 1.15], [104.164, 1.4935]];
// At map zoom < 11.5 OneMap's tiles include a "Pedra Branca, not to scale" inset box off Marina Parade; paint sea over it.
const INSET_MASK = [[103.9159, 1.24273, 104.00002, 1.29422], [103.908, 1.25097, 103.9159, 1.29147],
  [103.93478, 1.29422, 103.9698, 1.30211], [103.93616, 1.23449, 103.97118, 1.24273]];
const seaColor = () => (dark() ? "#033046" : "#d4d4d3"); // OneMap sea as drawn over the background
const map = new maplibregl.Map({
  container: "map",
  hash: "map",
  center: [103.8198, 1.3521], zoom: 11.3, minZoom: 10.5, maxZoom: 20,
  maxBounds: BASEMAP_AREA,
  attributionControl: false,
  dragRotate: false, pitchWithRotate: false, touchPitch: false,
  style: {
    version: 8,
    sources: {
      base: {
        type: "raster", tileSize: 256, minzoom: 11, maxzoom: 19, tiles: [tileUrl(dark() ? "Night" : "Grey")],
        bounds: BASEMAP_AREA.flat(),
        attribution: '<img src="https://www.onemap.gov.sg/web-assets/images/logo/om_logo.png" alt="" style="height:16px;width:16px;vertical-align:-3px"/> <a href="https://www.onemap.gov.sg/" target="_blank" rel="noopener noreferrer">OneMap</a> © contributors | <a href="https://www.sla.gov.sg/" target="_blank" rel="noopener noreferrer">Singapore Land Authority</a>',
      },
      "inset-mask": { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "MultiPolygon",
        coordinates: INSET_MASK.map(([w, so, e, n]) => [[[w, so], [e, so], [e, n], [w, n], [w, so]]]) } } },
    },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": dark() ? "#0f1411" : "#eef0ea" } },
      { id: "base", type: "raster", source: "base", paint: { "raster-opacity": dark() ? 0.8 : 0.9 } },
      { id: "inset-mask", type: "fill", source: "inset-mask", maxzoom: 11.5, paint: { "fill-color": seaColor(), "fill-antialias": false } },
    ],
  },
});
map.touchZoomRotate.disableRotation();
map.addControl(new maplibregl.AttributionControl({
  compact: true,
  customAttribution: 'Trees: <a href="https://treessg.nparks.gov.sg" target="_blank" rel="noopener noreferrer">Trees.sg</a> © NParks · Roads © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> · data.gov.sg',
}), "bottom-right");
// Zoom buttons only where there's no pinch-to-zoom.
if (!matchMedia("(pointer: coarse)").matches) map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");

function colorExpr() {
  return ["match", ["get", "c"], ...CATS.flatMap((c) => [c.code, catColor(c.key)]), catColor("other")];
}
function radiusExpr() {
  const g = ["coalesce", ["get", "g"], 40]; // girth in cm
  const touch = matchMedia("(pointer: coarse)").matches ? 1.3 : 1; // slightly bigger dots for fingers
  return ["interpolate", ["linear"], ["zoom"],
    11, ["case", ["==", ["get", "c"], 6], 2.5, 0.8],
    14, ["case", ["==", ["get", "c"], 6], 5, 2 * touch],
    17, ["*", touch, ["+", 2.5, ["/", ["min", g, 400], 45]]],
    20, ["*", touch, ["+", 6, ["/", ["min", g, 400], 14]]]];
}
function filterExpr() {
  return ["in", ["get", "c"], ["literal", [...state.cats]]];
}
function opacityExpr() {
  if (!state.highlight) return ["interpolate", ["linear"], ["zoom"], 11, 0.55, 15, 0.85];
  return ["case", state.highlight, 0.95, 0.08];
}

map.on("load", async () => {
  // start with the attribution collapsed behind its (i) button
  const attrib = document.querySelector(".maplibregl-ctrl-attrib");
  attrib?.classList.remove("maplibregl-compact-show");
  attrib?.removeAttribute("open");

  const meta = await api("/api/meta").catch(() => null);
  state.meta = meta;
  const v = encodeURIComponent(meta?.built_at || "dev");
  // Tiles are served one by one by the Worker (no HTTP Range requests, which some corporate proxies break).
  map.addSource("trees", { type: "vector", url: `${location.origin}/tiles/trees.json?v=${v}`, promoteId: "id" });
  map.addLayer({
    id: "trees", type: "circle", source: "trees", "source-layer": "trees", filter: filterExpr(),
    layout: { "circle-sort-key": ["-", 0, ["coalesce", ["get", "g"], 0]] }, // smaller girth drawn on top
    paint: {
      "circle-color": colorExpr(), "circle-radius": radiusExpr(), "circle-opacity": opacityExpr(),
      "circle-stroke-color": dark() ? "#0f1411" : "#ffffff",
      "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 14, 0, 16, 0.6, 18, 1.2],
      "circle-stroke-opacity": opacityExpr(),
    },
  });
  map.addSource("sel", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "sel", type: "circle", source: "sel", paint: {
    "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 8, 18, 18], "circle-color": "transparent",
    "circle-stroke-width": 3, "circle-stroke-color": css("--accent") } });
  map.addSource("near", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "near", type: "line", source: "near", paint: { "line-color": css("--accent"), "line-width": 2, "line-dasharray": [2, 2] } });
  buildLegend();
  fetch(`/data/species.json?v=${v}`).then((r) => r.ok && r.json()).then((d) => d && (state.speciesDict = d));
  wireMapEvents();
  restoreFromUrl();
});

function refreshMapTheme() {
  applyThemeAttr();
  if (!map.getLayer("bg")) return;
  map.getSource("base").setTiles([tileUrl(dark() ? "Night" : "Grey")]);
  map.setPaintProperty("bg", "background-color", dark() ? "#0f1411" : "#eef0ea");
  map.setPaintProperty("base", "raster-opacity", dark() ? 0.8 : 0.9);
  map.setPaintProperty("inset-mask", "fill-color", seaColor());
  if (map.getLayer("trees")) {
    map.setPaintProperty("trees", "circle-color", colorExpr());
    map.setPaintProperty("trees", "circle-stroke-color", dark() ? "#0f1411" : "#ffffff");
    map.setPaintProperty("sel", "circle-stroke-color", css("--accent"));
    map.setPaintProperty("near", "line-color", css("--accent"));
    buildLegendItems();
  }
}
$("#theme").addEventListener("click", () => {
  const next = dark() ? "light" : "dark";
  theme = next === (systemDark.matches ? "dark" : "light") ? "auto" : next;
  try { theme === "auto" ? localStorage.removeItem("theme") : localStorage.setItem("theme", theme); } catch { /* private mode */ }
  refreshMapTheme();
});
systemDark.addEventListener("change", () => theme === "auto" && refreshMapTheme());

function setHighlight(expr) {
  state.highlight = expr;
  if (!map.getLayer("trees")) return;
  map.setPaintProperty("trees", "circle-opacity", opacityExpr());
  map.setPaintProperty("trees", "circle-stroke-opacity", opacityExpr());
}
function selectPoint(lngLat) {
  map.getSource("sel")?.setData({ type: "FeatureCollection", features: lngLat ? [{ type: "Feature", geometry: { type: "Point", coordinates: lngLat }, properties: {} }] : [] });
}
function fitBbox(b, maxZoom = 17) {
  if (!b) return;
  map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: panelPadding(), maxZoom, duration: 900 });
}
function panelPadding() {
  if (!isPhone()) return { top: 90, bottom: 40, left: 430, right: 60 };
  const sheet = panel.hidden ? 0 : panel.getBoundingClientRect().height;
  return { top: 80, bottom: Math.min(sheet + 20, innerHeight - 160), left: 30, right: 30 };
}

function wireMapEvents() {
  const hover = $("#hover");
  map.on("mousemove", "trees", (e) => {
    if (matchMedia("(pointer: coarse)").matches) return;
    const f = e.features[0];
    map.getCanvas().style.cursor = "pointer";
    const s = state.speciesDict[f.properties.s];
    hover.innerHTML = `<b>${esc(s?.n || s?.sci || "Tree")}</b>${s?.sci && s?.n ? `<br><i>${esc(s.sci)}</i>` : ""}` +
      (f.properties.g ? `<br><span class="muted">Girth ${(f.properties.g / 100).toFixed(1)} m</span>` : "");
    hover.style.left = `${e.originalEvent.clientX + 14}px`;
    hover.style.top = `${e.originalEvent.clientY + 14}px`;
    hover.hidden = false;
  });
  map.on("mouseleave", "trees", () => { map.getCanvas().style.cursor = ""; hover.hidden = true; });
  map.on("click", (e) => {
    const cands = treesAt(e.point);
    if (!cands.length) {
      if (isPhone() && !panel.hidden) setSheet("peek");
      else if (!isPhone() && !state.place && !state.species) closePanel();
      return;
    }
    // trees that are about as close to the tap as the nearest one: the tap is ambiguous between them
    const tied = cands.filter((c) => c.d <= cands[0].d + TIE_PX);
    if (tied.length === 1) return openTree(cands[0].id, true, true);
    if (map.getZoom() < 17) {
      // too zoomed out to tell them apart: zoom in on the spot instead of guessing
      return map.easeTo({ center: e.lngLat, zoom: Math.min(map.getZoom() + 2.5, 18.5), duration: 500 });
    }
    showTreesHere(tied.slice(0, 8));
  });
}

const TIE_PX = 6;
/** Trees under/near a screen point, nearest first (by distance to the tree's centre, not its size). */
function treesAt(point) {
  const r = matchMedia("(pointer: coarse)").matches ? 16 : 8;
  const feats = map.queryRenderedFeatures([[point.x - r, point.y - r], [point.x + r, point.y + r]], { layers: ["trees"] });
  const byId = new Map();
  for (const f of feats) {
    const id = f.properties.id;
    if (byId.has(id)) continue; // the same tree can appear in two tiles
    const c = map.project(f.geometry.coordinates);
    byId.set(id, { id, d: Math.hypot(c.x - point.x, c.y - point.y), s: f.properties.s, g: f.properties.g, h: f.properties.h,
      lngLat: f.geometry.coordinates });
  }
  return [...byId.values()].sort((a, b) => a.d - b.d);
}

/** Several trees on (almost) the same spot: let the person pick. */
function showTreesHere(trees) {
  selectPoint(trees[0].lngLat);
  openPanel(`
    <h2>${trees.length} trees here</h2>
    <p class="sub">They're too close together to tell apart. Pick one:</p>
    <ul class="list">${trees.map((t) => {
      const sp = state.speciesDict[t.s];
      return `<li><button data-id="${Number(t.id)}"><span>${esc(sp?.n || sp?.sci || "Tree")}${sp?.n && sp?.sci ? ` <span class="muted sci">${esc(sp.sci)}</span>` : ""}</span>
        <span class="meta">${[t.g ? `${(t.g / 100).toFixed(1)} m girth` : "", t.h ? `≤${Number(t.h)} m tall` : "", `#${Number(t.id)}`].filter(Boolean).join(" · ")}</span></button></li>`;
    }).join("")}</ul>`, { sheet: "half" });
  map.easeTo({ center: trees[0].lngLat, padding: panelPadding(), duration: 400 }); // keep the spot visible above the sheet
  body.querySelectorAll("button[data-id]").forEach((b) => b.addEventListener("click", () => openTree(Number(b.dataset.id), false, true)));
}

// ------------------------------------------------------------------ legend
function buildLegendItems() {
  const counts = state.meta?.category_counts || {};
  $("#legend-items").innerHTML = CATS.filter((c) => counts[c.key] || !state.meta).map((c) => `
    <label><input type="checkbox" data-c="${c.code}" ${state.cats.has(c.code) ? "checked" : ""}>
      <span class="dot" style="background:${catColor(c.key)}"></span>${c.label}
      <span class="n">${counts[c.key] ? fmt.format(counts[c.key]) : ""}</span></label>`).join("");
}
function buildLegend() {
  $("#total").textContent = state.meta?.tree_count ? `· ${fmt.format(state.meta.tree_count)} trees` : "";
  // Updates run weekly. If the data is clearly older than that, say so rather than look current.
  const age = state.meta?.built_at ? (Date.now() - Date.parse(state.meta.built_at)) / 86400e3 : 0;
  state.stale = age > 10;
  $("#updated").textContent = state.meta?.built_at ? `Updated ${fmtDate(state.meta.built_at)}${state.stale ? " · update overdue" : ""}` : "";
  $("#updated").classList.toggle("stale", state.stale);
  buildLegendItems();
  $("#legend-items").addEventListener("change", (e) => {
    const c = Number(e.target.dataset.c);
    e.target.checked ? state.cats.add(c) : state.cats.delete(c);
    map.setFilter("trees", filterExpr());
    const u = new URL(location.href); // keep the choice in the link, so a shared link shows the same trees
    if (state.cats.size === CATS.length) u.searchParams.delete("c");
    else u.searchParams.set("c", [...state.cats].sort().join(","));
    history.replaceState(null, "", u);
  });
  const lg = $("#legend"), tg = $("#legend-toggle");
  const setCollapsed = (v, remember) => {
    lg.classList.toggle("collapsed", v);
    tg.setAttribute("aria-expanded", String(!v));
    tg.title = v ? "Show the tree types" : "Hide the tree types";
    if (remember) { try { localStorage.setItem("legend", v ? "closed" : "open"); } catch { /* private mode */ } }
  };
  let saved = null;
  try { saved = localStorage.getItem("legend"); } catch { /* private mode */ }
  setCollapsed(saved ? saved === "closed" : isPhone(), false); // phones start closed, desktops open
  tg.addEventListener("click", () => setCollapsed(!lg.classList.contains("collapsed"), true));
}

// ------------------------------------------------------------------ search
const q = $("#q"), results = $("#results");
let active = -1, items = [], searchSeq = 0;
q.addEventListener("input", () => {
  $("#clear").hidden = !q.value;
  clearTimeout(q.t);
  q.t = setTimeout(runSearch, 150);
});
q.addEventListener("keydown", (e) => {
  if (results.hidden) return;
  if ((e.key === "ArrowDown" || e.key === "ArrowUp") && items.length) {
    e.preventDefault();
    active = (active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    const opts = [...results.querySelectorAll("li[role=option]")];
    opts.forEach((li, i) => li.setAttribute("aria-selected", i === active));
    q.setAttribute("aria-activedescendant", opts[active].id);
    opts[active].scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter" && items.length) {
    choose(items[Math.max(active, 0)]);
  } else if (e.key === "Escape") hideResults();
});
q.addEventListener("focus", () => (q.value.trim().length < 2 ? showSuggestions() : items.length && showResults()));
document.addEventListener("click", (e) => !e.target.closest(".search") && hideResults());
$("#clear").addEventListener("click", () => { q.value = ""; $("#clear").hidden = true; hideResults(); q.focus(); showSuggestions(); });

/** With nothing typed, offer the rankings as a starting point. */
const SUGGESTIONS = [
  { kind: "top", top: "road", name: "Roads with the most trees" },
  { kind: "top", top: "park", name: "Parks with the most trees" },
  { kind: "top", top: "planning_area", name: "Areas with the most trees" },
  { kind: "top", top: "tree", name: "Widest tree trunks in Singapore" },
  { kind: "top", top: "changes", name: "Trees added and removed lately", badge: "New" },
];
function showSuggestions() {
  items = SUGGESTIONS; active = -1;
  results.innerHTML = `<li class="group" role="presentation">Explore</li>` + items.map((r, i) => `
    <li role="option" id="opt-${i}" aria-selected="false"><span class="badge">${r.badge || "Top"}</span><span class="r-name">${esc(r.name)}</span></li>`).join("");
  wireResults();
  showResults();
}
function wireResults() {
  [...results.querySelectorAll("li[role=option]")].forEach((li, i) => li.addEventListener("click", () => choose(items[i])));
}

const looksLikeAddress = (t) => /\d/.test(t) || /^(blk|block)\b/i.test(t);

async function runSearch() {
  const text = q.value.trim();
  if (text.length < 2) { ++searchSeq; return document.activeElement === q ? showSuggestions() : hideResults(); }
  const seq = ++searchSeq;
  const addressFirst = looksLikeAddress(text);
  const geocode = () => (text.length >= 3 ? api(`/api/geocode?q=${encodeURIComponent(text)}`).catch(() => ({ results: [] })) : Promise.resolve({ results: [] }));
  const geoP = addressFirst ? geocode() : null; // start early when it's probably an address
  let local = { results: [] };
  try { local = await api(`/api/search?q=${encodeURIComponent(text)}`); }
  catch (e) { if (!addressFirst) toast(e.message); }
  if (seq !== searchSeq) return;
  renderResults(text, local.results, [], addressFirst);
  // look up buildings/addresses too when local matches are thin
  const geo = geoP ? await geoP : (local.results.length < 5 ? await geocode() : { results: [] });
  if (seq !== searchSeq || !geo.results.length) return;
  renderResults(text, local.results, geo.results, addressFirst);
}
function renderResults(text, local, addresses, addressFirst) {
  const addr = addresses.map((a) => ({ ...a, kind: "address" }));
  items = addressFirst ? [...addr, ...local].slice(0, 12) : [...local.slice(0, 8), ...addr].slice(0, 12);
  active = -1;
  results.innerHTML = items.length ? items.map((r, i) => r.kind === "address" ? `
      <li role="option" id="opt-${i}" aria-selected="false">
        <span class="badge addr">${r.postal ? "Postal" : "Address"}</span>
        <span class="r-name">${esc(r.name)}<span class="r-alt">${esc(r.address)}</span></span></li>` : `
      <li role="option" id="opt-${i}" aria-selected="false">
        <span class="badge">${esc(KIND_LABEL[r.kind] || r.kind)}</span>
        <span class="r-name">${esc(r.name)}${r.kind === "species" && r.alt?.[0] ? `<span class="r-alt">${esc(r.alt[0])}</span>` : ""}</span>
        <span class="r-count">${fmt.format(r.count)}</span></li>`).join("")
    : `<li class="empty" role="status">No matches for “${esc(text)}”</li>`;
  wireResults();
  showResults();
}
function showResults() { results.hidden = false; q.setAttribute("aria-expanded", "true"); q.removeAttribute("aria-activedescendant"); }
function hideResults() { results.hidden = true; q.setAttribute("aria-expanded", "false"); q.removeAttribute("aria-activedescendant"); }
function choose(r) {
  hideResults();
  if (r.kind === "top") { q.blur(); return r.top === "changes" ? openChanges() : openTop(r.top); }
  q.value = r.name; $("#clear").hidden = false; q.blur();
  if (r.kind === "address") nearby(r.lat, r.lng, 150, { title: r.name, sub: r.address });
  else if (r.kind === "mrt") nearby(r.lat, r.lng, 250, { title: r.name, sub: "Station" });
  else if (r.kind === "species") openSpecies(r.slug);
  else openPlace(r.kind, r.slug, r.bbox);
}

// ------------------------------------------------------------------ panel / bottom sheet
const panel = $("#panel"), body = $("#panel-body"), handle = $("#handle");
const SHEET_ORDER = ["peek", "half", "full"];
function sheetHeight(mode) {
  return { peek: 150, half: Math.round(innerHeight * 0.5), full: innerHeight }[mode];
}
function setSheet(mode) {
  state.sheet = mode;
  panel.style.setProperty("--sheet-h", `${sheetHeight(mode)}px`);
  requestAnimationFrame(() => document.documentElement.style.setProperty("--sheet-offset",
    panel.hidden ? "0px" : `${panel.getBoundingClientRect().height}px`));
  if (mode !== "full") panel.scrollTop = 0;
}
function openPanel(html, { sheet } = {}) {
  const wasHidden = panel.hidden;
  body.innerHTML = html; panel.hidden = false; panel.scrollTop = 0;
  document.body.classList.add("panel-open");
  if (isPhone() && (wasHidden || sheet || state.sheet === "peek")) setSheet(sheet || "half");
  requestAnimationFrame(() => map.triggerRepaint()); // some GPUs leave a stale canvas under new overlays
}
function closePanel() {
  navSeq++;
  panel.hidden = true; document.body.classList.remove("panel-open");
  document.documentElement.style.setProperty("--sheet-offset", "0px");
  state.place = state.species = state.tree = null;
  setHighlight(null); selectPoint(null);
  map.getSource("near")?.setData({ type: "FeatureCollection", features: [] });
  setUrl({});
}
$("#close").addEventListener("click", closePanel);
document.addEventListener("keydown", (e) => e.key === "Escape" && !panel.hidden && document.activeElement !== q && closePanel());
addEventListener("resize", () => isPhone() && !panel.hidden && setSheet(state.sheet));

// drag the handle to resize; tap it to toggle half/full; flick down to close
(() => {
  let start = null;
  handle.addEventListener("pointerdown", (e) => {
    if (!isPhone()) return;
    start = { y: e.clientY, h: panel.getBoundingClientRect().height, t: performance.now() };
    handle.setPointerCapture(e.pointerId);
    panel.classList.add("dragging");
  });
  handle.addEventListener("pointermove", (e) => {
    if (!start) return;
    const h = Math.max(80, Math.min(innerHeight, start.h + (start.y - e.clientY)));
    panel.style.setProperty("--sheet-h", `${h}px`);
  });
  const end = (e) => {
    if (!start) return;
    panel.classList.remove("dragging");
    const dy = start.y - e.clientY, dt = performance.now() - start.t, v = dy / Math.max(dt, 1);
    const h = panel.getBoundingClientRect().height;
    start = null;
    if (Math.abs(dy) < 6) return setSheet(state.sheet === "full" ? "half" : "full"); // tap
    if (v < -0.8 && state.sheet === "peek") return closePanel();                    // flick down from peek
    if (Math.abs(v) > 0.5) {                                                           // flick: next snap in that direction
      const i = SHEET_ORDER.indexOf(state.sheet) + (v > 0 ? 1 : -1);
      return i < 0 ? closePanel() : setSheet(SHEET_ORDER[Math.min(i, 2)]);
    }
    if (h < sheetHeight("peek") - 50) return closePanel();
    setSheet(SHEET_ORDER.reduce((a, b) => (Math.abs(sheetHeight(b) - h) < Math.abs(sheetHeight(a) - h) ? b : a)));
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
  handle.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSheet(state.sheet === "full" ? "half" : "full"); }
  });
})();

/**
 * Put what's open into the link. Opening something new adds a history entry, so the browser's
 * Back button returns to the previous place / tree / list; re-rendering the same thing doesn't.
 */
function setUrl(params) {
  const u = new URL(location.href);
  for (const k of ["p", "s", "t", "q", "near", "n", "top"]) u.searchParams.delete(k);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  if (u.search === location.search) history.replaceState(null, "", u);
  else history.pushState(null, "", u);
}
// Back / Forward: show whatever that link describes (the map view comes back through its #map= part).
addEventListener("popstate", () => {
  const sp = new URL(location.href).searchParams;
  if (["p", "s", "t", "near", "top"].some((k) => sp.has(k))) restoreFromUrl(true);
  else if (!panel.hidden) closePanel();
});
function restoreFromUrl(hasView = INITIAL_VIEW) {
  const u = new URL(location.href);
  const p = u.searchParams.get("p"), s = u.searchParams.get("s"), t = u.searchParams.get("t");
  const top = u.searchParams.get("top");
  if (top === "changes") return openChanges();
  if (top) { const [kind, by] = top.split(":"); return openTop(kind, by); }
  if (!p && !s) state.place = state.species = null;
  if (!t) selectPoint(null);
  if (!u.searchParams.has("near")) map.getSource("near")?.setData({ type: "FeatureCollection", features: [] });
  const near = (u.searchParams.get("near") || "").split(",").map(Number);
  if (near.length >= 2 && near.every(Number.isFinite)) {
    const name = (u.searchParams.get("n") || "").slice(0, 80);
    return nearby(near[0], near[1], [100, 150, 250, 500].includes(near[2]) ? near[2] : 150, name ? { title: name, sub: "" } : null);
  }
  const query = (u.searchParams.get("q") || "").slice(0, 100);
  if (query && !p && !s && !t) { q.value = query; $("#clear").hidden = false; runSearch(); return; }
  if (p) { const [kind, ...slug] = p.split("/"); openPlace(kind, slug.join("/"), null, !hasView); }
  else if (s) openSpecies(s, !hasView);
  if (t) openTree(Number(t), !hasView && !p && !s);
}

const statTile = (value, label) => `<div class="stat"><b>${value}</b><span>${label}</span></div>`;
const tonnes = (kg) => (kg >= 1000 ? `${fmt.format(Math.round(kg / 1000))} t` : `${fmt.format(Math.round(kg || 0))} kg`);

function barList(rows, total, { onclick, active } = {}) {
  const max = Math.max(...rows.map((r) => r.n), 1);
  return `<div class="bars">${rows.map((r, i) => `
    <${onclick ? "button" : "div"} class="bar ${active === r.id ? "on" : ""}" ${onclick ? `data-i="${i}"` : ""}>
      <span>${esc(r.label)}${r.sub ? ` <span class="muted sci">${esc(r.sub)}</span>` : ""}</span>
      <span class="n">${fmt.format(r.n)}${total ? ` · ${Math.round((r.n / total) * 100)}%` : ""}</span>
      <span class="track"><span class="fill" style="width:${(r.n / max) * 100}%"></span></span>
    </${onclick ? "button" : "div"}>`).join("")}</div>`;
}
function categoryStack(cats, total) {
  const byKey = Object.fromEntries(cats.map((c) => [c.k, c.n]));
  const present = CATS.filter((c) => byKey[c.key]);
  return `<div class="stack">${present.map((c) => `<span style="width:${(byKey[c.key] / total) * 100}%;background:${catColor(c.key)}" title="${c.label}"></span>`).join("")}</div>
    <div class="stack-legend">${present.map((c) => `<span><span class="dot" style="background:${catColor(c.key)}"></span>${c.label} ${fmt.format(byKey[c.key])}</span>`).join("")}</div>`;
}

function originStack(native, total) {
  const parts = [["1", "Native", "var(--c-street)"], ["0", "Non-native", "var(--c-user)"], ["null", "Unknown", "var(--c-other)"]]
    .map(([k, label, color]) => ({ label, color, n: native[k] || 0 })).filter((p) => p.n);
  return `<div class="stack">${parts.map((p) => `<span style="width:${(p.n / total) * 100}%;background:${p.color}" title="${p.label}"></span>`).join("")}</div>
    <div class="stack-legend">${parts.map((p) => `<span><span class="dot" style="background:${p.color}"></span>${p.label} ${fmt.format(p.n)}</span>`).join("")}</div>`;
}

// Only the latest thing opened may draw the panel: a slow answer to an earlier tap is dropped.
let navSeq = 0;

// ---- place (road / park / area …)
async function openPlace(kind, slug, bbox, fly = true) {
  const seq = ++navSeq;
  openPanel(`<p class="muted">Loading…</p>`, { sheet: "half" });
  let d;
  try { d = await api(`/api/place/${encodeURIComponent(kind)}/${encodeURIComponent(slug)}`); }
  catch (e) { return seq === navSeq && openPanel(`<h2>Not found</h2><p class="muted">${esc(e.message)}</p>`); }
  if (seq !== navSeq) return;
  state.place = d; state.species = null; state.placeSpecies = null;
  setUrl({ p: `${kind}/${slug}` });
  if (fly) fitBbox(d.bbox || bbox, kind === "road" ? 18 : 17);
  await highlightPlace(d);
  if (seq === navSeq) renderPlace(d);
}
async function highlightPlace(d, speciesId) {
  let expr;
  if (d.tile_key) expr = ["==", ["get", d.tile_key], d.place_id];
  else {
    const { ids } = await api(`/api/place/${encodeURIComponent(d.kind)}/${encodeURIComponent(d.slug)}/ids`);
    expr = ["in", ["get", "id"], ["literal", ids]];
  }
  if (speciesId) expr = ["all", expr, ["==", ["get", "s"], speciesId]];
  setHighlight(expr);
}
function renderPlace(d) {
  const native = Object.fromEntries((d.native || []).map((r) => [String(r.k), r.n]));
  const pct = (n) => (d.tree_count ? Math.round(((n || 0) / d.tree_count) * 100) : 0);
  const nativePct = pct(native["1"]), unknownPct = pct(native["null"]);
  const extra = d.extra || {};
  const sub = [KIND_LABEL[d.kind], extra.planning_area, extra.region].filter(Boolean).join(" · ");
  const species = d.top_species.map((s) => ({ id: s.id, n: s.n, label: s.common || s.scientific || `Species ${s.id}`, sub: s.common ? s.scientific : "" }));
  openPanel(`
    <h2>${esc(d.name)}</h2>
    <p class="sub">${esc(sub)}${d.alt?.length ? ` · ${esc(d.alt.join(" · "))}` : ""}</p>
    <div class="stats">
      ${statTile(fmt.format(d.tree_count), "trees")}
      ${statTile(fmt.format(d.species_count), "species")}
      ${statTile(`${nativePct}%`, `of trees are native species${unknownPct ? ` · ${unknownPct}% unknown origin` : ""}`)}
      ${statTile(tonnes(d.carbon_kg), "carbon stored (est.)")}
    </div>
    ${d.heritage_count ? `<div class="callout">🌟 ${d.heritage_count} heritage tree${d.heritage_count > 1 ? "s" : ""}</div>` : ""}
    ${safeUrl(extra.url) ? `<p><a href="${esc(safeUrl(extra.url))}" target="_blank" rel="noopener noreferrer">About this heritage road ↗</a></p>` : ""}
    <h3>Tree types</h3>${categoryStack(d.categories, d.tree_count)}
    <h3>Origin</h3>${originStack(native, d.tree_count)}
    <h3>Top species <span class="muted" style="text-transform:none;letter-spacing:0">· tap to filter</span></h3>
    <div id="place-species">${barList(species, d.tree_count, { onclick: true, active: state.placeSpecies })}</div>
    <h3>Largest trees</h3>
    <ul class="list" id="tree-list"></ul>
    ${changesSection(d.changes)}
    <div class="actions">
      <button class="btn" id="more">Show more</button>
      <a class="btn" href="/api/place/${encodeURIComponent(d.kind)}/${encodeURIComponent(d.slug)}/trees.csv${state.placeSpecies ? `?species=${state.placeSpecies}` : ""}" download>⬇ CSV</a>
      <button class="btn" id="share">🔗 Share</button>
    </div>`);
  $("#place-species").querySelectorAll("button.bar").forEach((b) => b.addEventListener("click", async () => {
    const id = species[Number(b.dataset.i)].id;
    state.placeSpecies = state.placeSpecies === id ? null : id;
    await highlightPlace(d, state.placeSpecies);
    renderPlace(d);
  }));
  $("#share").addEventListener("click", share);
  wireChangeRows();
  loadTreeList(d, 0);
  $("#more").addEventListener("click", () => loadTreeList(d, $("#tree-list").children.length));
}
async function loadTreeList(d, offset) {
  const sp = state.placeSpecies ? `&species=${state.placeSpecies}` : "";
  let r;
  try { r = await api(`/api/place/${encodeURIComponent(d.kind)}/${encodeURIComponent(d.slug)}/trees?limit=25&offset=${offset}${sp}`); }
  catch (e) { return toast(e.message); }
  const ul = $("#tree-list");
  if (!ul) return;
  ul.insertAdjacentHTML("beforeend", r.trees.map((t) => `
    <li><button data-id="${Number(t.id)}"><span>${esc(t.common || t.scientific || "Tree")}${t.ht_no ? " 🌟" : ""}</span>
      <span class="meta">${t.girth_m ? `${t.girth_m.toFixed(1)} m girth` : ""}${t.height_band ? ` · ${esc(t.height_band)} m` : ""}</span></button></li>`).join(""));
  ul.querySelectorAll("button:not([data-wired])").forEach((b) => {
    b.dataset.wired = 1;
    b.addEventListener("click", () => openTree(Number(b.dataset.id), true, true));
  });
  const more = $("#more");
  if (more) more.hidden = ul.children.length >= (state.placeSpecies ? Infinity : d.tree_count) || r.trees.length < 25;
}

// ---- species
async function openSpecies(id, fly = true) {
  const seq = ++navSeq;
  openPanel(`<p class="muted">Loading…</p>`, { sheet: "half" });
  let s;
  try { s = await api(`/api/species/${encodeURIComponent(id)}`); }
  catch (e) { return seq === navSeq && openPanel(`<h2>Not found</h2><p class="muted">${esc(e.message)}</p>`); }
  if (seq !== navSeq) return;
  state.species = s; state.place = null;
  setUrl({ s: id });
  setHighlight(["==", ["get", "s"], s.id]);
  if (fly) map.flyTo({ center: [103.8198, 1.3521], zoom: 11.3, padding: panelPadding() });
  const placeRows = (rows) => `<ul class="list">${rows.map((r) => `<li><button data-kind="${esc(r.kind)}" data-slug="${esc(r.slug)}">
    <span>${esc(r.name)}</span><span class="meta">${fmt.format(r.n)}</span></button></li>`).join("")}</ul>`;
  const nativeLabel = s.native === 1 ? "Native to Singapore" : s.native === 0 ? "Non-native" : "Not recorded";
  const sources = [
    s.family_src ? "family" : null,
    s.native_src ? "origin (native range entirely outside Asia)" : null,
  ].filter(Boolean);
  openPanel(`
    <h2>${esc(s.common || s.scientific)}</h2>
    <p class="sub"><span class="sci">${esc(s.scientific)}</span>${s.family ? ` · ${esc(s.family)}` : ""}</p>
    <div class="stats">${statTile(fmt.format(s.tree_count), "trees in Singapore")}${statTile(esc(nativeLabel || "—"), "origin")}</div>
    <dl class="kv">
      ${s.growth_form ? `<dt>Growth form</dt><dd>${esc(s.growth_form)}</dd>` : ""}
      ${s.native_distribution ? `<dt>Native range</dt><dd>${esc(s.native_distribution)}</dd>` : ""}
      ${s.conservation_status ? `<dt>Status</dt><dd>${esc(s.conservation_status)}</dd>` : ""}
      ${s.wood_density ? `<dt>Wood density</dt><dd>${Number(s.wood_density).toFixed(2)} g/cm³ <span class="muted">(${s.wood_density_src === "genus" ? "average for its genus" : "this species"})</span></dd>` : ""}
      ${s.aliases?.length ? `<dt>Also called</dt><dd>${esc(s.aliases.slice(0, 8).join(", "))}</dd>` : ""}
    </dl>
    ${sources.length ? `<p class="note">NParks doesn't list this species' ${sources.join(" or ")}; shown from Kew's World Checklist of Vascular Plants.</p>` : ""}
    <div class="actions">
      ${safeUrl(s.ffw_url) ? `<a class="btn" href="${esc(safeUrl(s.ffw_url))}" target="_blank" rel="noopener noreferrer">Flora &amp; Fauna Web ↗</a>` : ""}
      <button class="btn" id="share">🔗 Share</button>
    </div>
    ${s.top_roads?.length ? `<h3>Roads with the most</h3>${placeRows(s.top_roads)}` : ""}
    ${s.top_parks?.length ? `<h3>Parks with the most</h3>${placeRows(s.top_parks)}` : ""}
    ${s.top_planning_areas?.length ? `<h3>Areas with the most</h3>${placeRows(s.top_planning_areas)}` : ""}`);
  $("#share").addEventListener("click", share);
  body.querySelectorAll("button[data-kind]").forEach((b) => b.addEventListener("click", async () => {
    await openPlace(b.dataset.kind, b.dataset.slug);
    const i = state.place?.top_species.findIndex((x) => x.id === s.id);
    if (state.place && i >= 0) { state.placeSpecies = s.id; await highlightPlace(state.place, s.id); renderPlace(state.place); }
  }));
}

// Why a tree has no carbon estimate (the model only covers ordinary trunks).
const CARBON_SKIP = {
  palm: "the model doesn't cover palms, pandans or bamboo",
  wide: "the recorded girth is wider than any trunk the model covers (often a fig measured around its aerial roots)",
  flag: "the recorded girth and height can't both be right",
};

// ---- tree
async function openTree(id, fly = true, keepContext = false) {
  let t;
  const seq = ++navSeq;
  // on a slow connection, say so instead of leaving the tap looking ignored
  const slow = setTimeout(() => seq === navSeq && openPanel(`<p class="muted" role="status">Loading tree…</p>`, { sheet: "half" }), 300);
  try { t = await api(`/api/tree/${encodeURIComponent(id)}`); }
  catch (e) { if (seq === navSeq) toast(`Tree ${id}: ${e.message}`); return; }
  finally { clearTimeout(slow); }
  if (seq !== navSeq) return;
  state.tree = t;
  const back = keepContext && (state.place || state.species);
  setUrl({ ...(state.place ? { p: `${state.place.kind}/${state.place.slug}` } : {}), ...(state.species ? { s: state.species.id } : {}), t: id });
  selectPoint([t.lng, t.lat]);
  const s = t.species || {};
  const cat = CATS.find((c) => c.key === t.category) || CATS.at(-1);
  const P = t.places || {};
  const placeLink = (kind) => P[kind] ? `<button class="linkish" data-kind="${kind}" data-slug="${esc(P[kind].slug)}">${esc(P[kind].name)}</button>` : null;
  const rows = [
    ["Girth", t.girth_m ? `${t.girth_m.toFixed(2)} m <span class="muted">(≈${Math.round((t.girth_m / Math.PI) * 100)} cm diameter)</span>${t.measure_flag ? " ⚠" : ""}` : esc(t.girth_band)],
    ["Height", t.height_band ? `${esc(t.height_band)} m${t.measure_flag ? " ⚠" : ""}` : null],
    ["Age", t.age != null && t.age >= 0 ? `~${Number(t.age)} years` : null],
    ["Planted", esc(t.date_planted)],
    ["Carbon", t.carbon_kg ? `~${tonnes(t.carbon_kg)} <span class="muted">(estimate)</span>` : CARBON_SKIP[t.carbon_skip] ? `<span class="muted">Not estimated: ${CARBON_SKIP[t.carbon_skip]}</span>` : null],
    ["Road", placeLink("road") && `${placeLink("road")}${t.road_dist != null ? ` <span class="muted">· ${Math.round(t.road_dist)} m</span>` : ""}`],
    ["Park", placeLink("park")],
    ["Park connector", placeLink("pcn")],
    ["Nature Way", esc(t.nature_way)],
    ["Subzone", placeLink("subzone")],
    ["Planning area", placeLink("planning_area")],
    ["Constituency", placeLink("constituency")],
    ["Heritage road", placeLink("heritage_road")],
    ["Conservation", t.tca ? `In ${esc(t.tca)}` : null],
    ["Land use", esc(t.land_use)],
    ["Tree ID", `${Number(t.id)}`],
    ["Updated", esc(t.last_edited)],
  ].filter(([, v]) => v);
  openPanel(`
    ${back ? `<button class="linkish" id="back">← Back to ${esc(state.place?.name || state.species?.common || "list")}</button>` : ""}
    <h2>${esc(s.common || s.scientific || "Tree")}</h2>
    <p class="sub"><span class="sci">${esc(s.scientific || "")}</span>${s.family ? ` · ${esc(s.family)}` : ""}</p>
    <p><span class="chip"><span class="dot" style="background:${catColor(cat.key)}"></span>${cat.label}</span>
      ${s.native === 1 ? `<span class="chip">Native</span>` : s.native === 0 ? `<span class="chip" ${s.native_src ? 'title="From Kew\'s World Checklist: native range entirely outside Asia"' : ""}>Non-native${s.native_src ? " ·&nbsp;Kew" : ""}</span>` : ""}
      ${t.incorrect ? `<span class="chip" title="Reported as incorrect on Trees.sg">⚠ Reported</span>` : ""}</p>
    ${t.ht_no ? `<div class="callout">🌟 <b>Heritage Tree ${esc(t.ht_no)}</b>${t.ht_desc ? `<br>${esc(t.ht_desc)}` : ""}${safeUrl(t.ht_url) ? `<br><a href="${esc(safeUrl(t.ht_url))}" target="_blank" rel="noopener noreferrer">Read its story ↗</a>` : ""}</div>` : ""}
    ${t.measure_flag ? `<div class="callout warn">⚠ <b>Possible recording error.</b> The recorded girth (${Number(t.girth_m).toFixed(1)} m) and height (${esc(t.height_band)} m) can't both be right: the trunk would be wider than the tree is plausibly tall. One of them is probably mis-recorded in the source data, so no carbon estimate is shown.</div>` : ""}
    <h3>Details</h3>
    <dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
    <div class="actions">
      ${s.id ? `<button class="btn" id="sp">All ${esc(s.common || s.scientific)} trees</button>` : ""}
      ${safeUrl(s.ffw_url) ? `<a class="btn" href="${esc(safeUrl(s.ffw_url))}" target="_blank" rel="noopener noreferrer">Flora &amp; Fauna Web ↗</a>` : ""}
      <a class="btn" href="https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${Number(t.lat)},${Number(t.lng)}" target="_blank" rel="noopener noreferrer">Street View ↗</a>
      <button class="btn" id="share">🔗 Share</button>
    </div>
    <p class="note">Carbon is an allometric estimate (Chave et al. 2014) from girth, height band and wood density${s.wood_density ? ` (${Number(s.wood_density).toFixed(2)} g/cm³, ${s.wood_density_src === "genus" ? "the average for its genus" : "for this species"})` : state.meta?.wood_density ? ` (${Number(state.meta.wood_density.default).toFixed(2)} g/cm³, the average across Singapore's trees)` : ""}.</p>`, { sheet: "half" });
  if (fly) map.easeTo({ center: [t.lng, t.lat], zoom: Math.max(map.getZoom(), 18), padding: panelPadding(), duration: 700 });
  $("#back")?.addEventListener("click", () => state.place ? renderPlace(state.place) : openSpecies(state.species.id, false));
  $("#sp")?.addEventListener("click", () => openSpecies(s.id));
  $("#share").addEventListener("click", share);
  body.querySelectorAll("button[data-kind]").forEach((b) => b.addEventListener("click", () => openPlace(b.dataset.kind, b.dataset.slug)));
}

// ---- near me / near an address
$("#near").addEventListener("click", () => {
  if (!navigator.geolocation) return toast("Location isn't available in this browser");
  toast("Finding trees near you…", 2000);
  navigator.geolocation.getCurrentPosition((pos) => nearby(pos.coords.latitude, pos.coords.longitude),
    () => toast("Couldn't get your location. Check location permission for this site."),
    { enableHighAccuracy: true, timeout: 10000 });
});
map.on("contextmenu", (e) => nearby(e.lngLat.lat, e.lngLat.lng)); // right-click (desktop): trees here

async function nearby(lat, lng, r = 150, label = null) {
  // Privacy: only a position rounded to ~10 m ever leaves the browser.
  lat = Math.round(lat * 1e4) / 1e4; lng = Math.round(lng * 1e4) / 1e4;
  const seq = ++navSeq;
  let d;
  try { d = await api(`/api/near?lat=${lat}&lng=${lng}&r=${r}&limit=60`); }
  catch (e) { return seq === navSeq && toast(e.message); }
  if (seq !== navSeq) return;
  state.place = state.species = null;
  setUrl({ near: `${lat.toFixed(4)},${lng.toFixed(4)},${r}`, n: label?.title || null });
  const circle = Array.from({ length: 65 }, (_, i) => {
    const a = (i / 64) * 2 * Math.PI;
    return [lng + (r / (111320 * Math.cos((lat * Math.PI) / 180))) * Math.cos(a), lat + (r / 111320) * Math.sin(a)];
  });
  map.getSource("near")?.setData({ type: "Feature", geometry: { type: "LineString", coordinates: circle }, properties: {} });
  setHighlight(["in", ["get", "id"], ["literal", d.trees.map((t) => t.id)]]);
  selectPoint(label ? [lng, lat] : null);
  openPanel(`
    <h2>${label ? esc(label.title) : `Trees within ${r} m`}</h2>
    ${label ? `<p class="sub">${label.sub ? `${esc(label.sub)} · ` : ""}trees within ${r} m</p>` : ""}
    <div class="stats">${statTile(fmt.format(d.count), "trees")}${statTile(d.trees.length ? `${Number(d.trees[0].dist_m)} m` : "—", "to the nearest tree")}</div>
    <h3>Species here</h3>${barList(d.species.map((s) => ({ label: s.name, n: s.n })), d.count)}
    <h3>Nearest</h3>
    <ul class="list">${d.trees.slice(0, 40).map((t) => `<li><button data-id="${Number(t.id)}"><span>${esc(t.common || t.scientific || "Tree")}</span>
      <span class="meta">${Number(t.dist_m)} m${t.girth_m ? ` · ${t.girth_m.toFixed(1)} m girth` : ""}</span></button></li>`).join("")}</ul>
    <div class="actions">${[100, 250, 500].filter((x) => x !== r).map((x) => `<button class="btn" data-r="${x}">${x} m</button>`).join("")}
      <button class="btn" id="share">🔗 Share</button></div>`,
    { sheet: "half" });
  map.easeTo({ center: [lng, lat], zoom: r > 300 ? 16.2 : 17.2, padding: panelPadding() });
  body.querySelectorAll("button[data-id]").forEach((b) => b.addEventListener("click", () => openTree(Number(b.dataset.id))));
  body.querySelectorAll("button[data-r]").forEach((b) => b.addEventListener("click", () => nearby(lat, lng, Number(b.dataset.r), label)));
  $("#share").addEventListener("click", share);
}

// ---- changes: trees added to / no longer in NParks' records
const changeRow = (c) => `<li><button data-change="${c.change === "added" ? "added" : "removed"}" data-id="${Number(c.tree_id)}" data-lng="${Number(c.lng)}" data-lat="${Number(c.lat)}">
  <span><span class="delta ${c.change === "added" ? "plus" : "minus"}">${c.change === "added" ? "+" : "−"}</span> ${esc(c.common || c.scientific || "Tree")}${c.place ? ` <span class="muted">· ${esc(c.place)}</span>` : ""}</span>
  <span class="meta">${c.girth_m ? `${Number(c.girth_m).toFixed(1)} m · ` : ""}${esc(fmtDate(c.seen))}</span></button></li>`;
const CHANGE_NOTE = `<p class="note">Compared with NParks' records at each update. A tree that's no longer listed isn't always felled; it may have been re-recorded.</p>`;
function changesSection(rows) {
  if (!rows) return ""; // not tracked for this kind of place
  const added = rows.filter((c) => c.change === "added").length, removed = rows.length - added;
  // Say "none" only once updates have actually been compared; before that, nothing is known.
  if (!rows.length) return `<h3>Recent changes</h3><p class="muted">${state.meta?.changes && !state.meta.changes.skipped
    ? "No trees added or removed here in recent updates."
    : "Not tracked yet. TreeNerd lists added and removed trees from its next data update."}</p>`;
  return `<h3>Recent changes</h3>
    <p><span class="delta plus">+${fmt.format(added)}</span> added · <span class="delta minus">−${fmt.format(removed)}</span> no longer listed</p>
    <details class="changes"><summary>Show them</summary><ul class="list">${rows.slice(0, 100).map(changeRow).join("")}</ul>${CHANGE_NOTE}</details>`;
}
function wireChangeRows() {
  body.querySelectorAll("button[data-change]").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.change === "added") return openTree(Number(b.dataset.id), true, true);
    const at = [Number(b.dataset.lng), Number(b.dataset.lat)]; // the tree is gone: show where it stood
    if (!at.every(Number.isFinite)) return;
    selectPoint(at);
    map.easeTo({ center: at, zoom: Math.max(map.getZoom(), 18), padding: panelPadding(), duration: 700 });
    if (isPhone()) setSheet("peek");
  }));
}
async function openChanges() {
  const seq = ++navSeq;
  openPanel(`<p class="muted" role="status">Loading…</p>`, { sheet: "half" });
  let d;
  try { d = await api("/api/changes"); }
  catch (e) { return seq === navSeq && openPanel(`<h2>Recent changes</h2><p class="muted">${esc(e.message)}</p>`); }
  if (seq !== navSeq) return;
  state.place = state.species = null;
  setHighlight(null); selectPoint(null);
  setUrl({ top: "changes" });
  const byBuild = new Map();
  for (const b of d.builds) {
    const row = byBuild.get(b.seen) || { seen: b.seen, since: b.since, added: 0, removed: 0 };
    row[b.change === "added" ? "added" : "removed"] = b.n;
    byBuild.set(b.seen, row);
  }
  openPanel(`
    <h2>Recent changes</h2>
    <p class="sub">Trees added to, or no longer in, NParks' records</p>
    ${byBuild.size ? `<ul class="list plain">${[...byBuild.values()].map((b) => `<li><span>${esc(fmtDate(b.seen))}${b.since ? ` <span class="muted">since ${esc(fmtDate(b.since))}</span>` : ""}</span>
        <span class="meta"><span class="delta plus">+${fmt.format(b.added)}</span> · <span class="delta minus">−${fmt.format(b.removed)}</span></span></li>`).join("")}</ul>
      <h3>Latest</h3><ul class="list">${d.trees.slice(0, 150).map(changeRow).join("")}</ul>${CHANGE_NOTE}`
    : `<p class="muted">Nothing yet. TreeNerd compares NParks' records at every update, so changes will appear here after the next one.</p>`}
    <div class="actions"><button class="btn" id="share">🔗 Share</button></div>`, { sheet: "half" });
  wireChangeRows();
  $("#share").addEventListener("click", share);
}

// ---- rankings
const TOP_KINDS = [["road", "Roads"], ["park", "Parks"], ["planning_area", "Areas"], ["subzone", "Subzones"],
  ["constituency", "Constituencies"], ["tree", "Widest trunks"]];
const TOP_BYS = [["trees", "Most trees"], ["species", "Most species"], ["carbon", "Most carbon"]];
async function openTop(kind = "road", by = "trees") {
  if (!TOP_KINDS.some(([k]) => k === kind)) kind = "road";
  if (!TOP_BYS.some(([b]) => b === by)) by = "trees";
  const seq = ++navSeq;
  openPanel(`<p class="muted" role="status">Loading…</p>`, { sheet: "half" });
  let d;
  try { d = await api(`/api/top?kind=${kind}${kind === "tree" ? "" : `&by=${by}`}`); }
  catch (e) { return seq === navSeq && openPanel(`<h2>Rankings</h2><p class="muted">${esc(e.message)}</p>`); }
  if (seq !== navSeq) return;
  state.place = state.species = null;
  setHighlight(null); selectPoint(null);
  setUrl({ top: kind === "tree" ? "tree" : `${kind}:${by}` });
  const chips = (list, on, attr) => `<div class="chips">${list.map(([k, label]) =>
    `<button class="chip-btn${k === on ? " on" : ""}" data-${attr}="${k}" aria-pressed="${k === on}">${label}</button>`).join("")}</div>`;
  const value = (r) => (by === "carbon" ? tonnes(r.carbon_kg) : fmt.format(by === "species" ? r.species_count : r.tree_count));
  openPanel(`
    <h2>${kind === "tree" ? "Widest tree trunks" : `${esc(TOP_KINDS.find(([k]) => k === kind)[1])}: ${esc(TOP_BYS.find(([b]) => b === by)[1].toLowerCase())}`}</h2>
    <p class="sub">${kind === "tree" ? "By recorded girth. Figs and clumping palms are measured around the whole clump." : by === "carbon" ? "Top 25 in Singapore, by estimated carbon" : "Top 25 in Singapore"}</p>
    ${chips(TOP_KINDS, kind, "kind")}
    ${kind === "tree" ? "" : chips(TOP_BYS, by, "by")}
    <ol class="list ranked">${kind === "tree"
      ? d.trees.map((t) => `<li><button data-id="${Number(t.id)}"><span>${esc(t.common || t.scientific || "Tree")}${t.ht_no ? " 🌟" : ""}${t.place ? ` <span class="muted">· ${esc(t.place)}</span>` : ""}</span>
          <span class="meta">${Number(t.girth_m).toFixed(1)} m girth</span></button></li>`).join("")
      : d.places.map((r) => `<li><button data-kind="${esc(r.kind)}" data-slug="${esc(r.slug)}"><span>${esc(r.name)}</span>
          <span class="meta">${value(r)}${by === "carbon" ? "" : by === "species" ? " species" : " trees"}</span></button></li>`).join("")}</ol>
    <div class="actions"><button class="btn" id="share">🔗 Share</button></div>`, { sheet: "half" });
  body.querySelectorAll("button[data-kind].chip-btn").forEach((b) => b.addEventListener("click", () => openTop(b.dataset.kind, by)));
  body.querySelectorAll("button[data-by]").forEach((b) => b.addEventListener("click", () => openTop(kind, b.dataset.by)));
  body.querySelectorAll(".ranked button[data-kind]").forEach((b) => b.addEventListener("click", () => openPlace(b.dataset.kind, b.dataset.slug)));
  body.querySelectorAll(".ranked button[data-id]").forEach((b) => b.addEventListener("click", () => openTree(Number(b.dataset.id))));
  $("#share").addEventListener("click", share);
}

// ---- about
const TELEGRAM = "https://t.me/treenerd";
$("#about").addEventListener("click", () => {
  const m = state.meta || {};
  navSeq++;
  state.place = state.species = null;
  openPanel(`
    <h2>About TreeNerd</h2>
    <div class="prose">
      <p>Explore Singapore's ${m.tree_count ? fmt.format(m.tree_count) : "~890,000"} trees by road, park, area, address or species.</p>
      <h3>Data</h3>
      <ul>
        <li>Trees: <a href="https://treessg.nparks.gov.sg" target="_blank" rel="noopener noreferrer">Trees.sg</a> © National Parks Board${m.source_last_edit ? `, last changed ${esc(fmtDate(m.source_last_edit))}` : ""}</li>
        <li>Boundaries, parks and heritage data: <a href="https://data.gov.sg" target="_blank" rel="noopener noreferrer">data.gov.sg</a> (Singapore Open Data Licence)</li>
        <li>Roads © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors (ODbL)</li>
        <li>Basemap and address search: <a href="https://www.onemap.gov.sg" target="_blank" rel="noopener noreferrer">OneMap</a> © Singapore Land Authority</li>
        <li>Missing species families and origins: <a href="https://powo.science.kew.org/about-wcvp" target="_blank" rel="noopener noreferrer">World Checklist of Vascular Plants</a>, Royal Botanic Gardens, Kew (CC BY 4.0)</li>
        <li>Wood density: <a href="https://doi.org/10.5281/zenodo.16919509" target="_blank" rel="noopener noreferrer">Global Wood Density Database v.2</a>, Fischer et al. 2026 (CC BY 4.0)</li>
        <li>MRT and LRT stations: Land Transport Authority, via data.gov.sg</li>
      </ul>
      ${m.built_at ? `<p class="muted">TreeNerd data updated ${esc(fmtDate(m.built_at))}. ${state.stale ? "An update is overdue, so recent changes by NParks aren't shown yet." : "It refreshes automatically."}</p>` : ""}
      <h3>How it's worked out</h3>
      <ul>
        <li><b>Roads</b> are matched to the nearest named road within 30 m. Trees in parks are listed under the park.</li>
        <li><b>Carbon</b> is an estimate from girth, height and the species' wood density (Chave et al. 2014), not a measurement. It isn't estimated for palms, or for trunks recorded as wider than 2.1 m across, which the model doesn't cover.</li>
        <li><b>Changes</b> come from comparing NParks' records at each update. A tree that's no longer listed isn't always felled.</li>
        <li><b>Heights</b> are published in 3 m bands.</li>
        <li><b>Origin</b> comes from NParks. Where NParks has none, a species is marked non-native only if Kew records its whole native range outside Asia; otherwise it stays unknown rather than guessed.</li>
      </ul>
      <h3>Feedback</h3>
      <p>Ideas, bugs or questions? Join our Telegram channel.</p>
      <div class="actions"><a class="btn" href="${TELEGRAM}" target="_blank" rel="noopener noreferrer">💬 Join on Telegram</a></div>
      <p class="muted">TreeNerd is an independent project and isn't affiliated with NParks or any government agency.
        To report a problem with a tree itself, such as a wrong species or a felled tree, contact NParks.</p>
    </div>`, { sheet: "half" });
});

async function share() {
  const url = location.href;
  try {
    if (navigator.share) await navigator.share({ title: document.title, url });
    else { await navigator.clipboard.writeText(url); toast("Link copied"); }
  } catch { /* cancelled */ }
}
