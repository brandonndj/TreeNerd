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


class HeritageTests(unittest.TestCase):
    def test_location_cleanup(self):
        from pipeline.build import heritage_location as loc
        self.assertEqual(loc("Common Name : Black Rosewood. Found in Fort Canning Park, Fort Green"),
                         "Found in Fort Canning Park, Fort Green")
        self.assertIsNone(loc("Common Name : Rain Tree. Found in"))
        self.assertEqual(loc("Common Name : Mangrove Apple. Found in Pulau Ubin,  near Chek Jawa"),
                         "Found in Pulau Ubin, near Chek Jawa")
        self.assertIsNone(loc(None))


class MeasurementTests(unittest.TestCase):
    def test_flags_trunk_too_wide_for_height(self):
        from pipeline.build import implausible_measurements as bad
        self.assertTrue(bad(15.0, 9, "Tabebuia rosea", "Bignoniaceae"))     # 4.8 m across, under 9 m tall
        self.assertTrue(bad(4.0, 3, "Tristaniopsis whiteana", "Myrtaceae"))  # 1.3 m across, under 3 m tall
        self.assertFalse(bad(4.5, 21, "Pterocarpus indicus", "Fabaceae"))   # big but plausible
        self.assertFalse(bad(33.0, 27, "Ficus caulocarpa", "Moraceae"))     # aerial roots: exempt
        self.assertFalse(bad(12.0, 12, "Metroxylon sagu", "Arecaceae (Palmae)"))  # clumping palm: exempt
        self.assertFalse(bad(None, 9, "Samanea saman", "Fabaceae"))


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


class AreaShapeTests(unittest.TestCase):
    def test_outline_is_the_published_boundary(self):
        from pipeline.extras import area_shapes
        ring = [[103.80, 1.30, 0], [103.80000001, 1.305, 0], [103.8000004, 1.31, 0], [103.81, 1.31, 0], [103.81, 1.30, 0], [103.80, 1.30, 0]]
        square = {"type": "Feature", "properties": {}, "geometry": {"type": "Polygon", "coordinates": [ring]}}
        f = area_shapes([(square, "an-area", "An Area")])["features"][0]
        self.assertEqual(f["properties"], {"s": "an-area", "n": "An Area"})
        out = f["geometry"]["coordinates"][0]
        self.assertEqual(len(out), len(ring), "every point of the boundary is kept (none here are within 10 cm of another)")
        # the same points (the ring may start at another corner), each within ~10 cm of NParks'
        for x0, y0, _ in ring:
            self.assertTrue(any(abs(x - x0) <= 1e-6 and abs(y - y0) <= 1e-6 for x, y in out), (x0, y0))


class SpeciesChecklistFallbackTests(unittest.TestCase):
    """If Kew can't be reached, the update uses the last copy instead of stopping."""

    def run_fetch(self, existing_size, fails):
        import tempfile
        from pathlib import Path
        from unittest import mock
        from pipeline import enrich, fetch
        with tempfile.TemporaryDirectory() as d:
            zp = Path(d) / "wcvp.zip"
            if existing_size:
                zp.write_bytes(b"x" * existing_size)
            boom = mock.Mock(side_effect=OSError("kew is down")) if fails else mock.Mock(return_value=b"new")
            with mock.patch.object(enrich, "WCVP_ZIP", zp), mock.patch.object(fetch, "http", boom), mock.patch.object(fetch, "log"):
                fetch.fetch_species_reference()
            return zp.read_bytes()[:3] if zp.exists() else None

    def test_fresh_download_replaces_the_copy(self):
        self.assertEqual(self.run_fetch(20_000_000, fails=False), b"new")

    def test_kept_copy_is_used_when_kew_is_down(self):
        self.assertEqual(self.run_fetch(20_000_000, fails=True), b"xxx")

    def test_no_usable_copy_still_fails_loudly(self):
        with self.assertRaises(OSError):
            self.run_fetch(0, fails=True)
        with self.assertRaises(OSError):
            self.run_fetch(500, fails=True)  # a stub, not a real checklist


class ParkNameTests(unittest.TestCase):
    def test_sections_of_one_park_become_one(self):
        from pipeline.build import park_display_names
        names = ["Singapore Botanic Gardens LC Zone 1 (TNC)", "Singapore Botanic Gardens LC Arbo/Prc/Pru",
                 "Bishan-Ang Mo Kio Park (Pond Gardens)", "Bishan-Ang Mo Kio Park (River Plains)",
                 "Jubilee Park (FCP)", "Hoover Park (Lor Pisang Hijau Playground)", "Pasir Ris Park"]
        self.assertEqual(park_display_names(names), [
            "Singapore Botanic Gardens", "Singapore Botanic Gardens", "Bishan-Ang Mo Kio Park", "Bishan-Ang Mo Kio Park",
            "Jubilee Park (FCP)", "Hoover Park (Lor Pisang Hijau Playground)", "Pasir Ris Park"])

    def test_a_lone_zone_keeps_its_name(self):
        from pipeline.build import park_display_names
        self.assertEqual(park_display_names(["Somewhere LC Zone 1 (X)"]), ["Somewhere LC Zone 1 (X)"])
        # East Coast Park's areas are named areas, not sections: they stay separate
        self.assertEqual(park_display_names(["East Coast Park Area A", "East Coast Park Area B"]), ["East Coast Park Area A", "East Coast Park Area B"])
