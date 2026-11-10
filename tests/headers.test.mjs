// The page's security headers are written twice: public/_headers (static files) and
// src/pages.ts (the HTML the Worker rewrites). They must not drift apart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { PAGE_HEADERS } = await import("../src/pages.ts");

test("page headers in the Worker match public/_headers", () => {
  const block = readFileSync(new URL("../public/_headers", import.meta.url), "utf8").split(/\n\s*\n/)[0];
  const fromFile = Object.fromEntries(block.split("\n").slice(1).map((l) => {
    const i = l.indexOf(":");
    return [l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim()];
  }));
  for (const [name, value] of Object.entries(PAGE_HEADERS)) assert.equal(fromFile[name], value, name);
});

test("the content security policy stays strict", () => {
  const csp = PAGE_HEADERS["content-security-policy"];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  for (const directive of csp.split(";").filter((d) => /^\s*(script-src|default-src|style-src)\s/.test(d))) {
    assert.doesNotMatch(directive, /'unsafe-inline'|'unsafe-eval'|\*/, directive.trim());
  }
});
