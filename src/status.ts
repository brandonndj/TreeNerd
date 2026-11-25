// The /status page: whether every service TreeNerd depends on is working, for the owner. It isn't linked
// from the site and isn't indexed, and it never shows a secret's value, only whether one is set.
// The Worker gathers the report (statusReport in worker.ts); this file only renders it.

export type Level = "ok" | "warn" | "fail" | "off";
export interface Check { name: string; level: Level; detail: string; ms?: number }
export interface Section { title: string; note?: string; checks: Check[] }
export interface Report { generated_at: string; overall: Level; sections: Section[] }

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]!));
const LABEL: Record<Level, string> = { ok: "OK", warn: "Check", fail: "Failing", off: "Not set up" };
const ICON: Record<Level, string> = { ok: "✓", warn: "!", fail: "✕", off: "–" };

/** The worst level among the checks; "off" (not set up) counts as fine. */
export function overall(sections: Section[]): Level {
  const all = sections.flatMap((s) => s.checks.map((c) => c.level));
  return all.includes("fail") ? "fail" : all.includes("warn") ? "warn" : "ok";
}

/** "3 min ago", "5 h ago", "2 days ago" for a timestamp (ms), or "never". */
export function ago(t: number | null | undefined, now = Date.now()) {
  if (!t || !Number.isFinite(t)) return "never";
  const s = Math.max(0, (now - t) / 1000);
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

export function renderStatus(r: Report) {
  const rows = (c: Check) => `<li class="${c.level}"><span class="i" aria-hidden="true">${ICON[c.level]}</span>
    <span class="n">${esc(c.name)}</span><span class="l">${LABEL[c.level]}</span>
    <span class="d">${esc(c.detail)}${c.ms != null ? ` · ${c.ms} ms` : ""}</span></li>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">
<title>TreeNerd status</title><link rel="stylesheet" href="/status.css"></head><body>
<h1>TreeNerd status <span class="badge ${r.overall}">${r.overall === "ok" ? "All working" : r.overall === "warn" ? "Needs a look" : "Something is failing"}</span></h1>
<p class="muted">Checked ${esc(new Date(r.generated_at).toLocaleString("en-SG", { timeZone: "Asia/Singapore", dateStyle: "medium", timeStyle: "medium" }))} (Singapore time). Live checks run when this page loads and are reused for 30 seconds. Secrets are never shown, only whether they're set.</p>
${r.sections.map((s) => `<section><h2>${esc(s.title)}</h2>${s.note ? `<p class="muted">${esc(s.note)}</p>` : ""}<ul>${s.checks.map(rows).join("")}</ul></section>`).join("")}
<p class="muted">Machine-readable: <a href="/status.json">/status.json</a></p>
</body></html>`;
}
