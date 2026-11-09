/* TreeNerd front end: MapLibre + PMTiles + the Worker API. No build step. */
const $ = (s, el = document) => el.querySelector(s);
const fmt = new Intl.NumberFormat("en-SG");
/** Only allow https links from data into href attributes. */
const safeUrl = (u) => { try { const x = new URL(u); return x.protocol === "https:" ? x.href : null; } catch { return null; } };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

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
  constituency: "Constituency", heritage_road: "Heritage road", species: "Species",
};
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const catColor = (key) => css(`--c-${key}`);
const dark = () => matchMedia("(prefers-color-scheme: dark)").matches;

const state = {
  cats: new Set(CATS.map((c) => c.code)),
  highlight: null,        // maplibre expression selecting highlighted trees
  place: null, species: null, tree: null,
  meta: null, speciesDict: {},
};

async function api(path) {
  const r = await fetch(path);
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
const protocol = new pmtiles.Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);

const basemap = (style) => ({
  type: "raster", tileSize: 256, minzoom: 11, maxzoom: 19,
  tiles: [`https://www.onemap.gov.sg/maps/tiles/${style}/{z}/{x}/{y}.png`],
  bounds: [103.596, 1.1443, 104.1, 1.4835],
  attribution: '<img src="https://www.onemap.gov.sg/web-assets/images/logo/om_logo.png" style="height:16px;width:16px;vertical-align:-3px"/> <a href="https://www.onemap.gov.sg/" target="_blank" rel="noopener noreferrer">OneMap</a> © contributors | <a href="https://www.sla.gov.sg/" target="_blank" rel="noopener noreferrer">Singapore Land Authority</a>',
});

const map = new maplibregl.Map({
  container: "map",
  hash: "map",
  center: [103.8198, 1.3521], zoom: 11.3, minZoom: 10.5, maxZoom: 20,
  maxBounds: [[103.5, 1.1], [104.2, 1.53]],
  attributionControl: false,
  style: {
    version: 8,
    sources: { base: basemap(dark() ? "Night" : "Grey") },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": dark() ? "#0f1411" : "#eef0ea" } },
      { id: "base", type: "raster", source: "base", paint: { "raster-opacity": dark() ? 0.8 : 0.9 } },
    ],
  },
});
map.addControl(new maplibregl.AttributionControl({
  compact: true,
  customAttribution: 'Trees: <a href="https://treessg.nparks.gov.sg" target="_blank" rel="noopener noreferrer">Trees.sg</a> © NParks · Roads © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> · data.gov.sg',
}), "bottom-right");
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: false }), "bottom-right");

function colorExpr() {
  return ["match", ["get", "c"], ...CATS.flatMap((c) => [c.code, catColor(c.key)]), catColor("other")];
}
function radiusExpr() {
  const g = ["coalesce", ["get", "g"], 40]; // girth in cm
  return ["interpolate", ["linear"], ["zoom"],
    11, ["case", ["==", ["get", "c"], 6], 2.5, 0.8],
    14, ["case", ["==", ["get", "c"], 6], 5, 2],
    17, ["+", 2.5, ["/", ["min", g, 400], 45]],
    20, ["+", 6, ["/", ["min", g, 400], 14]]];
}
function filterExpr() {
  return ["in", ["get", "c"], ["literal", [...state.cats]]];
}
function opacityExpr() {
  if (!state.highlight) return ["interpolate", ["linear"], ["zoom"], 11, 0.55, 15, 0.85];
  return ["case", state.highlight, 0.95, 0.08];
}

map.on("load", async () => {
  const meta = await api("/api/meta").catch(() => null);
  state.meta = meta;
  const v = encodeURIComponent(meta?.built_at || "dev");
  map.addSource("trees", { type: "vector", url: `pmtiles://${location.origin}/data/trees.pmtiles?v=${v}`, promoteId: "id" });
  map.addLayer({
    id: "trees", type: "circle", source: "trees", "source-layer": "trees", filter: filterExpr(),
    paint: {
      "circle-color": colorExpr(), "circle-radius": radiusExpr(), "circle-opacity": opacityExpr(),
      "circle-stroke-color": dark() ? "#0f1411" : "#ffffff",
      "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 14, 0, 16, 0.6],
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
  const mobile = innerWidth <= 720;
  return mobile ? { top: 80, bottom: innerHeight * 0.6, left: 30, right: 30 } : { top: 90, bottom: 40, left: 430, right: 60 };
}

function wireMapEvents() {
  const hover = $("#hover");
  map.on("mousemove", "trees", (e) => {
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
  map.on("click", "trees", (e) => {
    const f = e.features.sort((a, b) => (b.properties.g || 0) - (a.properties.g || 0))[0];
    openTree(f.properties.id);
  });
  map.on("click", (e) => {
    if (!map.queryRenderedFeatures(e.point, { layers: ["trees"] }).length && innerWidth > 720 && !state.place && !state.species) closePanel();
  });
}

// ------------------------------------------------------------------ legend
function buildLegend() {
  const counts = state.meta?.category_counts || {};
  $("#total").textContent = state.meta?.tree_count ? `· ${fmt.format(state.meta.tree_count)} trees` : "";
  $("#legend-items").innerHTML = CATS.filter((c) => counts[c.key] || !state.meta).map((c) => `
    <label><input type="checkbox" data-c="${c.code}" checked>
      <span class="dot" style="background:${catColor(c.key)}"></span>${c.label}
      <span class="n">${counts[c.key] ? fmt.format(counts[c.key]) : ""}</span></label>`).join("");
  $("#legend-items").addEventListener("change", (e) => {
    const c = Number(e.target.dataset.c);
    e.target.checked ? state.cats.add(c) : state.cats.delete(c);
    map.setFilter("trees", filterExpr());
  });
  if (innerWidth <= 720) {
    const lg = $("#legend");
    lg.classList.add("collapsed");
    $(".legend-title").addEventListener("click", () => lg.classList.toggle("collapsed"));
  }
}

// ------------------------------------------------------------------ search
const q = $("#q"), results = $("#results");
let active = -1, items = [], searchSeq = 0;
q.addEventListener("input", () => {
  $("#clear").hidden = !q.value;
  clearTimeout(q.t);
  q.t = setTimeout(runSearch, 120);
});
q.addEventListener("keydown", (e) => {
  if (results.hidden) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    active = (active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    [...results.children].forEach((li, i) => li.setAttribute("aria-selected", i === active));
  } else if (e.key === "Enter" && items.length) {
    choose(items[Math.max(active, 0)]);
  } else if (e.key === "Escape") hideResults();
});
q.addEventListener("focus", () => items.length && q.value && showResults());
document.addEventListener("click", (e) => !e.target.closest(".search") && hideResults());
$("#clear").addEventListener("click", () => { q.value = ""; $("#clear").hidden = true; hideResults(); q.focus(); });

async function runSearch() {
  const text = q.value.trim();
  if (text.length < 2) return hideResults();
  const seq = ++searchSeq;
  try {
    const d = await api(`/api/search?q=${encodeURIComponent(text)}`);
    if (seq !== searchSeq) return;
    items = d.results; active = -1;
    results.innerHTML = items.length ? items.map((r) => `
      <li role="option" aria-selected="false">
        <span class="badge">${KIND_LABEL[r.kind] || r.kind}</span>
        <span class="r-name">${esc(r.name)}${r.kind === "species" && r.alt?.[0] ? `<span class="r-alt">${esc(r.alt[0])}</span>` : ""}</span>
        <span class="r-count">${fmt.format(r.count)}</span></li>`).join("")
      : `<li class="empty">No matches for “${esc(text)}”</li>`;
    [...results.querySelectorAll("li[role=option]")].forEach((li, i) => li.addEventListener("click", () => choose(items[i])));
    showResults();
  } catch (e) { toast(`Search unavailable: ${e.message}`); }
}
function showResults() { results.hidden = false; $(".search").setAttribute("aria-expanded", "true"); }
function hideResults() { results.hidden = true; $(".search").setAttribute("aria-expanded", "false"); }
function choose(r) {
  hideResults();
  q.value = r.name; $("#clear").hidden = false; q.blur();
  if (r.kind === "species") openSpecies(r.slug);
  else openPlace(r.kind, r.slug, r.bbox);
}

// ------------------------------------------------------------------ panel
const panel = $("#panel"), body = $("#panel-body");
function openPanel(html) {
  body.innerHTML = html; panel.hidden = false; panel.scrollTop = 0;
  document.body.classList.add("panel-open");
  requestAnimationFrame(() => map.triggerRepaint()); // some GPUs leave a stale canvas under new overlays
}
function closePanel() {
  panel.hidden = true; document.body.classList.remove("panel-open");
  state.place = state.species = state.tree = null;
  setHighlight(null); selectPoint(null);
  map.getSource("near")?.setData({ type: "FeatureCollection", features: [] });
  setUrl({});
}
$("#close").addEventListener("click", closePanel);
document.addEventListener("keydown", (e) => e.key === "Escape" && !panel.hidden && document.activeElement !== q && closePanel());

function setUrl(params) {
  const u = new URL(location.href);
  for (const k of ["p", "s", "t"]) u.searchParams.delete(k);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  history.replaceState(null, "", u);
}
function restoreFromUrl() {
  const u = new URL(location.href);
  const p = u.searchParams.get("p"), s = u.searchParams.get("s"), t = u.searchParams.get("t");
  const hasView = INITIAL_VIEW;
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

// ---- place (road / park / area …)
async function openPlace(kind, slug, bbox, fly = true) {
  openPanel(`<p class="muted">Loading…</p>`);
  let d;
  try { d = await api(`/api/place/${encodeURIComponent(kind)}/${encodeURIComponent(slug)}`); }
  catch (e) { return openPanel(`<h2>Not found</h2><p class="muted">${esc(e.message)}</p>`); }
  state.place = d; state.species = null; state.placeSpecies = null;
  setUrl({ p: `${kind}/${slug}` });
  if (fly) fitBbox(d.bbox || bbox, kind === "road" ? 18 : 17);
  await highlightPlace(d);
  renderPlace(d);
}
async function highlightPlace(d, speciesId) {
  let expr;
  if (d.tile_key) expr = ["==", ["get", d.tile_key], d.place_id];
  else {
    const { ids } = await api(`/api/place/${d.kind}/${encodeURIComponent(d.slug)}/ids`);
    expr = ["in", ["get", "id"], ["literal", ids]];
  }
  if (speciesId) expr = ["all", expr, ["==", ["get", "s"], speciesId]];
  setHighlight(expr);
}
function renderPlace(d) {
  const native = Object.fromEntries((d.native || []).map((r) => [String(r.k), r.n]));
  const nativePct = d.tree_count ? Math.round(((native["1"] || 0) / d.tree_count) * 100) : 0;
  const extra = d.extra || {};
  const sub = [KIND_LABEL[d.kind], extra.planning_area, extra.region].filter(Boolean).join(" · ");
  const species = d.top_species.map((s) => ({ id: s.id, n: s.n, label: s.common || s.scientific || `Species ${s.id}`, sub: s.common ? s.scientific : "" }));
  openPanel(`
    <h2>${esc(d.name)}</h2>
    <p class="sub">${esc(sub)}${d.alt?.length ? ` · ${esc(d.alt.join(" · "))}` : ""}</p>
    <div class="stats">
      ${statTile(fmt.format(d.tree_count), "trees")}
      ${statTile(fmt.format(d.species_count), "species")}
      ${statTile(`${nativePct}%`, "trees of native species")}
      ${statTile(tonnes(d.carbon_kg), "carbon stored (est.)")}
    </div>
    ${d.heritage_count ? `<div class="callout">🌟 ${d.heritage_count} heritage tree${d.heritage_count > 1 ? "s" : ""}</div>` : ""}
    ${safeUrl(extra.url) ? `<p><a href="${esc(safeUrl(extra.url))}" target="_blank" rel="noopener noreferrer">About this heritage road ↗</a></p>` : ""}
    <h3>Tree types</h3>${categoryStack(d.categories, d.tree_count)}
    <h3>Top species <span class="muted" style="text-transform:none;letter-spacing:0">· tap to filter</span></h3>
    <div id="place-species">${barList(species, d.tree_count, { onclick: true, active: state.placeSpecies })}</div>
    <h3>Largest trees</h3>
    <ul class="list" id="tree-list"></ul>
    <div class="actions">
      <button class="btn" id="more">Show more</button>
      <a class="btn" href="/api/place/${d.kind}/${encodeURIComponent(d.slug)}/trees.csv${state.placeSpecies ? `?species=${state.placeSpecies}` : ""}" download>⬇ CSV</a>
      <button class="btn" id="share">🔗 Share</button>
    </div>`);
  $("#place-species").querySelectorAll("button.bar").forEach((b) => b.addEventListener("click", async () => {
    const id = species[Number(b.dataset.i)].id;
    state.placeSpecies = state.placeSpecies === id ? null : id;
    await highlightPlace(d, state.placeSpecies);
    renderPlace(d);
  }));
  $("#share").addEventListener("click", share);
  loadTreeList(d, 0);
  $("#more").addEventListener("click", () => loadTreeList(d, $("#tree-list").children.length));
}
async function loadTreeList(d, offset) {
  const sp = state.placeSpecies ? `&species=${state.placeSpecies}` : "";
  const r = await api(`/api/place/${d.kind}/${encodeURIComponent(d.slug)}/trees?limit=25&offset=${offset}${sp}`);
  const ul = $("#tree-list");
  if (!ul) return;
  ul.insertAdjacentHTML("beforeend", r.trees.map((t) => `
    <li><button data-id="${t.id}"><span>${esc(t.common || t.scientific || "Tree")}${t.ht_no ? " 🌟" : ""}</span>
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
  openPanel(`<p class="muted">Loading…</p>`);
  let s;
  try { s = await api(`/api/species/${encodeURIComponent(id)}`); }
  catch (e) { return openPanel(`<h2>Not found</h2><p class="muted">${esc(e.message)}</p>`); }
  state.species = s; state.place = null;
  setUrl({ s: id });
  setHighlight(["==", ["get", "s"], s.id]);
  if (fly) map.flyTo({ center: [103.8198, 1.3521], zoom: 11.3, padding: panelPadding() });
  const placeRows = (rows) => `<ul class="list">${rows.map((r) => `<li><button data-kind="${r.kind}" data-slug="${esc(r.slug)}">
    <span>${esc(r.name)}</span><span class="meta">${fmt.format(r.n)}</span></button></li>`).join("")}</ul>`;
  const nativeLabel = s.native === 1 ? "Native to Singapore" : s.native === 0 ? "Non-native" : null;
  openPanel(`
    <h2>${esc(s.common || s.scientific)}</h2>
    <p class="sub"><span class="sci">${esc(s.scientific)}</span>${s.family ? ` · ${esc(s.family)}` : ""}</p>
    <div class="stats">${statTile(fmt.format(s.tree_count), "trees in Singapore")}${statTile(esc(nativeLabel || "—"), "origin")}</div>
    <dl class="kv">
      ${s.growth_form ? `<dt>Growth form</dt><dd>${esc(s.growth_form)}</dd>` : ""}
      ${s.native_distribution ? `<dt>Native range</dt><dd>${esc(s.native_distribution)}</dd>` : ""}
      ${s.conservation_status ? `<dt>Status</dt><dd>${esc(s.conservation_status)}</dd>` : ""}
      ${s.aliases?.length ? `<dt>Also called</dt><dd>${esc(s.aliases.slice(0, 8).join(", "))}</dd>` : ""}
    </dl>
    ${safeUrl(s.ffw_url) ? `<div class="actions"><a class="btn" href="${esc(safeUrl(s.ffw_url))}" target="_blank" rel="noopener noreferrer">Flora &amp; Fauna Web ↗</a><button class="btn" id="share">🔗 Share</button></div>` : ""}
    ${s.top_roads?.length ? `<h3>Roads with the most</h3>${placeRows(s.top_roads)}` : ""}
    ${s.top_parks?.length ? `<h3>Parks with the most</h3>${placeRows(s.top_parks)}` : ""}
    ${s.top_planning_areas?.length ? `<h3>Areas with the most</h3>${placeRows(s.top_planning_areas)}` : ""}`);
  $("#share")?.addEventListener("click", share);
  body.querySelectorAll("button[data-kind]").forEach((b) => b.addEventListener("click", async () => {
    await openPlace(b.dataset.kind, b.dataset.slug);
    const i = state.place?.top_species.findIndex((x) => x.id === s.id);
    if (state.place && i >= 0) { state.placeSpecies = s.id; await highlightPlace(state.place, s.id); renderPlace(state.place); }
  }));
}

// ---- tree
async function openTree(id, fly = true, keepContext = false) {
  let t;
  try { t = await api(`/api/tree/${encodeURIComponent(id)}`); }
  catch (e) { return toast(`Tree ${id}: ${e.message}`); }
  state.tree = t;
  const back = keepContext && (state.place || state.species);
  setUrl({ ...(state.place ? { p: `${state.place.kind}/${state.place.slug}` } : {}), ...(state.species ? { s: state.species.id } : {}), t: id });
  selectPoint([t.lng, t.lat]);
  if (fly) map.easeTo({ center: [t.lng, t.lat], zoom: Math.max(map.getZoom(), 18), padding: panelPadding(), duration: 700 });
  const s = t.species || {};
  const cat = CATS.find((c) => c.key === t.category) || CATS.at(-1);
  const P = t.places || {};
  const placeLink = (kind) => P[kind] ? `<button class="linkish" data-kind="${kind}" data-slug="${esc(P[kind].slug)}">${esc(P[kind].name)}</button>` : null;
  const rows = [
    ["Girth", t.girth_m ? `${t.girth_m.toFixed(2)} m <span class="muted">(≈${Math.round((t.girth_m / Math.PI) * 100)} cm diameter)</span>` : t.girth_band],
    ["Height", t.height_band ? `${esc(t.height_band)} m` : null],
    ["Age", t.age != null && t.age >= 0 ? `~${t.age} years` : null],
    ["Planted", t.date_planted],
    ["Carbon", t.carbon_kg ? `~${tonnes(t.carbon_kg)} <span class="muted">(estimate)</span>` : null],
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
    ["Tree ID", `${t.id}`],
    ["Updated", t.last_edited],
  ].filter(([, v]) => v);
  openPanel(`
    ${back ? `<button class="linkish" id="back">← Back to ${esc(state.place?.name || state.species?.common || "list")}</button>` : ""}
    <h2>${esc(s.common || s.scientific || "Tree")}</h2>
    <p class="sub"><span class="sci">${esc(s.scientific || "")}</span>${s.family ? ` · ${esc(s.family)}` : ""}</p>
    <p><span class="chip"><span class="dot" style="background:${catColor(cat.key)}"></span>${cat.label}</span>
      ${s.native === 1 ? `<span class="chip">Native</span>` : s.native === 0 ? `<span class="chip">Non-native</span>` : ""}
      ${t.incorrect ? `<span class="chip" title="Reported as incorrect on Trees.sg">⚠ Reported</span>` : ""}</p>
    ${t.ht_no ? `<div class="callout">🌟 <b>Heritage Tree ${esc(t.ht_no)}</b><br>${esc(t.ht_desc || "")}
      ${safeUrl(t.ht_url) ? `<br><a href="${esc(safeUrl(t.ht_url))}" target="_blank" rel="noopener noreferrer">Read its story ↗</a>` : ""}</div>` : ""}
    <h3>Details</h3>
    <dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
    <div class="actions">
      ${s.id ? `<button class="btn" id="sp">All ${esc(s.common || s.scientific)} trees</button>` : ""}
      ${safeUrl(s.ffw_url) ? `<a class="btn" href="${esc(safeUrl(s.ffw_url))}" target="_blank" rel="noopener noreferrer">Flora &amp; Fauna Web ↗</a>` : ""}
      <a class="btn" href="https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${t.lat},${t.lng}" target="_blank" rel="noopener noreferrer">Street View ↗</a>
      <button class="btn" id="share">🔗 Share</button>
    </div>
    <p class="note">Carbon is an allometric estimate (Chave et al. 2014) from girth and height band.</p>`);
  $("#back")?.addEventListener("click", () => state.place ? renderPlace(state.place) : openSpecies(state.species.id, false));
  $("#sp")?.addEventListener("click", () => openSpecies(s.id));
  $("#share").addEventListener("click", share);
  body.querySelectorAll("button[data-kind]").forEach((b) => b.addEventListener("click", () => openPlace(b.dataset.kind, b.dataset.slug)));
}

// ---- near me
$("#near").addEventListener("click", () => {
  if (!navigator.geolocation) return toast("Location isn't available in this browser");
  toast("Finding trees near you…", 2000);
  navigator.geolocation.getCurrentPosition((pos) => nearby(pos.coords.latitude, pos.coords.longitude),
    () => toast("Couldn't get your location"), { enableHighAccuracy: true, timeout: 10000 });
});
map.on("contextmenu", (e) => nearby(e.lngLat.lat, e.lngLat.lng)); // right-click / long-press: trees here

async function nearby(lat, lng, r = 150) {
  let d;
  try { d = await api(`/api/near?lat=${lat}&lng=${lng}&r=${r}&limit=60`); }
  catch (e) { return toast(e.message); }
  state.place = state.species = null;
  const circle = Array.from({ length: 65 }, (_, i) => {
    const a = (i / 64) * 2 * Math.PI;
    return [lng + (r / (111320 * Math.cos((lat * Math.PI) / 180))) * Math.cos(a), lat + (r / 111320) * Math.sin(a)];
  });
  map.getSource("near")?.setData({ type: "Feature", geometry: { type: "LineString", coordinates: circle }, properties: {} });
  setHighlight(["in", ["get", "id"], ["literal", d.trees.map((t) => t.id)]]);
  map.easeTo({ center: [lng, lat], zoom: 17.2, padding: panelPadding() });
  openPanel(`
    <h2>Trees within ${r} m</h2>
    <div class="stats">${statTile(fmt.format(d.count), "trees")}${statTile(fmt.format(d.species.length), "top species shown")}</div>
    <h3>Species here</h3>${barList(d.species.map((s) => ({ label: s.name, n: s.n })), d.count)}
    <h3>Nearest</h3>
    <ul class="list">${d.trees.slice(0, 40).map((t) => `<li><button data-id="${t.id}"><span>${esc(t.common || t.scientific || "Tree")}</span>
      <span class="meta">${t.dist_m} m${t.girth_m ? ` · ${t.girth_m.toFixed(1)} m girth` : ""}</span></button></li>`).join("")}</ul>
    <div class="actions">${[100, 250, 500].filter((x) => x !== r).map((x) => `<button class="btn" data-r="${x}">${x} m</button>`).join("")}</div>`);
  body.querySelectorAll("button[data-id]").forEach((b) => b.addEventListener("click", () => openTree(Number(b.dataset.id))));
  body.querySelectorAll("button[data-r]").forEach((b) => b.addEventListener("click", () => nearby(lat, lng, Number(b.dataset.r))));
}

async function share() {
  const url = location.href;
  try {
    if (navigator.share) await navigator.share({ title: document.title, url });
    else { await navigator.clipboard.writeText(url); toast("Link copied"); }
  } catch { /* cancelled */ }
}
