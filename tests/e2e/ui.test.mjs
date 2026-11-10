// Browser tests of the app against the local fixture site (see run.mjs). The basemap is blocked,
// so nothing here depends on an outside service.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, devices } from "playwright";

const B = process.env.E2E_BASE || "http://127.0.0.1:8799";
const PORT = new URL(B).port;
let browser;
before(async () => { browser = await chromium.launch(); });
after(() => browser?.close());

async function open(path, ctxOptions = { viewport: { width: 1280, height: 800 } }, origin = B) {
  const ctx = await browser.newContext(ctxOptions);
  await ctx.route(/onemap\.gov\.sg|cloudflareinsights/, (r) => r.abort());
  const page = await ctx.newPage();
  const errors = [], tiles = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => /parse the tile/i.test(m.text()) && errors.push(m.text()));
  page.on("response", (r) => /\/tiles\/\d+\//.test(r.url()) && tiles.push({ url: r.url(), status: r.status() }));
  await page.goto(origin + path, { waitUntil: "load" });
  await page.waitForSelector("#legend-items label", { state: "attached" }); // the map has loaded and the app is wired
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
