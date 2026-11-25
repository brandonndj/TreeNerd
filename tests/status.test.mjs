import { test } from "node:test";
import assert from "node:assert/strict";

const S = await import("../src/status.ts");

test("status: overall level and plain times", () => {
  const sec = (...levels) => [{ title: "x", checks: levels.map((level) => ({ name: "c", level, detail: "d" })) }];
  assert.equal(S.overall(sec("ok", "off")), "ok"); // not set up isn't a fault
  assert.equal(S.overall(sec("ok", "warn")), "warn");
  assert.equal(S.overall(sec("warn", "fail", "ok")), "fail");
  const now = Date.parse("2026-11-25T12:00:00Z");
  assert.equal(S.ago(null, now), "never");
  assert.equal(S.ago(now - 30_000, now), "just now");
  assert.equal(S.ago(now - 20 * 60_000, now), "20 min ago");
  assert.equal(S.ago(now - 5 * 3600_000, now), "5 h ago");
  assert.equal(S.ago(now - 3 * 86400_000, now), "3 days ago");
});

test("status: the page escapes what it shows and has no inline styles", () => {
  const html = S.renderStatus({ generated_at: "2026-11-25T12:00:00Z", overall: "warn",
    sections: [{ title: "T", checks: [{ name: "<b>x</b>", level: "warn", detail: "a & b", ms: 12 }] }] });
  assert.ok(html.includes("&lt;b&gt;x&lt;/b&gt;") && html.includes("a &amp; b · 12 ms"));
  assert.ok(!/<style|style="/.test(html), "the site's CSP allows only the stylesheet");
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
});
