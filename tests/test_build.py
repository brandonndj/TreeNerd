import unittest

import numpy as np
import shapely

from pipeline.build import (
    carbon_estimate, cell_of, clean_scientific, girth_band, norm_height, q, road_join, title, to_svy21,
)


class HeightTests(unittest.TestCase):
    def test_variants(self):
        cases = {
            "6-9": ("6-9", 9), "6m - 9m": ("6-9", 9), ">6 but ≤9": ("6-9", 9), ">6m but ≤9m": ("6-9", 9),
            "<3": ("0-3", 3), "≤3": ("0-3", 3), "<=3": ("0-3", 3), "0m - 3m": ("0-3", 3),
            " 12-15": ("12-15", 15), "7": ("6-9", 9), "2": ("0-3", 3),
            ">24": (">24", 27), "> 24": (">24", 27), "more than 24m": (">24", 27), "21m - 24m": ("21-24", 24),
        }
        for raw, want in cases.items():
            self.assertEqual(norm_height(raw), want, raw)

    def test_unknown(self):
        for raw in (None, "", "-1", "abc"):
            self.assertEqual(norm_height(raw), (None, None), raw)


class CleaningTests(unittest.TestCase):
    def test_girth_band(self):
        self.assertEqual([girth_band(g) for g in (0.3, 0.5, 0.8, 1.2, 4.5)],
                         ["0-0.5", "0-0.5", "0.5-1.0", "1.0-1.5", ">1.5"])

    def test_scientific(self):
        self.assertEqual(clean_scientific("Hopea odorata Roxb."), "Hopea odorata")
        self.assertEqual(clean_scientific("Andira inermis (W.Wright) Kunth ex DC."), "Andira inermis")
        self.assertEqual(clean_scientific("Wild Species"), "Wild Species")

    def test_title(self):
        self.assertEqual(title("PUNGGOL WATERWAY PK"), "Punggol Waterway Park")
        self.assertEqual(title("MARINE PARADE-BRADDELL HEIGHTS GRC"), "Marine Parade-Braddell Heights GRC")
        self.assertEqual(title("ST. JOHN'S ISLAND"), "St. John's Island")
        self.assertEqual(title("KENT RIDGE PARK (PHASE II)"), "Kent Ridge Park (Phase II)")

    def test_sql_quote(self):
        self.assertEqual(q("O'Reilly"), "'O''Reilly'")
        self.assertEqual(q(None), "NULL")
        self.assertEqual(q(float("nan")), "NULL")
        self.assertEqual(q([1, "a"]), "'[1,\"a\"]'")


class CarbonTests(unittest.TestCase):
    def test_monotonic_and_plausible(self):
        small, big = carbon_estimate(0.5, 6), carbon_estimate(3.0, 21)
        self.assertLess(small, big)
        self.assertTrue(10 < small < 200, small)
        self.assertTrue(1000 < big < 10000, big)
        self.assertIsNone(carbon_estimate(None, 9))


class SpatialTests(unittest.TestCase):
    def test_cell_matches_worker(self):
        # must equal cellOf() in src/worker.ts
        self.assertEqual(cell_of(1.3048, 103.8318), int((1.3048 - 1.1) * 500) * 1000 + int((103.8318 - 103.5) * 500))

    def test_road_join_prefers_real_road_over_walkway(self):
        # tree 6 m from a pedestrian promenade and 12 m from the main road -> main road wins
        pts = to_svy21(shapely.points([(103.8300, 1.3000)]))
        lines = to_svy21([
            shapely.LineString([(103.8290, 1.3000 + 6 / 111320), (103.8310, 1.3000 + 6 / 111320)]),
            shapely.LineString([(103.8290, 1.3000 - 12 / 111320), (103.8310, 1.3000 - 12 / 111320)]),
        ])
        idx, dist = road_join(pts, np.asarray(lines), ["pedestrian", "primary"], 30, "test")
        self.assertEqual(idx[0], 1)
        self.assertAlmostEqual(dist[0], 12, delta=0.5)


if __name__ == "__main__":
    unittest.main()
