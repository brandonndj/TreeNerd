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
let browser;
before(async () => { browser = await engine.launch(); });
after(() => browser?.close());

async function open(path, ctxOptions = { viewport: { width: 1280, height: 800 } }, origin = B) {
  const ctx = await browser.newContext(ctxOptions);
  await ctx.route(/onemap\.gov\.sg|cloudflareinsights/, (r) => r.abort());
  const page = await ctx.newPage();
  const errors = [], tiles = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => /parse the tile/i.test(m.text()) && errors.push(m.text()));
  page.on("response", (r) => /\/tiles\/\d+\//.test(r.url()) && tiles.push({ url: r.url(), status: r.status() }));
  const trouble = []; // shown if the app fails to start, so a CI failure explains itself
  page.on("console", (m) => m.type() === "error" && trouble.push(`console: ${m.text().slice(0, 200)}`));
  page.on("requestfailed", (r) => !/onemap|cloudflareinsights/.test(r.url()) && trouble.push(`failed: ${r.url()} ${r.failure()?.errorText}`));
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
  // a palm gets no carbon figure, and the card says why
  await page.goto(`${B}/?t=13197918`);
  await page.waitForFunction(() => /Not estimated/.test(document.querySelector("#panel-body")?.textContent || ""));
  assert.match(await page.textContent("#panel-body"), /Not estimated: the model doesn't cover palms/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("old data is labelled as overdue", async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.route(/onemap\.gov\.sg|cloudflareinsights/, (r) => r.abort());
  await ctx.route("**/api/meta", async (r) => {
    const res = await r.fetch();
    await r.fulfill({ response: res, json: { ...(await res.json()), built_at: "2026-01-05T00:00:00Z" } });
  });
  const page = await ctx.newPage();
  await page.goto(B + "/");
  await page.waitForFunction(() => /overdue/.test(document.querySelector("#updated")?.textContent || ""));
  await ctx.close();
});

test("recent changes on a place and across Singapore", async () => {
  const { ctx, page, errors, h2, param } = await open("/?p=road/orchard-road");
  await panelTitle(page, "Orchard Road");
  await page.click("details.changes summary");
  assert.equal(await page.locator("details.changes li").count(), 6);
  await page.click("details.changes button[data-change=removed]"); // shows where it stood; the place stays open
  assert.equal(await h2(), "Orchard Road");
  await page.click("details.changes button[data-change=added]");
  await page.waitForFunction(() => new URL(location.href).searchParams.has("t"));
  await page.goto(`${B}/?top=changes`);
  await panelTitle(page, "Recent changes");
  assert.equal(await page.locator("#panel-body button[data-change]").count(), 6);
  assert.equal(param("top"), "changes");
  assert.deepEqual(errors, []);
  await ctx.close();
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
const IOS_VIEWS = ["/", "/?p=road/orchard-road", "/?t=10687021", "/?top=road:trees", "/?top=changes"];

for (const [label, device] of IOS) {
  test(`${label}: every control is at least 44 x 44 points, nothing overlaps or overflows`, async () => {
    for (const path of IOS_VIEWS) {
      // layout is measured in points, so render at 1x: software rendering at an iPad's 2x is very slow
      const { ctx, page, errors } = await open(path, { ...devices[device], deviceScaleFactor: 1 });
      if (path !== "/") await page.waitForSelector("#panel-body h2");
      else { await page.tap("#q"); await page.waitForSelector("#results li[role=option]"); }
      const report = await page.evaluate(() => {
        const shown = (e) => { const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
          return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && r.bottom > 0 && r.top < innerHeight; };
        const small = [];
        for (const e of document.querySelectorAll("button, a, input, summary, label, li[role=option], [role=button]")) {
          if (!shown(e)) continue;
          if (e.matches("input[type=checkbox]") && e.closest("label")) continue; // its label is the target
          if (e.closest(".maplibregl-ctrl-attrib-inner")) continue;                // links inside the opened credits text
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
