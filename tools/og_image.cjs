// Draws public/og-image.png, the picture shown when a TreeNerd link is shared (1200 x 630).
// It's a fixed image, so it carries no figures from the data: those would go out of date.
//   node tools/og_image.cjs
const { chromium } = require("playwright");
const path = require("path");
const html = `<!doctype html><html><head><style>
  body { margin: 0; width: 1200px; height: 630px; background: #1f3b2d; font-family: Inter, sans-serif;
    display: flex; align-items: center; gap: 128px; padding-left: 150px; box-sizing: border-box; }
  .tree { position: relative; width: 180px; height: 200px; flex: none; }
  .tree i { position: absolute; border-radius: 50%; }
  .trunk { position: absolute; left: 76px; top: 120px; width: 24px; height: 76px; border-radius: 6px; background: #8a5a35; }
  h1 { margin: 0; font-size: 96px; font-weight: 800; letter-spacing: -2px; color: #fff; }
  .tag { margin: 6px 0 34px; font-size: 38px; color: #a6e7b3; }
  .sub { margin: 0 0 34px; font-size: 30px; line-height: 1.4; color: #d3ddd5; max-width: 600px; }
  .url { font-size: 28px; font-weight: 700; color: #69db7c; }
</style></head><body>
  <div class="tree"><div class="trunk"></div>
    <i style="left:16px;top:6px;width:140px;height:140px;background:#2f9e44"></i>
    <i style="left:0;top:56px;width:92px;height:92px;background:#37b24d"></i>
    <i style="left:82px;top:56px;width:92px;height:92px;background:#37b24d"></i>
    <i style="left:40px;top:0;width:92px;height:92px;background:#51cf66"></i></div>
  <div><h1>TreeNerd</h1><p class="tag">Singapore's trees on a map</p>
    <p class="sub">Search by road, park, postal code or species</p><div class="url">treenerd.fyi</div></div>
</body></html>`;
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1200, height: 630 } });
  await p.setContent(html);
  await p.screenshot({ path: path.join(__dirname, "..", "public", "og-image.png") });
  await b.close();
})();
