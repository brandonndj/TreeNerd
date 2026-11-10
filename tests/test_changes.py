import unittest

from pipeline import changes as ch
from pipeline.wood import WoodDensity

SPECIES = {1: {"common": "Rain Tree", "scientific": "Samanea saman"}}
PLACES = [
    {"id": 7, "kind": "road", "slug": "orchard-road", "name": "Orchard Road"},
    {"id": 9, "kind": "park", "slug": "fort-canning-park", "name": "Fort Canning Park"},
    {"id": 12, "kind": "constituency", "slug": "tanjong-pagar-grc", "name": "Tanjong Pagar GRC"},
]


def tree(i, **kw):
    return {"id": i, "lng": 103.8, "lat": 1.3, "species_id": 1, "girth_m": 1.2, "road_id": None, "park_id": None,
            "subzone_id": None, "pa_id": None, "ed_id": None, **kw}


def prev_row(i, **kw):
    return {"id": str(i), "lng": "103.8", "lat": "1.3", "scientific": "Samanea saman", "common": "Rain Tree",
            "girth_m": "2.5", "road": "", "park": "", "subzone": "", "planning_area": "", **kw}


class DiffTests(unittest.TestCase):
    def test_added_and_removed(self):
        prev = {i: prev_row(i) for i in range(1, 101)}
        prev[100] = prev_row(100, road="Orchard Road")
        trees = [tree(i) for i in range(1, 100)] + [tree(500, road_id=7, ed_id=12)]
        rows, summary = ch.diff(prev, trees, SPECIES, PLACES, "2026-11-17", "2026-11-10")
        self.assertEqual((summary["added"], summary["removed"]), (1, 1))
        added = next(r for r in rows if r["change"] == "added")
        removed = next(r for r in rows if r["change"] == "removed")
        self.assertEqual((added["tree_id"], added["road"], added["constituency"], added["common"]),
                         (500, "orchard-road", "tanjong-pagar-grc", "Rain Tree"))
        # removed trees keep what the previous export said about them
        self.assertEqual((removed["tree_id"], removed["road"], removed["girth_m"], removed["lat"]),
                         (100, "orchard-road", 2.5, 1.3))
        self.assertIsNone(removed["park"])

    def test_no_change(self):
        prev = {i: prev_row(i) for i in range(1, 11)}
        rows, summary = ch.diff(prev, [tree(i) for i in range(1, 11)], SPECIES, PLACES, "2026-11-17", None)
        self.assertEqual((rows, summary["added"], summary["removed"]), ([], 0, 0))

    def test_mass_change_is_not_logged(self):
        # e.g. upstream renumbered its ids, or a download was cut short
        prev = {i: prev_row(i) for i in range(1, 101)}
        rows, summary = ch.diff(prev, [tree(i) for i in range(1, 90)], SPECIES, PLACES, "2026-11-17", None)
        self.assertEqual(rows, [])
        self.assertTrue(summary["skipped"])

    def test_merge_keeps_recent_and_replaces_same_day(self):
        old = [{"tree_id": 1, "change": "added", "seen": "2026-01-01"},
               {"tree_id": 2, "change": "added", "seen": "2026-10-01"},
               {"tree_id": 3, "change": "removed", "seen": "2026-11-17", "v": "old"}]
        new = [{"tree_id": 3, "change": "removed", "seen": "2026-11-17", "v": "new"}]
        out = ch.merge(old, new, "2026-11-17")
        self.assertEqual([(r["tree_id"], r.get("v")) for r in out], [(2, None), (3, "new")])


class WoodDensityTests(unittest.TestCase):
    wd = WoodDensity({"samanea saman": 0.53}, {"samanea": 0.55, "syzygium": 0.7})

    def test_species_then_accepted_name_then_genus(self):
        self.assertEqual(self.wd.lookup([("Samanea", "saman")]), (0.53, "species"))
        # recorded under an old name: the accepted name supplies the species value
        self.assertEqual(self.wd.lookup([("Albizia", "saman"), ("Samanea", "saman")]), (0.53, "species"))
        self.assertEqual(self.wd.lookup([("Syzygium", "grande")]), (0.7, "genus"))
        self.assertEqual(self.wd.lookup([("Syzygium", None)]), (0.7, "genus"))
        self.assertEqual(self.wd.lookup([("Unknownia", "sp")]), (None, None))


if __name__ == "__main__":
    unittest.main()
