import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { cleanQuery, parseOnemap, titleCase } = await import("../src/geocode.ts");
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url))).results;

test("cleanQuery strips block prefixes and trims", () => {
  assert.equal(cleanQuery("Blk 123 Bishan St 12"), "123 Bishan St 12");
  assert.equal(cleanQuery("  block  5 Tampines "), "5 Tampines");
  assert.equal(cleanQuery("blk. 9 Ang Mo Kio"), "9 Ang Mo Kio");
  assert.equal(cleanQuery("x".repeat(100)).length, 60);
});

test("titleCase keeps acronyms", () => {
  assert.equal(titleCase("ION ORCHARD"), "Ion Orchard");
  assert.equal(titleCase("BISHAN MRT STATION (NS17)"), "Bishan MRT Station (Ns17)");
});

test("postal code search returns tidy Singapore addresses", () => {
  const r = parseOnemap(fixture("onemap_238859.json"));
  assert.ok(r.length >= 1);
  assert.ok(r.every((a) => a.postal === "238859" && a.lat > 1.2 && a.lng > 103.6));
  assert.equal(r[0].name, "The Paragon"); // building before its tenants
});

test("block search returns the block with its postal code", () => {
  const [a] = parseOnemap(fixture("onemap_123_bishan_st_12.json"));
  assert.equal(a.postal, "570123");
  assert.match(a.name, /123 Bishan Street 12/);
});

test("drops results outside Singapore and duplicates, caps the count", () => {
  const base = { SEARCHVAL: "X", ADDRESS: "", POSTAL: "123456", BLK_NO: "", ROAD_NAME: "NIL" };
  const hits = [
    { ...base, LATITUDE: "40.7", LONGITUDE: "-74" },
    ...Array.from({ length: 10 }, (_, i) => ({ ...base, SEARCHVAL: `B${i}`, LATITUDE: "1.3", LONGITUDE: "103.8" })),
    { ...base, SEARCHVAL: "B0", LATITUDE: "1.3", LONGITUDE: "103.8" },
  ];
  const r = parseOnemap(hits);
  assert.equal(r.length, 6);
  assert.equal(new Set(r.map((a) => a.name)).size, 6);
});
