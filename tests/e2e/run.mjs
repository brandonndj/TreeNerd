// Integration tests: seed a local copy of the site from tests/fixtures/site, run the Worker with
// `wrangler dev`, then run the API and browser tests against it.   Usage: npm run test:e2e
import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

const PORT = process.env.E2E_PORT || "8799";
const STATE = ".wrangler/e2e"; // separate from any local development data
const FIX = "tests/fixtures/site";
const npx = (args, opts = {}) => spawnSync("npx", args, { stdio: ["ignore", "ignore", "inherit"], ...opts });

rmSync(STATE, { recursive: true, force: true });
const steps = [
  ["wrangler", "d1", "execute", "trees", "--env", "e2e", "--local", "--yes", "--persist-to", STATE, "--file", `${FIX}/seed.sql`],
  ...["search.json", "species.json", "trees.pmtiles"].map((f) =>
    ["wrangler", "r2", "object", "put", `trees-data/${f}`, "--env", "e2e", "--file", `${FIX}/${f}`, "--local", "--persist-to", STATE]),
];
// the fixture's build date is fixed; make it yesterday so the site counts as up to date
const yesterday = new Date(Date.now() - 86400e3).toISOString().slice(0, 19) + "Z";
steps.push(["wrangler", "d1", "execute", "trees", "--env", "e2e", "--local", "--yes", "--persist-to", STATE, "--command",
  `UPDATE meta SET value=json_set(value, '$.built_at', '${yesterday}') WHERE key='build'`]);
for (const s of steps) {
  if (npx(s).status !== 0) { console.error("seeding failed:", s.join(" ")); process.exit(1); }
}

// the "e2e" environment (wrangler.jsonc) has the same bindings with a rate limit a fast test run can't hit
const server = spawn("npx", ["wrangler", "dev", "--env", "e2e", "--port", PORT, "--persist-to", STATE, "--log-level", "warn"],
  { stdio: ["ignore", "ignore", "inherit"], detached: true });
const stop = () => { try { process.kill(-server.pid); } catch { /* already gone */ } };
process.on("exit", stop);
process.on("SIGINT", () => process.exit(130));

const base = `http://127.0.0.1:${PORT}`;
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  up = await fetch(`${base}/api/meta`).then((r) => r.ok, () => false);
}
if (!up) { console.error("the local Worker did not start"); process.exit(1); }

const tests = spawnSync("node", ["--test", "--test-concurrency=1", "tests/e2e/api.test.mjs", "tests/e2e/ui.test.mjs"],
  { stdio: "inherit", env: { ...process.env, E2E_BASE: base, E2E_PORT: PORT } });
process.exit(tests.status ?? 1);
