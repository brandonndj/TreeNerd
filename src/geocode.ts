// Pure helpers for OneMap address search (kept separate so they can be unit-tested).

export interface OnemapHit {
  SEARCHVAL: string; ADDRESS: string; POSTAL: string; BLK_NO: string; ROAD_NAME: string;
  LATITUDE: string; LONGITUDE: string;
}
export interface Address { name: string; address: string; postal: string | null; lat: number; lng: number }

/** "Blk 123 Bishan St 12" -> "123 Bishan St 12" (OneMap doesn't understand the prefix). */
export function cleanQuery(q: string) {
  return q.replace(/^\s*(blk|block|bk)\.?\s+/i, "").replace(/\s+/g, " ").trim().slice(0, 60);
}

export const titleCase = (s: string) =>
  s.toLowerCase()
    .replace(/(^|[\s(/-])([a-z])/g, (_, p, c) => p + c.toUpperCase())
    .replace(/\b(Hdb|Mrt|Lrt|Nus|Ntu|Smu|Ite|Cc|Ymca|Ywca)\b/g, (m) => m.toUpperCase());

/** Keep Singapore results, drop duplicates, return at most `max` tidy addresses. */
export function parseOnemap(hits: OnemapHit[], max = 6): Address[] {
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const r of hits) {
    const lat = Number(r.LATITUDE), lng = Number(r.LONGITUDE);
    if (!(lat > 1.1 && lat < 1.5 && lng > 103.5 && lng < 104.2)) continue;
    const postal = /^\d{6}$/.test(r.POSTAL) ? r.POSTAL : null;
    const name = titleCase(r.SEARCHVAL.replace(/\s+SINGAPORE(\s+\d{6})?$/i, "").trim());
    const key = `${postal}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const street = titleCase([r.BLK_NO, r.ROAD_NAME].filter((x) => x && x !== "NIL").join(" "));
    out.push({
      name,
      address: [street !== name ? street : "", postal ? `Singapore ${postal}` : ""].filter(Boolean).join(" · "),
      postal, lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6,
    });
    if (out.length >= max * 2) break;
  }
  // A postal code covers a whole building: put the building itself before its tenants.
  if (out.length > 1 && out.every((a) => a.postal && a.postal === out[0].postal)) {
    const tenant = (n: string) => /\b(pte|ltd|limited|llp|clinic|medical|dental|preschool|centre|center)\b|@/i.test(n);
    out.sort((a, b) => Number(tenant(a.name)) - Number(tenant(b.name)) || a.name.length - b.name.length);
  }
  return out.slice(0, max);
}
