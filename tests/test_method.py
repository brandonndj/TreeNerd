"""The app explains the method with the limits the build used (meta.method). For builds published
before meta.method existed it falls back to METHOD_DEFAULTS in public/app.js, which must match the
pipeline, so a change to a limit in one place can't leave the explanations wrong."""
import json
import math
import re
import unittest
from pathlib import Path

from pipeline import build, extras

ROOT = Path(__file__).resolve().parents[1]
JS = (ROOT / "public" / "app.js").read_text()


def pipeline_method():
    return {"road_max_m": build.ROAD_MAX, "trail_max_m": extras.TRAIL_MAX,
            "station_radius_m": build.JOINS.get("stationRadiusM", 250),
            "carbon_max_diameter_cm": round(build.CARBON_MAX_GIRTH_M / math.pi * 100),
            "min_residents": extras.MIN_RESIDENTS, "residents_year": extras.RESIDENTS_YEAR}


class MethodTests(unittest.TestCase):
    def test_app_defaults_match_the_pipeline(self):
        m = re.search(r"const METHOD_DEFAULTS = (\{[^}]+\});", JS)
        self.assertIsNotNone(m)
        defaults = json.loads(re.sub(r"(\w+):", r'"\1":', m.group(1)))
        self.assertEqual(defaults, pipeline_method())

    def test_build_publishes_the_same_limits(self):
        src = (ROOT / "pipeline" / "build.py").read_text()
        block = src[src.index('"method": {'):src.index("},", src.index('"method": {'))]
        self.assertEqual(set(re.findall(r'"(\w+)":', block)) - {"method"}, set(pipeline_method()))

    def test_no_limit_is_written_into_the_explanations(self):
        about = JS[JS.index("<h3>How it's worked out</h3>"):JS.index("<h3>Feedback</h3>")]
        for fixed in ("within 30 m", "within 15 m", "2.1 m across", "2020 census", "under 1,000 residents"):
            self.assertNotIn(fixed, about, f"'{fixed}' should come from meta.method")
        self.assertNotIn("Top 25", JS, "say how many are listed")


if __name__ == "__main__":
    unittest.main()
