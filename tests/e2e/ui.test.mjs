// Browser tests of the app against the local fixture site (see run.mjs). The basemap is blocked,
// so nothing here depends on an outside service.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as playwright from "playwright";

// E2E_BROWSER=webkit runs the same tests in Safari's engine (CI does both).
const engine = playwright[process.env.E2E_BROWSER || "chromium"];
const { devices } = playwright;

const B = process.env.E2E_BASE || "http://127.0.0.1:8799";
const PORT = new URL(B).port;
// The page's security policy upgrades every request to HTTPS. Chromium exempts local addresses;
// WebKit does not, so against the plain-HTTP local test server its scripts would fail to load.
// For WebKit only, that one directive is removed from the test server's pages. (The live site is HTTPS.)
const PLAIN_HTTP_FIX = (process.env.E2E_BROWSER || "chromium") === "webkit" || process.env.E2E_PLAIN_HTTP_FIX === "1";
let browser;
before(async () => { browser = await engine.launch(); });
after(() => browser?.close());

// The basemap (an outside service) is answered with a blank tile, so nothing depends on it and no
// browser logs a failed request for it.
const BLANK_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const stubOutside = (ctx) => ctx.route(/onemap\.gov\.sg|cloudflareinsights/, (r) => /\.png(\?|$)/.test(r.request().url())
  ? r.fulfill({ status: 200, contentType: "image/png", headers: { "access-control-allow-origin": "*" }, body: BLANK_PNG })
  : r.fulfill({ status: 204, body: "" }));

/** Open a page of the app. `setup(ctx)` can add routes before the page loads. */
async function open(path, ctxOptions = { viewport: { width: 1280, height: 800 } }, origin = B, setup = null) {
  const ctx = await browser.newContext(ctxOptions);
  await stubOutside(ctx);
  if (PLAIN_HTTP_FIX) {
    await ctx.route(() => true, async (route) => {
      if (route.request().resourceType() !== "document") return route.fallback();
      // fetched by the test runner, which can't resolve dev.localhost: ask 127.0.0.1 with that Host
      const u = new URL(route.request().url());
      const res = u.hostname.endsWith(".localhost")
        ? await route.fetch({ url: u.href.replace(u.hostname, "127.0.0.1"), headers: { ...route.request().headers(), host: u.host } })
        : await route.fetch();
      const headers = { ...res.headers() };
      const csp = headers["content-security-policy"];
      if (csp) headers["content-security-policy"] = csp.replace(/;?\s*upgrade-insecure-requests/, "");
      await route.fulfill({ response: res, headers });
    });
  }
  if (setup) await setup(ctx);
  const page = await ctx.newPage();
  const errors = [], tiles = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => /parse the tile/i.test(m.text()) && errors.push(m.text()));
  page.on("response", (r) => /\/tiles\/\d+\//.test(r.url()) && tiles.push({ url: r.url(), status: r.status() }));
  const trouble = []; // shown if the app fails to start, so a CI failure explains itself
  page.on("console", (m) => m.type() === "error" && trouble.push(`console: ${m.text().slice(0, 200)}`));
  page.on("requestfailed", (r) => trouble.push(`failed: ${r.url()} ${r.failure()?.errorText}`));
  await page.goto(origin + path, { waitUntil: "load" });
  try {
    await page.waitForSelector("#legend-items label", { state: "attached" }); // the map has loaded and the app is wired
  } catch (e) {
    const webgl = await page.evaluate(() => !!document.createElement("canvas").getContext("webgl2")).catch(() => "unknown");
    throw new Error(`the app did not start on ${path} (WebGL2: ${webgl})\n${[...errors, ...trouble].slice(0, 12).join("\n")}`, { cause: e });
  }
  return { ctx, page, errors, tiles, h2: () => page.locator("#panel-body h2").textContent(), param: (k) => new URL(page.url()).searchParams.get(k) };
}
const panelTitle = (page, text) => page.waitForFunction((t) => document.querySelector("#panel-body h2")?.textContent === t, text);

test("tree dots are drawn, on a first and a repeat visit", async () => {
  for (const visit of ["first", "repeat"]) {
    const { ctx, page, errors, tiles } = await open("/#map=16.5/1.3019/103.8378");
    for (let i = 0; i < 100 && !tiles.some((t) => /\/tiles\/16\//.test(t.url) && t.status === 200); i++) await page.waitForTimeout(100);
    await page.waitForTimeout(1500);
    // street trees are green dots on a plain background (the basemap is blocked)
    const shot = await page.screenshot({ clip: { x: 300, y: 150, width: 700, height: 500 } });
    const counter = await ctx.newPage(); // a blank page: the app's own security policy forbids data: fetches
    const green = await counter.evaluate(async (b64) => {
      const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const c = new OffscreenCanvas(img.width, img.height).getContext("2d");
      c.drawImage(img, 0, 0);
      const d = c.getImageData(0, 0, img.width, img.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 1] - d[i] > 40 && d[i + 1] - d[i + 2] > 40) n++;
      return n;
    }, shot.toString("base64"));
    assert.ok(green > 300, `${visit} visit: ${green} green pixels`);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
});

test("search: suggestions, keyboard, typo tolerance", async () => {
  const { ctx, page, errors, h2 } = await open("/");
  await page.click("#q");
  await page.waitForSelector("#results li[role=option]");
  assert.equal(await page.getAttribute("#q", "aria-expanded"), "true");
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.getAttribute("#q", "aria-activedescendant"), "opt-0");
  await page.fill("#q", "orchad rd");
  await page.waitForFunction(() => document.querySelector("#results li[role=option]")?.textContent.includes("Orchard Road"));
  await page.keyboard.press("Enter");
  await panelTitle(page, "Orchard Road");
  assert.equal(await h2(), "Orchard Road");
  assert.match(await page.textContent("#panel-body"), /670/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("back and forward step through what was opened", async () => {
  const { ctx, page, errors, h2, param } = await open("/?top=road:trees");
  await panelTitle(page, "Roads: most trees");
  await page.click('.ranked button[data-slug="orchard-road"]');
  await panelTitle(page, "Orchard Road");
  await page.waitForSelector("#tree-list li button");
  await page.click("#tree-list li:first-child button");
  await page.waitForFunction(() => new URL(location.href).searchParams.has("t"));
  const treeName = await h2();
  await page.goBack();
  await panelTitle(page, "Orchard Road");
  assert.equal(param("t"), null);
  await page.goBack();
  await panelTitle(page, "Roads: most trees");
  await page.goForward();
  await panelTitle(page, "Orchard Road");
  await page.goForward();
  await panelTitle(page, treeName);
  await page.click("#close");
  assert.equal(new URL(page.url()).search, "");
  await page.goBack();
  await panelTitle(page, treeName);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("tree card: details, wood density note, share link", async () => {
  const { ctx, page, errors } = await open("/?t=10687021");
  await panelTitle(page, "Rain Tree");
  const text = await page.textContent("#panel-body");
  assert.match(text, /4\.38 m/);
  assert.match(text, /Orchard Road/);
  assert.match(text, /0\.53 g\/cm³, for this species/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("what the page says matches the data", async () => {
  const { ctx, page, errors } = await open("/?p=road/orchard-road");
  await panelTitle(page, "Orchard Road");
  const api = await (await fetch(`${B}/api/place/road/orchard-road`)).json();
  const tiles = await page.locator("#panel-body .stat").allTextContents();
  const fmt = new Intl.NumberFormat("en-SG");
  assert.ok(tiles[0].startsWith(fmt.format(api.tree_count)), tiles[0]);
  assert.ok(tiles[1].startsWith(fmt.format(api.species_count)), tiles[1]);
  const native = api.native.find((n) => n.k === 1)?.n ?? 0;
  assert.ok(tiles[2].startsWith(`${Math.round((native / api.tree_count) * 100)}%`), tiles[2]);
  assert.match(tiles[2], /of trees are native species/);
  assert.ok(tiles[3].startsWith(`${fmt.format(Math.round(api.carbon_kg / 1000))} t`), tiles[3]);
  // the legend's total and date come from the build
  const meta = await (await fetch(`${B}/api/meta`)).json();
  assert.match(await page.textContent("#total"), new RegExp(fmt.format(meta.tree_count)));
  assert.doesNotMatch(await page.textContent("#updated"), /overdue/);
  assert.deepEqual(errors, []);
  await ctx.close();
  // A palm gets no carbon figure, and the card says why. (A separate page: navigating away while the
  // map is loading cancels its downloads, which WebKit reports as page errors.)
  const palm = await open("/?t=13197918");
  await palm.page.waitForFunction(() => /Not estimated/.test(document.querySelector("#panel-body")?.textContent || ""));
  assert.match(await palm.page.textContent("#panel-body"), /Not estimated: the model doesn't cover palms/);
  assert.deepEqual(palm.errors, []);
  await palm.ctx.close();
});

test("old data is labelled as overdue", async () => {
  const { ctx, page } = await open("/", undefined, B, (c) => c.route("**/api/meta", async (r) => {
    const res = await r.fetch();
    await r.fulfill({ response: res, json: { ...(await res.json()), built_at: "2026-01-05T00:00:00Z" } });
  }));
  await page.waitForFunction(() => /overdue/.test(document.querySelector("#updated")?.textContent || ""));
  await ctx.close();
});

test("a trail: trees per km, the route on the map, a ranking of trails", async () => {
  const { ctx, page, errors } = await open("/?p=trail/central-cycling-paths");
  await panelTitle(page, "Central cycling paths");
  const text = await page.textContent("#panel-body");
  assert.match(text, /trees per km/);
  assert.match(text, /km long/);
  assert.match(text, /within 15 m of the route/);
  await page.waitForFunction(() => performance.getEntriesByType("resource").some((e) => e.name.includes("/data/trails.geojson")));
  assert.deepEqual(errors, []);
  await ctx.close();
  const top = await open("/?top=trail:per_km");
  await panelTitle(top.page, "Trails: most per km");
  assert.ok((await top.page.locator(".ranked li").count()) >= 1);
  await top.ctx.close();
});

test("on data built before trails existed, nothing offers trails or per-resident rankings", async () => {
  const oldBuild = (c) => c.route("**/api/meta", async (r) => {
    const res = await r.fetch(), m = await res.json();
    delete m.poi_counts; delete m.trail_trees;
    m.place_counts = Object.fromEntries(Object.entries(m.place_counts).filter(([k]) => k !== "trail"));
    await r.fulfill({ response: res, json: m });
  });
  const { ctx, page, errors } = await open("/", undefined, B, oldBuild);
  await page.click("#q");
  await page.waitForSelector("#results li[role=option]");
  assert.doesNotMatch(await page.textContent("#results"), /trails/i);
  await ctx.close();
  const top = await open("/?top=planning_area:trees", undefined, B, oldBuild);
  await panelTitle(top.page, "Areas: most trees");
  const chips = await top.page.locator(".chip-btn").allTextContents();
  assert.ok(!chips.includes("Trails") && !chips.includes("Most per resident"), chips.join(", "));
  assert.deepEqual([...errors, ...top.errors], []);
  await top.ctx.close();
});

test("explanations follow the build's own limits, and rankings say how many are listed", async () => {
  const changed = (c) => c.route("**/api/meta", async (r) => {
    const res = await r.fetch(), m = await res.json();
    m.method = { ...m.method, road_max_m: 25, trail_max_m: 20, min_residents: 2000, residents_year: 2030, carbon_max_diameter_cm: 180 };
    await r.fulfill({ response: res, json: m });
  });
  const { ctx, page, errors } = await open("/", undefined, B, changed);
  await page.waitForFunction(() => document.querySelector("#total")?.textContent);
  await page.click("#about");
  const about = (await page.textContent("#panel-body")).replace(/\s+/g, " ");
  for (const re of [/nearest named road within 25 m/, /within 20 m of the route/, /wider than 1\.8 m across/,
    /uses the 2030 census, which counts residents only\. Areas with under 2,000 residents/, /Census of Population 2030/]) assert.match(about, re);
  assert.deepEqual(errors, []);
  await ctx.close();
  // an older build without meta.method: the pipeline's own limits (checked by tests/test_method.py)
  const old = await open("/", undefined, B, (c) => c.route("**/api/meta", async (r) => {
    const res = await r.fetch(), m = await res.json(); delete m.method; await r.fulfill({ response: res, json: m }); }));
  await old.page.waitForFunction(() => document.querySelector("#total")?.textContent);
  await old.page.click("#about");
  assert.match(await old.page.textContent("#panel-body"), /nearest named road within 30 m/);
  await old.ctx.close();
  const top = await open("/?top=road:trees");
  await panelTitle(top.page, "Roads: most trees");
  const listed = await top.page.locator(".ranked li").count();
  assert.match(await top.page.textContent("#panel-body .sub"), new RegExp(`^Top ${listed} in Singapore`));
  await top.ctx.close();
});

// Every live reading at once, the most the weather card ever shows (src/weather.ts gives each of these)
const FULL_WEATHER = (at = new Date(Date.now() - 5 * 60_000).toISOString()) => ({
  reading: { celsius: 31.46, station: "Somerset Road", dist_m: 1234, at },
  heat: { level: "Moderate", wbgt: 31.2, station: "Hong Lim Park", dist_m: 2345, at },
  forecast: { area: "Tanglin", text: "Thundery Showers", from: at, until: new Date(Date.now() + 90 * 60_000).toISOString() },
  rain: { mm: 0.4, station: "Orchard Road Exchange Building", dist_m: 640, at },
  lightning: { dist_m: 3456, at, kind: "Cloud to Ground", count: 4 },
  uv: { index: 9, level: "Very high", at },
  air: { pm25: 72, band: "Elevated", advice: "Healthy people: reduce strenuous outdoor activities for the next hour. Vulnerable people: avoid them.", region: "central", at },
  source: "National Environment Agency, via data.gov.sg",
});
const fullWeather = (c) => c.route("**/api/weather*", (r) => r.fulfill({ json: FULL_WEATHER() }));

test("weather card: every reading names where it's from, lightning first, nothing sticks out", async () => {
  for (const device of ["iPhone SE", "iPhone 15 Pro", "iPad Mini"]) {
    const { ctx, page, errors } = await open("/?near=1.2994,103.8455,250", { ...devices[device], deviceScaleFactor: 1 }, B, fullWeather);
    await page.waitForSelector("#weather:not([hidden]) .wx-rows");
    const card = await page.evaluate(() => {
      const el = document.querySelector("#weather"), r = el.getBoundingClientRect();
      const t = (e) => (e?.textContent || "").replace(/\s+/g, " ").trim();
      const rows = [...el.querySelectorAll(".wx-rows > li")].map((li) => { // "label value · where it's from"
        const src = li.querySelector(".wx-src"), v = li.querySelector(".wx-v");
        return src ? `${t(li.querySelector(".wx-k"))} ${t(v).slice(0, t(v).length - t(src).length).trim()} · ${t(src)}` : t(li);
      });
      const sticksOut = [...el.querySelectorAll("*")].filter((e) => { const b = e.getBoundingClientRect(); return b.width && (b.left < r.left - 0.5 || b.right > r.right + 0.5); }).length;
      return { rows, sticksOut, fits: r.left >= 0 && r.right <= innerWidth, wide: el.scrollWidth > el.clientWidth + 1 };
    });
    assert.ok(card.fits && !card.wide && card.sticksOut === 0, `${device}: ${JSON.stringify(card)}`);
    assert.match(card.rows[0], /Lightning 3\.5 km away .*cloud to ground, 4 strikes within 10 km/);
    const all = card.rows.join(" | ");
    for (const re of [/Raining now 0\.4 mm in 5 min · Orchard Road Exchange Building rain gauge, 640 m/, /Next 2 hours Thundery Showers · Tanglin area, until/,
      /Heat stress Moderate \(WBGT 31\.2 °C\) · Hong Lim Park, 2\.3 km/, /UV index 9 very high · measured at Changi/,
      /Air \(PM2\.5\) 72 µg\/m³ elevated · NEA central region/, /reduce strenuous outdoor activities for the next hour.*\(NEA\)/]) assert.match(all, re, device);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  // without a temperature the other readings still show; the old reply (temperature only) still works
  const t = await open("/?near=1.2994,103.8455,250", undefined, B, (c) => c.route("**/api/weather*", (r) => r.fulfill({ json: { ...FULL_WEATHER(), reading: null } })));
  await t.page.waitForSelector("#weather:not([hidden]) .wx-rows");
  assert.equal(await t.page.$(".weather-temp"), null);
  assert.equal(await t.page.getAttribute("#weather", "data-band"), "none");
  await t.ctx.close();
});

test("temperature card: shown near the top with station and distance, hidden without a fresh reading", async () => {
  const at = new Date(Date.now() - 5 * 60_000).toISOString();
  const reading = (c) => c.route("**/api/weather*", (r) => r.fulfill({ json: {
    reading: { celsius: 31.46, station: "Somerset Road", dist_m: 1234, at }, source: "National Environment Agency, via data.gov.sg" } }));
  for (const opts of [{ ...devices["iPhone 15 Pro"], deviceScaleFactor: 1 }, { viewport: { width: 1280, height: 800 } }]) {
    const { ctx, page, errors } = await open("/?near=1.2994,103.8455,250", opts, B, reading);
    await page.waitForSelector("#weather:not([hidden])");
    const card = await page.evaluate(() => {
      const el = document.querySelector("#weather"), r = el.getBoundingClientRect();
      const tiles = document.querySelector("#panel-body .stats").getBoundingClientRect();
      return { text: el.innerText.replace(/\s+/g, " "), band: el.dataset.band, below: r.top >= tiles.bottom - 1,
        fits: r.left >= 0 && r.right <= innerWidth, tempSize: parseFloat(getComputedStyle(el.querySelector(".weather-temp")).fontSize) };
    });
    assert.match(card.text, /31\.5 ?°C/);
    assert.doesNotMatch(card.text, /Air temperature now/); // the time of the reading says when
    assert.match(card.text, /Somerset Road station/);
    assert.match(card.text, /1\.2 km away/);
    assert.match(card.text, /aren't a measure of how much the trees cool/);
    assert.equal(card.band, "hot");
    assert.ok(card.below && card.fits && card.tempSize >= 28, JSON.stringify(card));
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  // blue is the coolest, red the hottest, on Singapore's scale
  for (const [celsius, band] of [[25.9, "cool"], [26, "mild"], [29, "warm"], [31, "hot"], [33, "very-hot"]]) {
    const t = await open("/?near=1.2994,103.8455,250", undefined, B, (c) => c.route("**/api/weather*", (r) => r.fulfill({ json: {
      reading: { celsius, station: "Somerset Road", dist_m: 500, at } } })));
    await t.page.waitForSelector("#weather:not([hidden])");
    assert.equal(await t.page.getAttribute("#weather", "data-band"), band, `${celsius} °C`);
    await t.ctx.close();
  }
  const none = await open("/?near=1.2994,103.8455,250", undefined, B, (c) => c.route("**/api/weather*", (r) => r.fulfill({ json: { reading: null } })));
  await none.page.waitForSelector("#panel-body h2");
  await none.page.waitForTimeout(500);
  assert.equal(await none.page.isHidden("#weather"), true, "no card, and no empty box, without a reading");
  await none.ctx.close();
});

test("place pages: road story, residents, amenities and heritage", async () => {
  const { ctx, page, errors } = await open("/?p=road/orchard-road");
  await panelTitle(page, "Orchard Road");
  assert.match(await page.textContent("#panel-body"), /About this road[\s\S]*National Library Board/);
  await ctx.close();
  const area = await open("/?p=planning_area/newton");
  await panelTitle(area.page, "Newton");
  assert.match(await area.page.textContent("#panel-body"), /trees per 1,000 residents[\s\S]*2020 census/);
  await area.ctx.close();
  const small = await open("/?p=planning_area/museum");
  await panelTitle(small.page, "Museum");
  assert.match(await small.page.textContent("#panel-body"), /too few for a per-resident figure/);
  await small.ctx.close();
  const near = await open("/?near=1.2994,103.8455,500");
  await near.page.waitForSelector("#panel-body h2");
  assert.match(await near.page.textContent("#panel-body"), /Within 500 m/);
  const first = near.page.locator("#panel-body button[data-poi]").first();
  if (await first.count()) { // a named place (hawker centre or heritage site) opens its card on the map
    await first.click();
    await near.page.waitForSelector(".poi-popup");
  }
  assert.deepEqual([...errors, ...near.errors], []);
  await near.ctx.close();
});

test("recent changes on a place and across Singapore", async () => {
  const { ctx, page, errors, h2 } = await open("/?p=road/orchard-road");
  await panelTitle(page, "Orchard Road");
  await page.click("details.changes summary");
  assert.equal(await page.locator("details.changes li").count(), 6);
  await page.click("details.changes button[data-change=removed]"); // shows where it stood; the place stays open
  assert.equal(await h2(), "Orchard Road");
  await page.click("details.changes button[data-change=added]");
  await page.waitForFunction(() => new URL(location.href).searchParams.has("t"));
  assert.deepEqual(errors, []);
  await ctx.close();
  const all = await open("/?top=changes"); // a separate page, for the reason given above
  await panelTitle(all.page, "Recent changes");
  assert.equal(await all.page.locator("#panel-body button[data-change]").count(), 6);
  assert.equal(all.param("top"), "changes");
  assert.deepEqual(all.errors, []);
  await all.ctx.close();
});

test("a station opens the trees within 250 m", async () => {
  const { ctx, page, errors, h2, param } = await open("/");
  await page.fill("#q", "dhoby ghaut mrt");
  await page.waitForFunction(() => document.querySelector("#results li[role=option]")?.textContent.includes("Dhoby Ghaut MRT Station"));
  await page.keyboard.press("Enter");
  await panelTitle(page, "Dhoby Ghaut MRT Station");
  assert.match(param("near"), /^1\.2994,103\.8455,250$/);
  assert.equal(await h2(), "Dhoby Ghaut MRT Station");
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("near me sends only a rounded position", async () => {
  const { ctx, page, errors } = await open("/", { viewport: { width: 1280, height: 800 }, permissions: ["geolocation"],
    geolocation: { latitude: 1.29941234, longitude: 103.84554321 } });
  const sent = [];
  page.on("request", (r) => r.url().includes("/api/near") && sent.push(r.url()));
  await page.click("#near");
  await page.waitForSelector("#panel-body h2");
  assert.equal(sent.length, 1);
  assert.match(sent[0], /lat=1\.2994&lng=103\.8455&/);
  assert.doesNotMatch(page.url(), /1\.29941|103\.84554/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("tree-type filters are kept in the link", async () => {
  const { ctx, page, param } = await open("/");
  await page.uncheck('#legend-items input[data-c="1"]');
  assert.equal(param("c"), "0,2,3,4,5,6");
  const again = await open(new URL(page.url()).pathname + new URL(page.url()).search);
  assert.equal(await again.page.isChecked('#legend-items input[data-c="1"]'), false);
  assert.equal(await again.page.isChecked('#legend-items input[data-c="2"]'), true);
  await again.ctx.close();
  await ctx.close();
});

test("a slow tree shows a loading card", async () => {
  const { ctx, page } = await open("/?p=road/orchard-road");
  await page.waitForSelector("#tree-list li button");
  await page.route("**/api/tree/*", async (r) => { await new Promise((x) => setTimeout(x, 1500)); await r.continue(); });
  await page.click("#tree-list li:first-child button");
  await page.waitForFunction(() => document.querySelector("#panel-body").textContent.includes("Loading tree"));
  await page.waitForFunction(() => new URL(location.href).searchParams.has("t"));
  await ctx.close();
});

test("a slow answer to an earlier tap doesn't overwrite a newer panel", async () => {
  const { ctx, page, h2 } = await open("/?top=road:trees");
  await panelTitle(page, "Roads: most trees");
  await page.route("**/api/top?kind=tree", async (r) => { await new Promise((x) => setTimeout(x, 1500)); await r.continue(); });
  await page.click('.chip-btn[data-kind="tree"]'); // slow
  await page.click("#about");                      // opened after it, so it must stay
  await page.waitForTimeout(2200);
  assert.equal(await h2(), "About TreeNerd");
  await ctx.close();
});

test("wide screens can't zoom out past the basemap", async () => {
  const { ctx, page } = await open("/", { viewport: { width: 2000, height: 995 } });
  await page.mouse.move(1000, 500);
  for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 600); await page.waitForTimeout(200); }
  await page.waitForTimeout(800);
  const zoom = Number(/#map=([\d.]+)\//.exec(page.url())[1]);
  assert.ok(zoom > 11.1 && zoom < 11.4, `zoom ${zoom}`);
  await ctx.close();
});

test("phone: bottom sheet, collapsed legend, theme toggle", async () => {
  const { ctx, page, errors } = await open("/?p=road/orchard-road", { ...devices["iPhone 13"] });
  await panelTitle(page, "Orchard Road");
  const box = await page.locator("#panel").boundingBox();
  const vp = page.viewportSize();
  assert.ok(box.y > vp.height * 0.3 && Math.abs(box.y + box.height - vp.height) < 2, "sheet sits at the bottom");
  // the close X is drawn large enough to see: an 18-point cross in a 36-point circle
  const x = await page.evaluate(() => {
    const b = document.querySelector("#close"), svg = b.querySelector("svg").getBoundingClientRect();
    return { svg: Math.round(svg.width), circle: parseFloat(getComputedStyle(b, "::before").width) };
  });
  assert.ok(x.svg >= 18 && x.circle >= 36, JSON.stringify(x));
  await page.tap("#close");
  assert.equal(await page.getAttribute("#legend-toggle", "aria-expanded"), "false");
  const before = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.tap("#theme");
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), before);
  assert.deepEqual(errors, []);
  await ctx.close();
});

// ---- iPhone and iPad: the devices TreeNerd is mostly used on
const IOS = [["iPhone portrait", "iPhone 15 Pro"], ["iPhone landscape", "iPhone 15 Pro landscape"],
  ["iPad Mini portrait", "iPad Mini"], ["iPad Pro 11 portrait", "iPad Pro 11"], ["iPad Pro 11 landscape", "iPad Pro 11 landscape"]];
const IOS_VIEWS = ["/", "/?p=road/orchard-road", "/?t=10687021", "/?top=road:trees", "/?top=changes",
  "/?p=trail/central-cycling-paths", "/?p=subzone/ntsz06", "/?near=1.2994,103.8455,250", "/?top=planning_area:per_resident"];

for (const [label, device] of IOS) {
  test(`${label}: every control is at least 44 x 44 points, nothing overlaps or overflows`, async () => {
    for (const path of IOS_VIEWS) {
      // layout is measured in points, so render at 1x: software rendering at an iPad's 2x is very slow
      // the weather card at its fullest, so its rows are measured too
      const { ctx, page, errors } = await open(path, { ...devices[device], deviceScaleFactor: 1 }, B, fullWeather);
      if (path !== "/") await page.waitForSelector("#panel-body h2");
      if (path.startsWith("/?near")) await page.waitForSelector("#weather:not([hidden]) .wx-rows");
      else { await page.tap("#q"); await page.waitForSelector("#results li[role=option]"); }
      const report = await page.evaluate(() => {
        const shown = (e) => { const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
          return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && r.bottom > 0 && r.top < innerHeight; };
        const small = [];
        for (const e of document.querySelectorAll("button, a, input, summary, label, li[role=option], [role=button]")) {
          if (!shown(e)) continue;
          if (e.matches("input[type=checkbox]") && e.closest("label")) continue; // its label is the target
          const r = e.getBoundingClientRect();
          if (r.height < 43.5 || r.width < 43.5) small.push(`${e.tagName.toLowerCase()}${e.id ? "#" + e.id : ""} "${(e.textContent || "").trim().slice(0, 20)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
        }
        const box = (sel) => { const e = document.querySelector(sel); return e && shown(e) ? e.getBoundingClientRect() : null; };
        const hits = (a, b) => a && b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        const legend = box("#legend");
        return { small, overflow: document.documentElement.scrollWidth > innerWidth,
          overlap: ["#theme", "#near", ".search", "#panel"].filter((s) => hits(box(s), legend)) };
      });
      assert.deepEqual(report.small, [], `${path}: controls smaller than 44 points`);
      assert.deepEqual(report.overlap, [], `${path}: overlaps the legend`);
      assert.equal(report.overflow, false, `${path}: page scrolls sideways`);
      assert.deepEqual(errors, []);
      await ctx.close();
    }
  });
}

test("map sources card: one source per line, fits every screen, closes on Escape", async () => {
  const sizes = [["iPhone 15 Pro", { ...devices["iPhone 15 Pro"], deviceScaleFactor: 1 }], ["iPhone landscape", { ...devices["iPhone 15 Pro landscape"], deviceScaleFactor: 1 }],
    ["iPad Mini", { ...devices["iPad Mini"], deviceScaleFactor: 1 }], ["desktop", { viewport: { width: 1280, height: 800 } }], ["small desktop", { viewport: { width: 1024, height: 600 } }]];
  for (const [label, opts] of sizes) {
    const { ctx, page } = await open("/", opts);
    await page.click(".credits-btn");
    const r = await page.evaluate(() => {
      const card = document.querySelector(".credits-panel"), box = card.getBoundingClientRect();
      const rows = [...card.querySelectorAll("li")].map((li) => li.textContent.replace(/\s+/g, " ").trim());
      const touch = matchMedia("(pointer: coarse)").matches;
      const small = touch ? [...card.querySelectorAll("a, button")].filter((e) => e.getBoundingClientRect().height < 43.5).map((e) => e.textContent) : [];
      return { rows, inside: box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight,
        overflow: document.documentElement.scrollWidth > innerWidth, small, expanded: document.querySelector(".credits-btn").getAttribute("aria-expanded"),
        covered: (() => { const l = document.querySelector("#legend").getBoundingClientRect(), legendShown = getComputedStyle(document.querySelector("#legend")).visibility !== "hidden";
          return legendShown && l.left < box.right && box.left < l.right && l.top < box.bottom && box.top < l.bottom; })() };
    });
    assert.equal(r.expanded, "true", label);
    assert.equal(r.rows.length, 4, label);
    assert.match(r.rows[0], /OneMap © contributors \| Singapore Land Authority/, label);
    assert.match(r.rows[1], /Trees\.sg © National Parks Board/, label);
    assert.ok(r.inside, `${label}: the card must sit fully on screen`);
    assert.equal(r.covered, false, `${label}: the legend must not cover the card`);
    assert.equal(r.overflow, false, label);
    assert.deepEqual(r.small, [], `${label}: links in the card must be 44 points tall on touch screens`);
    await page.keyboard.press("Escape");
    assert.equal(await page.isHidden(".credits-panel"), true, label);
    assert.notEqual(await page.evaluate(() => getComputedStyle(document.querySelector("#legend")).visibility), "hidden", `${label}: the legend comes back`);
    await ctx.close();
  }
});

test("iPhone and iPad: the legend starts closed where it would cover the map, and opens on a tap", async () => {
  for (const device of ["iPhone 15 Pro", "iPhone 15 Pro landscape", "iPad Mini"]) {
    const { ctx, page } = await open("/", { ...devices[device], deviceScaleFactor: 1 });
    assert.equal(await page.getAttribute("#legend-toggle", "aria-expanded"), "false", device);
    await page.tap("#legend-toggle");
    assert.equal(await page.getAttribute("#legend-toggle", "aria-expanded"), "true", device);
    await page.tap('#legend-items label:has(input[data-c="1"])');
    assert.equal(await page.isChecked('#legend-items input[data-c="1"]'), false, device);
    await ctx.close();
  }
});

test("iPhone: press and hold the map shows the trees there; a short tap doesn't", async () => {
  const { ctx, page, errors, param } = await open("/#map=17/1.2994/103.8455", { ...devices["iPhone 15 Pro"], deviceScaleFactor: 1 });
  const canvas = page.locator(".maplibregl-canvas");
  const touch = [{ identifier: 1, clientX: 200, clientY: 200 }];
  await canvas.dispatchEvent("touchstart", { touches: touch, changedTouches: touch, targetTouches: touch });
  await page.waitForTimeout(200);
  await canvas.dispatchEvent("touchend", { touches: [], changedTouches: touch, targetTouches: [] });
  await page.waitForTimeout(700);
  assert.equal(param("near"), null, "a short touch must not open anything");
  await canvas.dispatchEvent("touchstart", { touches: touch, changedTouches: touch, targetTouches: touch });
  await page.waitForFunction(() => new URL(location.href).searchParams.has("near"));
  await canvas.dispatchEvent("touchend", { touches: [], changedTouches: touch, targetTouches: [] });
  await page.waitForSelector("#panel-body h2");
  assert.match(await page.textContent("#panel-body h2"), /Trees within 150 m/);
  assert.match(param("near"), /^1\.\d{4},103\.\d{4},150$/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("the dev preview shows its banner; the normal site doesn't", async () => {
  // any host starting with "dev." is a preview; dev.localhost reaches the local server
  const dev = await open("/?p=road/orchard-road", undefined, `http://dev.localhost:${PORT}`);
  assert.match(await dev.page.textContent(".dev-banner"), /DEV PREVIEW/);
  assert.match(await dev.page.getAttribute(".dev-banner a", "href"), /^https:\/\/treenerd\.fyi\/\?p=road\/orchard-road/);
  assert.match(await dev.page.title(), /^\[DEV\] /);
  await dev.ctx.close();
  const live = await open("/");
  assert.equal(await live.page.locator(".dev-banner").count(), 0);
  await live.ctx.close();
});
