// Typo-tolerant search over roads, parks, areas, PCN loops, constituencies and species.
// The index (search.json, ~1 MB) is built by the pipeline, stored in R2 and kept in isolate memory.

export interface Entry {
  k: string; // kind
  s: string; // slug (or species id)
  n: string; // display name
  a?: string[]; // alternative names
  c: number; // tree count
  b?: number[] | null; // bbox
}

interface Indexed extends Entry {
  tokens: string[];
  full: string;
}

const ABBREV: Record<string, string> = {
  rd: "road", st: "street", str: "street", ave: "avenue", av: "avenue", dr: "drive",
  jln: "jalan", lor: "lorong", lrg: "lorong", bt: "bukit", bkt: "bukit", upp: "upper",
  up: "upper", cres: "crescent", cr: "crescent", pk: "park", ctr: "centre", center: "centre",
  nth: "north", sth: "south", ct: "court", cl: "close", pl: "place", tce: "terrace",
  hts: "heights", gdn: "garden", gdns: "gardens", expy: "expressway", ln: "lane",
  amk: "ang mo kio", cck: "choa chu kang", tpy: "toa payoh", sbg: "singapore botanic gardens",
  ecp: "east coast park", pcn: "park connector", nr: "nature reserve", mt: "mount",
};

const KIND_WEIGHT: Record<string, number> = {
  road: 1, park: 0.97, species: 0.95, planning_area: 0.93, subzone: 0.85,
  heritage_road: 0.9, pcn: 0.9, constituency: 0.8,
};

export function normalise(s: string): string[] {
  const words = s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, "")
    .split(/[^a-z0-9一-鿿஀-௿]+/)
    .filter(Boolean);
  return words.flatMap((w) => (ABBREV[w] ?? w).split(" "));
}

function lev(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

export class SearchIndex {
  private items: Indexed[];

  constructor(entries: Entry[]) {
    this.items = entries.map((e) => {
      const tokens = [...new Set([e.n, ...(e.a ?? [])].flatMap(normalise))];
      return { ...e, tokens, full: normalise(e.n).join(" ") };
    });
  }

  search(q: string, opts: { kinds?: string[]; limit?: number } = {}) {
    const qt = normalise(q);
    if (!qt.length) return [];
    const qfull = qt.join(" ");
    const limit = opts.limit ?? 12;
    const out: { score: number; e: Indexed }[] = [];
    for (const e of this.items) {
      if (opts.kinds && !opts.kinds.includes(e.k)) continue;
      let score = 0;
      let ok = true;
      for (let i = 0; i < qt.length; i++) {
        const t = qt[i];
        const last = i === qt.length - 1;
        let best = 0;
        for (const et of e.tokens) {
          if (et === t) { best = 3; break; }
          if (et.startsWith(t) && (last || t.length >= 3)) best = Math.max(best, last ? 2.5 : 2);
          else if (t.length >= 4 && best < 1.5) {
            const d = lev(t, et.slice(0, Math.max(t.length, et.length)), t.length >= 7 ? 2 : 1);
            if (d <= (t.length >= 7 ? 2 : 1)) best = Math.max(best, d === 1 ? 1.5 : 1);
          }
        }
        if (!best) { ok = false; break; }
        score += best;
      }
      if (!ok) continue;
      if (e.full === qfull) score += 4;
      else if (e.full.startsWith(qfull)) score += 2;
      score += Math.log10(1 + e.c) * 0.6;
      score *= KIND_WEIGHT[e.k] ?? 0.8;
      out.push({ score, e });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, limit).map(({ e, score }) => ({
      kind: e.k, slug: e.s, name: e.n, alt: e.a?.slice(0, 3) ?? [], count: e.c, bbox: e.b ?? null,
      score: Math.round(score * 100) / 100,
    }));
  }
}
