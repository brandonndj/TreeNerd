import { test } from "node:test";
import assert from "node:assert/strict";

const S = await import("../src/schedule.ts");
const DAY = 86400_000, NOW = Date.parse("2026-11-25T12:00:00Z");

test("a missed weekly update is requested, whether or not NParks edited since", () => {
  assert.equal(S.rebuildDue({ now: NOW, builtAt: NOW - 3 * DAY, lastDispatch: 0 }), false, "fresh data: nothing to do");
  assert.equal(S.rebuildDue({ now: NOW, builtAt: NOW - 7.9 * DAY, lastDispatch: 0 }), false, "the weekly run is still due");
  assert.equal(S.rebuildDue({ now: NOW, builtAt: NOW - 9 * DAY, lastDispatch: 0 }), true);
  assert.equal(S.rebuildDue({ now: NOW, builtAt: NaN, lastDispatch: 0 }), true, "no build at all");
});

test("at most one request per 20 hours", () => {
  assert.equal(S.rebuildDue({ now: NOW, builtAt: NOW - 9 * DAY, lastDispatch: NOW - 5 * 3600_000 }), false);
  assert.equal(S.rebuildDue({ now: NOW, builtAt: NOW - 9 * DAY, lastDispatch: NOW - 21 * 3600_000 }), true);
});
