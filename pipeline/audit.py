"""Accuracy audit of a finished build. Run before publishing; a failure stops the update.

    python -m pipeline.audit            # audits build/out

It does not reuse the build's own arithmetic. The generated SQL is loaded into a scratch SQLite
database and checked three ways:

1. Consistency: every figure the site shows for a place or species is re-counted from the tree
   table and must match exactly; totals in the build summary must match; the search index must
   list every place and species with the same counts.
2. Plausibility: coordinates inside Singapore, measurements in range, flagged trees carry no
   carbon estimate, shares (with a road, with a species...) within expected bounds, and the tree
   count close to the previous build's.
3. Source check: a random sample of trees is fetched again from NParks' live service by tree ID
   and compared field by field (species, girth, height band, position).
"""
from __future__ import annotations

import glob
import json
import random
import sqlite3
import sys
from pathlib import Path

from .build import CARBON_MAX_GIRTH_M
from .common import OUT, RAW, SOURCES, http, log

SAMPLE = 300
# Trees can be edited upstream between the fetch and this audit, so a few mismatches are expected.
MAX_SOURCE_MISMATCH = 0.02
PLACE_COLUMNS = {"road": "road_id", "park": "park_id", "subzone": "subzone_id", "planning_area": "pa_id",
                 "pcn": "pcn_id", "constituency": "ed_id", "heritage_road": "hr_id"}


def load(out: Path = OUT) -> sqlite3.Connection:
    db = sqlite3.connect(":memory:")
    for f in sorted(glob.glob(str(out / "d1" / "*.sql"))):
        db.executescript(Path(f).read_text())
    db.row_factory = sqlite3.Row
    return db


def consistency(db: sqlite3.Connection, meta: dict, search: list[dict]) -> list[str]:
    bad: list[str] = []

    def check(ok, msg):
        if not ok:
            bad.append(msg)

    n = db.execute("SELECT count(*) FROM trees").fetchone()[0]
    check(n == meta["tree_count"], f"summary says {meta['tree_count']} trees, table has {n}")
    check(db.execute("SELECT count(DISTINCT id) FROM trees").fetchone()[0] == n, "duplicate tree ids")
    cats = dict(db.execute("SELECT category, count(*) FROM trees GROUP BY 1").fetchall())
    check(cats == meta["category_counts"], f"category counts differ: {cats} vs {meta['category_counts']}")
    check(sum(cats.values()) == n, "category counts don't add up to the tree count")
    check(db.execute("SELECT count(*) FROM species").fetchone()[0] == meta["species_count"], "species count differs from summary")
    kinds = dict(db.execute("SELECT kind, count(*) FROM places GROUP BY 1").fetchall())
    check(kinds == meta["place_counts"], f"place counts differ: {kinds} vs {meta['place_counts']}")

    # every place: trees, species, heritage trees and carbon, re-counted from the tree table
    for kind, col in PLACE_COLUMNS.items():
        rows = db.execute(f"""
            SELECT p.slug, p.tree_count, p.species_count, p.heritage_count, p.carbon_kg,
                   count(t.id) n, count(DISTINCT t.species_id) sp, coalesce(sum(t.category='heritage'), 0) ht,
                   coalesce(sum(t.carbon_kg), 0) carbon
              FROM places p LEFT JOIN trees t ON t.{col}=p.id WHERE p.kind=? GROUP BY p.id""", (kind,)).fetchall()
        for r in rows:
            where = f"{kind}/{r['slug']}"
            check(r["tree_count"] == r["n"], f"{where}: shows {r['tree_count']} trees, has {r['n']}")
            check(r["species_count"] == r["sp"], f"{where}: shows {r['species_count']} species, has {r['sp']}")
            check(r["heritage_count"] == r["ht"], f"{where}: shows {r['heritage_count']} heritage trees, has {r['ht']}")
            check(abs(r["carbon_kg"] - r["carbon"]) <= max(1.0, 1e-6 * r["carbon"]), f"{where}: carbon {r['carbon_kg']} vs {r['carbon']:.1f}")
            check(r["n"] > 0, f"{where}: listed with no trees")
        # a tree must never point at a place that doesn't exist or is of another kind
        orphans = db.execute(f"""SELECT count(*) FROM trees t LEFT JOIN places p ON p.id=t.{col} AND p.kind=?
                                  WHERE t.{col} IS NOT NULL AND p.id IS NULL""", (kind,)).fetchone()[0]
        check(orphans == 0, f"{orphans} trees point at a missing {kind}")
    for r in db.execute("""SELECT s.id, s.tree_count, count(t.id) n FROM species s LEFT JOIN trees t ON t.species_id=s.id
                            GROUP BY s.id HAVING s.tree_count != n OR n = 0"""):
        bad.append(f"species {r['id']}: shows {r['tree_count']} trees, has {r['n']}")
    top = db.execute("SELECT kind, slug, top_species FROM places").fetchall()
    for r in random.Random(1).sample(top, min(200, len(top))):  # top species lists, on a sample
        col = PLACE_COLUMNS[r["kind"]]
        real = dict(db.execute(f"""SELECT species_id, count(*) FROM trees WHERE {col}=(SELECT id FROM places WHERE kind=? AND slug=?)
                                    AND species_id IS NOT NULL GROUP BY 1""", (r["kind"], r["slug"])).fetchall())
        listed = json.loads(r["top_species"] or "[]")
        check(all(real.get(sid) == c for sid, c in listed), f"{r['kind']}/{r['slug']}: top species counts are wrong")
        check(not listed or listed[0][1] == max(real.values()), f"{r['kind']}/{r['slug']}: top species isn't the commonest")

    # the "widest trunks" ranking must be exactly the widest unflagged trunks in the tree table
    listed = [r[0] for r in db.execute("SELECT tree_id FROM top_trees ORDER BY rank")]
    real = [r[0] for r in db.execute("""SELECT id FROM trees WHERE girth_m IS NOT NULL AND coalesce(measure_flag, 0)=0
                                         ORDER BY girth_m DESC, id LIMIT ?""", (len(listed),))]
    check(listed == real and len(listed) == min(25, n), "the widest-trunks ranking doesn't match the tree table")

    # the search index must describe the same places and species as the database
    index = {(e["k"], e["s"]): e["c"] for e in search if e["k"] != "mrt"}
    table = {(r[0], r[1]): r[2] for r in db.execute("SELECT kind, slug, tree_count FROM places")}
    table.update({("species", str(r[0])): r[1] for r in db.execute("SELECT id, tree_count FROM species")})
    check(index == table, f"search index differs from the database in {len(set(index.items()) ^ set(table.items()))} entries")
    return bad


def plausibility(db: sqlite3.Connection, meta: dict, prev_meta: dict | None) -> list[str]:
    bad: list[str] = []

    def check(ok, msg):
        if not ok:
            bad.append(msg)

    one = lambda sql: db.execute(sql).fetchone()[0]
    n = one("SELECT count(*) FROM trees")
    expected = SOURCES["arcgis"]["layers"]["trees"].get("expectedCount")
    check(not expected or n >= 0.9 * expected, f"only {n} trees; about {expected} expected")
    if prev_meta and prev_meta.get("tree_count"):
        change = abs(n - prev_meta["tree_count"]) / prev_meta["tree_count"]
        check(change <= 0.10, f"tree count moved {change:.1%} since the previous build ({prev_meta['tree_count']} -> {n})")
    check(one("SELECT count(*) FROM trees WHERE NOT (lat BETWEEN 1.15 AND 1.49 AND lng BETWEEN 103.59 AND 104.10)") == 0,
          "trees outside Singapore")
    check(one("SELECT count(*) FROM trees WHERE girth_m <= 0 OR girth_m > 100") == 0, "girth out of range")
    # carbon is only estimated where the model applies (see build.py: carbon_skip)
    check(one(f"SELECT count(*) FROM trees WHERE girth_m > {CARBON_MAX_GIRTH_M} AND carbon_kg IS NOT NULL") == 0,
          "carbon estimated for a trunk wider than the model covers")
    check(one("""SELECT count(*) FROM trees t JOIN species s ON s.id=t.species_id
                  WHERE t.carbon_kg IS NOT NULL AND substr(s.family, 1, instr(s.family || ' ', ' ') - 1) IN ('Arecaceae', 'Pandanaceae', 'Poaceae')""") == 0,
          "carbon estimated for a palm, pandan or bamboo")
    check(one("SELECT count(*) FROM trees WHERE (carbon_kg IS NULL) != (carbon_skip IS NOT NULL OR girth_m IS NULL)") == 0,
          "a missing carbon estimate must come with its reason, and only then")
    check((one("SELECT max(carbon_kg) FROM trees") or 0) <= 30_000, "a single tree is credited with more than 30 t of carbon")
    check(one("SELECT count(*) FROM trees WHERE carbon_kg < 0") == 0, "negative carbon")
    check(one("SELECT count(*) FROM trees WHERE measure_flag=1 AND carbon_kg IS NOT NULL") == 0,
          "trees flagged as implausible still carry a carbon estimate")
    check(one("SELECT count(*) FROM trees WHERE girth_m IS NULL AND carbon_kg IS NOT NULL") == 0, "carbon without a girth")
    check(one("SELECT count(*) FROM species WHERE wood_density IS NOT NULL AND NOT (wood_density BETWEEN 0.08 AND 1.5)") == 0,
          "wood density out of range")
    check(one("SELECT count(*) FROM species WHERE native NOT IN (0, 1)") == 0, "origin must be native, non-native or unknown")
    share = lambda col: one(f"SELECT count({col}) FROM trees") / max(n, 1)
    for col, low in (("species_id", 0.97), ("pa_id", 0.99), ("subzone_id", 0.99), ("road_id", 0.70), ("height_band", 0.90), ("girth_m", 0.90)):
        check(share(col) >= low, f"only {share(col):.1%} of trees have {col} (expected at least {low:.0%})")
    check(one("SELECT count(*) FROM trees WHERE measure_flag=1") <= 0.001 * n, "too many trees flagged as implausible")
    wd = meta.get("wood_density") or {}
    if wd.get("trees_by_species"):
        check((wd["trees_by_species"] + wd["trees_by_genus"]) / n >= 0.85, "wood density matched for under 85% of trees")
        check(0.4 <= wd["default"] <= 0.8, f"average wood density {wd['default']} is implausible")
    enr = meta.get("species_enrichment") or {}
    if enr.get("family_tested"):
        check(enr["family_agreement"] >= 0.99 or not enr.get("filled_family"), "species families filled below the accuracy bar")
        check(enr["origin_precision"] >= 1.0 or not enr.get("filled_origin"), "species origins filled below the accuracy bar")
    return bad


def source_check(db: sqlite3.Connection, sample: int = SAMPLE, seed: int | None = None, fetch=None) -> tuple[list[str], int]:
    """Compare a random sample of trees with NParks' live service. Returns (mismatches, trees compared)."""
    from .build import norm_height  # the one shared rule: how a height label maps to a band
    ids = [r[0] for r in db.execute("SELECT id FROM trees")]
    picked = random.Random(seed).sample(ids, min(sample, len(ids)))
    cfg = SOURCES["arcgis"]
    url = f"{cfg['base']}/{cfg['layers']['trees']['path']}/query"
    fetch = fetch or (lambda chunk: json.loads(http(url, data={
        "where": f"Public_treeid IN ({','.join(map(str, chunk))})", "outFields": "Public_treeid,SPCS_CD,GRTH_SIZE,HEIGHT",
        "returnGeometry": "true", "outSR": 4326, "geometryPrecision": 7, "f": "geojson"}))["features"])
    live = {}
    for i in range(0, len(picked), 100):
        for f in fetch(picked[i:i + 100]):
            live.setdefault(int(f["properties"]["Public_treeid"]), []).append(f)
    bad, compared = [], 0
    for tid in picked:
        feats = live.get(tid)
        if not feats:
            bad.append(f"tree {tid}: no longer in NParks' records")
            continue
        compared += 1
        t = db.execute("SELECT * FROM trees WHERE id=?", (tid,)).fetchone()

        def same(f):
            p, (lng, lat) = f["properties"], f["geometry"]["coordinates"][:2]
            girth = float(p["GRTH_SIZE"]) if p.get("GRTH_SIZE") not in (None, "") and float(p["GRTH_SIZE"]) > 0 else None
            sid = int(p["SPCS_CD"]) if str(p.get("SPCS_CD") or "").strip().lstrip("-").isdigit() else None
            diffs = []
            if sid != t["species_id"]:
                diffs.append(f"species {t['species_id']} vs {sid}")
            if (girth is None) != (t["girth_m"] is None) or (girth is not None and abs(girth - t["girth_m"]) > 1e-6):
                diffs.append(f"girth {t['girth_m']} vs {girth}")
            if norm_height(p.get("HEIGHT"))[0] != t["height_band"]:
                diffs.append(f"height {t['height_band']} vs {p.get('HEIGHT')!r}")
            if abs(lng - t["lng"]) > 2e-6 or abs(lat - t["lat"]) > 2e-6:
                diffs.append("position")
            return diffs
        diffs = min((same(f) for f in feats), key=len)  # upstream has a few duplicate records per id
        if diffs:
            bad.append(f"tree {tid}: {', '.join(diffs)}")
    return bad, compared


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    meta = json.loads((OUT / "meta.json").read_text())
    search = json.loads((OUT / "search.json").read_text())
    prev = RAW / "prev_meta.json"
    prev_meta = json.loads(prev.read_text()) if prev.exists() else None
    db = load()
    problems = consistency(db, meta, search) + plausibility(db, meta, prev_meta)
    log(f"audit: consistency and plausibility: {len(problems)} problem(s)")
    if "--offline" not in argv:
        mismatches, compared = source_check(db)
        rate = len(mismatches) / max(compared + len(mismatches), 1)
        log(f"audit: {compared} trees compared with NParks' live records, {len(mismatches)} differ ({rate:.1%})")
        for m in mismatches[:10]:
            log("  ", m)
        if rate > MAX_SOURCE_MISMATCH:
            problems.append(f"{rate:.1%} of sampled trees differ from NParks' live records (limit {MAX_SOURCE_MISMATCH:.0%})")
    for p in problems[:50]:
        log("AUDIT FAILED:", p)
    if problems:
        return 1
    log("audit passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
