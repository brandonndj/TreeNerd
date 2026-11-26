import json
import sqlite3
import unittest
from pathlib import Path

from pipeline import audit
from pipeline.build import CARBON_MAX_GIRTH_M, carbon_skip

SCHEMA = (Path(__file__).resolve().parents[1] / "schema.sql").read_text()


def make_db(trees=None, places=None, species=None):
    """A tiny, internally consistent build: two trees of one species on one road in one area."""
    db = sqlite3.connect(":memory:")
    db.executescript(SCHEMA)
    db.row_factory = sqlite3.Row
    species = species or [(1, "Samanea saman", "Rain Tree", "Fabaceae", 2, 0.53)]
    for sid, sci, common, fam, n, wd in species:
        db.execute("INSERT INTO species (id, scientific, common, family, tree_count, wood_density, native) VALUES (?,?,?,?,?,?,0)",
                   (sid, sci, common, fam, n, wd))
    places = places or [(10, "road", "orchard-road", "Orchard Road", 2, 1, 0, 300.0, "[[1,2]]"),
                        (20, "planning_area", "orchard", "Orchard", 2, 1, 0, 300.0, "[[1,2]]"),
                        (30, "subzone", "orsz01", "Somerset", 2, 1, 0, 300.0, "[[1,2]]")]
    for p in places:
        db.execute("INSERT INTO places (id, kind, slug, name, tree_count, species_count, heritage_count, carbon_kg, top_species) VALUES (?,?,?,?,?,?,?,?,?)", p)
    trees = trees or [(100, 103.83, 1.30, 1, 1.0, "6-9", "street", 100.0, None), (101, 103.84, 1.30, 1, 2.0, "9-12", "street", 200.0, None)]
    for tid, lng, lat, sid, girth, hb, cat, carbon, skip in trees:
        db.execute("""INSERT INTO trees (id, lng, lat, cell, species_id, girth_m, height_band, category, carbon_kg, carbon_skip,
                                         road_id, pa_id, subzone_id, measure_flag) VALUES (?,?,?,0,?,?,?,?,?,?,10,20,30,0)""",
                   (tid, lng, lat, sid, girth, hb, cat, carbon, skip))
    widest = db.execute("SELECT id FROM trees WHERE girth_m IS NOT NULL ORDER BY girth_m DESC, id LIMIT 25").fetchall()
    db.executemany("INSERT INTO top_trees VALUES (?, ?)", [(i + 1, r[0]) for i, r in enumerate(widest)])
    return db


META = {"tree_count": 2, "species_count": 1, "category_counts": {"street": 2},
        "place_counts": {"road": 1, "planning_area": 1, "subzone": 1}}
SEARCH = [{"k": "road", "s": "orchard-road", "c": 2}, {"k": "planning_area", "s": "orchard", "c": 2},
          {"k": "subzone", "s": "orsz01", "c": 2}, {"k": "species", "s": "1", "c": 2},
          {"k": "mrt", "s": "somerset-mrt-station", "c": 5}]


class ConsistencyTests(unittest.TestCase):
    def test_a_consistent_build_passes(self):
        self.assertEqual(audit.consistency(make_db(), META, SEARCH), [])

    def test_a_wrong_place_count_is_caught(self):
        places = [(10, "road", "orchard-road", "Orchard Road", 3, 1, 0, 300.0, "[[1,2]]"),
                  (20, "planning_area", "orchard", "Orchard", 2, 1, 0, 300.0, "[[1,2]]"),
                  (30, "subzone", "orsz01", "Somerset", 2, 1, 0, 300.0, "[[1,2]]")]
        problems = audit.consistency(make_db(places=places), META, SEARCH)
        self.assertTrue(any("road/orchard-road: shows 3 trees, has 2" in p for p in problems), problems)

    def test_wrong_carbon_species_count_and_summary_are_caught(self):
        places = [(10, "road", "orchard-road", "Orchard Road", 2, 4, 0, 999.0, "[[1,1]]"),
                  (20, "planning_area", "orchard", "Orchard", 2, 1, 0, 300.0, "[[1,2]]"),
                  (30, "subzone", "orsz01", "Somerset", 2, 1, 0, 300.0, "[[1,2]]")]
        problems = "\n".join(audit.consistency(make_db(places=places), {**META, "tree_count": 5}, SEARCH))
        for expected in ("summary says 5 trees", "shows 4 species, has 1", "carbon 999.0", "top species counts are wrong"):
            self.assertIn(expected, problems)

    def test_a_wrong_widest_trunks_ranking_is_caught(self):
        db = make_db()
        db.execute("UPDATE top_trees SET tree_id=100 WHERE rank=1")  # the thinner tree listed first
        self.assertTrue(any("widest-trunks ranking" in p for p in audit.consistency(db, META, SEARCH)))

    def test_a_stale_search_index_is_caught(self):
        stale = [dict(e, c=1) if e["s"] == "orchard-road" else e for e in SEARCH]
        self.assertTrue(any("search index differs" in p for p in audit.consistency(make_db(), META, stale)))

    def test_a_species_count_that_is_off_is_caught(self):
        db = make_db(species=[(1, "Samanea saman", "Rain Tree", "Fabaceae", 7, 0.53)])
        self.assertTrue(any("species 1: shows 7 trees, has 2" in p for p in audit.consistency(db, META, SEARCH)))


class TreeConservationAreaTests(unittest.TestCase):
    """Areas have no id column on trees: trees carry the area's name, and the audit re-counts by it."""

    def build(self, shown=2, categories=None, tca_names=("Central Tree Conservation Area",) * 2, bbox=(103.8, 1.29, 103.85, 1.31)):
        db = make_db()
        db.execute("""INSERT INTO places (id, kind, slug, name, tree_count, species_count, heritage_count, carbon_kg, top_species, extra, bbox)
                      VALUES (40, 'tca', 'central-tree-conservation-area', 'Central Tree Conservation Area', ?, 1, 0, 300.0, '[[1,2]]', ?, ?)""",
                   (shown, json.dumps({"categories": categories or {"street": 2}}), json.dumps(bbox)))
        for tid, name in zip((100, 101), tca_names):
            db.execute("UPDATE trees SET tca=? WHERE id=?", (name, tid))
        meta = {**META, "place_counts": {**META["place_counts"], "tca": 1}}
        search = SEARCH + [{"k": "tca", "s": "central-tree-conservation-area", "c": shown}]
        return "\n".join(audit.consistency(db, meta, search))

    def test_consistent_area_passes(self):
        self.assertEqual(self.build(), "")

    def test_wrong_count_types_or_unknown_area_are_caught(self):
        self.assertIn("tca/central-tree-conservation-area: shows 3 trees", self.build(shown=3))
        self.assertIn("tree types", self.build(categories={"street": 1, "park": 1}))
        self.assertIn("in a Tree Conservation Area that has no page", self.build(tca_names=("Central Tree Conservation Area", "Elsewhere")))
        self.assertIn("map extent", self.build(bbox=(103.835, 1.29, 103.85, 1.31)))  # misses the tree at 103.83


class ParkPathTests(unittest.TestCase):
    def problems(self, paths, summary, kind="park"):
        db = make_db()
        db.execute("""INSERT INTO places (id, kind, slug, name, tree_count, species_count, heritage_count, carbon_kg, top_species, extra)
                      VALUES (50, ?, 'p', 'P', 0, 0, 0, 0, '[]', ?)""", (kind, json.dumps({"paths": paths})))
        meta = {**META, "park_paths": summary, "place_counts": {**META["place_counts"], kind: META["place_counts"].get(kind, 0) + 1}}
        return "\n".join(audit.consistency(db, meta, SEARCH + [{"k": kind, "s": "p", "c": 0}]))

    def test_consistent_paths_pass(self):
        got = self.problems({"paths_km": 2.4, "cycling_km": 1.1, "boardwalk_km": 0.2, "has_stairs": True}, {"parks": 1, "km": 2.4})
        self.assertNotIn("path", got)

    def test_impossible_or_misplaced_figures_are_caught(self):
        self.assertIn("don't add up", self.problems({"paths_km": 1.0, "cycling_km": 3.0, "boardwalk_km": 0, "has_stairs": False}, {"parks": 1, "km": 1.0}))
        self.assertIn("differ from the summary", self.problems({"paths_km": 1.0, "cycling_km": 0, "boardwalk_km": 0, "has_stairs": False}, {"parks": 2, "km": 9.0}))
        self.assertIn("isn't a park", self.problems({"paths_km": 1.0, "cycling_km": 0, "boardwalk_km": 0, "has_stairs": False}, {"parks": 1, "km": 1.0}, kind="road"))


class PlausibilityTests(unittest.TestCase):
    def problems(self, trees, prev=None, species=None):
        meta = {**META, "tree_count": len(trees)}
        return "\n".join(audit.plausibility(make_db(trees=trees, species=species), meta, prev))

    def test_carbon_rules(self):
        t = lambda **kw: tuple({**dict(id=100, lng=103.83, lat=1.30, sid=1, girth=1.0, hb="6-9", cat="street", carbon=100.0, skip=None), **kw}.values())
        self.assertIn("wider than the model covers", self.problems([t(girth=CARBON_MAX_GIRTH_M + 1, carbon=5000.0)]))
        self.assertIn("more than 30 t", self.problems([t(carbon=40_000.0)]))
        self.assertIn("must come with its reason", self.problems([t(carbon=None)]))
        self.assertIn("must come with its reason", self.problems([t(skip="wide")]))
        self.assertIn("palm", self.problems([t()], species=[(1, "Roystonea regia", "Royal Palm", "Arecaceae (Palmae)", 1, None)]))
        self.assertIn("outside Singapore", self.problems([t(lat=3.1)]))

    def test_a_big_swing_in_tree_count_is_caught(self):
        t = (100, 103.83, 1.30, 1, 1.0, "6-9", "street", 100.0, None)
        self.assertIn("since the previous build", self.problems([t], prev={"tree_count": 1000}))


class PreviousBuildTests(unittest.TestCase):
    """A source that quietly failed to download must stop the update, not publish a site without it."""

    def problems(self, meta_extra, prev):
        t = [(100, 103.83, 1.30, 1, 1.0, "6-9", "street", 100.0, None), (101, 103.84, 1.30, 1, 2.0, "9-12", "street", 200.0, None)]
        meta = {**META, "tree_count": 2, **meta_extra}
        return "\n".join(audit.plausibility(make_db(trees=t), meta, {"tree_count": 2, **prev}))

    def test_steady_counts_pass(self):
        same = {"place_counts": {"road": 100, "trail": 40}, "poi_counts": {"Toilet": 130, "Hawker centre": 120}, "trail_trees": 9000}
        got = self.problems(same, same)
        self.assertNotIn("previous update", got)

    def test_a_missing_layer_is_caught(self):
        prev = {"place_counts": {"road": 100, "trail": 40}, "poi_counts": {"Toilet": 130, "Hawker centre": 120, "Jetty": 5}, "trail_trees": 9000}
        now = {"place_counts": {"road": 100}, "poi_counts": {"Toilet": 130}, "trail_trees": 0}
        got = self.problems(now, prev)
        for expected in ("0 trail places, down from 40", "0 Hawker centre points, down from 120", "0 trees on trails, down from 9000"):
            self.assertIn(expected, got)
        self.assertNotIn("Jetty", got, "classes under 10 may come and go")


class SourceCheckTests(unittest.TestCase):
    def feature(self, tid, **props):
        return {"properties": {"Public_treeid": tid, "SPCS_CD": 1, "GRTH_SIZE": 1.0, "HEIGHT": "6m - 9m", **props},
                "geometry": {"coordinates": [103.83, 1.30]}}

    def test_matching_and_differing_trees(self):
        db = make_db()
        live = {100: self.feature(100), 101: self.feature(101, GRTH_SIZE=2.0, HEIGHT=">9 but ≤12")}
        fetch = lambda ids: [json.loads(json.dumps(live[i])) for i in ids if i in live]
        live[101]["geometry"]["coordinates"] = [103.84, 1.30]
        self.assertEqual(audit.source_check(db, fetch=fetch, seed=1), ([], 2))
        live[101]["properties"]["SPCS_CD"] = 9
        live[101]["properties"]["GRTH_SIZE"] = 3.5
        bad, compared = audit.source_check(db, fetch=fetch, seed=1)
        self.assertEqual(compared, 2)
        self.assertEqual(len(bad), 1)
        self.assertIn("species 1 vs 9", bad[0])
        self.assertIn("girth 2.0 vs 3.5", bad[0])
        del live[100]
        self.assertTrue(any("tree 100: no longer in NParks' records" in b for b in audit.source_check(db, fetch=fetch, seed=1)[0]))


class CarbonSkipTests(unittest.TestCase):
    def test_reasons(self):
        self.assertIsNone(carbon_skip(1.2, "Fabaceae (Leguminosae)", 0))
        self.assertEqual(carbon_skip(1.2, "Arecaceae (Palmae)", 0), "palm")
        self.assertEqual(carbon_skip(51.0, "Moraceae", 0), "wide")
        self.assertEqual(carbon_skip(6.66, "Moraceae", 0), None)
        self.assertEqual(carbon_skip(1.2, "Fabaceae", 1), "flag")
        self.assertIsNone(carbon_skip(None, None, 0))


if __name__ == "__main__":
    unittest.main()
