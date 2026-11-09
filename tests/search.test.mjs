// Run with: npm test   (Node 22 strips TypeScript types natively via --experimental-strip-types)
import { test } from "node:test";
import assert from "node:assert/strict";

const { SearchIndex, normalise } = await import("../src/search.ts");

const idx = new SearchIndex([
  { k: "road", s: "orchard-road", n: "Orchard Road", a: ["乌节路"], c: 670 },
  { k: "road", s: "orchid-club-road", n: "Orchid Club Road", c: 10 },
  { k: "road", s: "upper-thomson-road", n: "Upper Thomson Road", c: 5634 },
  { k: "road", s: "jalan-kayu", n: "Jalan Kayu", c: 628 },
  { k: "road", s: "bishan-street-22", n: "Bishan Street 22", c: 256 },
  { k: "road", s: "bishan-street-23", n: "Bishan Street 23", c: 300 },
  { k: "species", s: "3106", n: "Rain Tree", a: ["Samanea saman", "Fabaceae", "雨树"], c: 54382 },
  { k: "park", s: "pasir-ris-park", n: "Pasir Ris Park", c: 5381 },
]);
const top = (q) => idx.search(q, { limit: 3 })[0]?.slug;

test("normalise expands abbreviations", () => {
  assert.deepEqual(normalise("Upp Thomson Rd"), ["upper", "thomson", "road"]);
  assert.deepEqual(normalise("Jln Kayu"), ["jalan", "kayu"]);
});

test("exact, abbreviated and typo queries", () => {
  assert.equal(top("orchard road"), "orchard-road");
  assert.equal(top("orchard rd"), "orchard-road");
  assert.equal(top("orchad road"), "orchard-road");
  assert.equal(top("upp thomson"), "upper-thomson-road");
  assert.equal(top("jln kayu"), "jalan-kayu");
  assert.equal(top("bishan st 22"), "bishan-street-22");
});

test("species by common, scientific and Chinese names", () => {
  assert.equal(top("rain tree"), "3106");
  assert.equal(top("samanea"), "3106");
  assert.equal(top("雨树"), "3106");
});

test("prefix while typing and no false positives", () => {
  assert.equal(top("pasir r"), "pasir-ris-park");
  assert.equal(idx.search("zzzz").length, 0);
});
