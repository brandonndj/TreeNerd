"""Every set of colours that carries meaning must stay distinguishable with colour blindness.

Colours are read from the site's own files, so a change to public/app.css or public/app.js that brings
back colours that blur together (for example the old green and orange for native / non-native) fails here.
"""
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import colours  # noqa: E402

CSS = (ROOT / "public" / "app.css").read_text()
JS = (ROOT / "public" / "app.js").read_text()
TYPES = ["street", "park", "botanic", "user", "conservation", "heritage"]
MIN_APART = 15     # CIEDE2000; about 10 is hard to tell apart, under 5 looks the same
MIN_ON_MAP = 20    # tree dots against the map's background
MAP_BG = {"light": "#eef0ea", "dark": "#0f1411"}
PANEL_BG = {"light": "#ffffff", "dark": "#18201b"}


def css_vars(block: str) -> dict:
    return dict(re.findall(r"--(c-[a-z]+):\s*(#[0-9a-fA-F]{6})", block))


LIGHT = css_vars(CSS[: CSS.index("@media (prefers-color-scheme: dark)")])
DARK = css_vars(CSS[CSS.index(":root[data-theme=\"dark\"]"):])
THEMES = {"light": LIGHT, "dark": DARK}


class ColourBlindnessTests(unittest.TestCase):
    def assertApart(self, colours_, label, minimum=MIN_APART):
        for vision in colours.VISION:
            d, a, b = colours.closest(colours_, vision)
            self.assertGreaterEqual(d, minimum, f"{label}: {a} and {b} look alike with {vision} vision (ΔE {d:.1f})")

    def test_tree_types(self):
        for theme, v in THEMES.items():
            pal = {t: v[f"c-{t}"] for t in TYPES}
            self.assertApart(pal, f"tree types ({theme})")
            for vision in colours.VISION:
                d, k = colours.against(pal, MAP_BG[theme], vision)
                self.assertGreaterEqual(d, MIN_ON_MAP, f"{k} dots fade into the {theme} map with {vision} vision (ΔE {d:.1f})")

    def test_origin_and_changes(self):
        for theme, v in THEMES.items():  # native / non-native / unknown, and + added / − removed
            self.assertApart({"native": v["c-street"], "non-native": v["c-user"], "unknown": v["c-other"]}, f"origin ({theme})")
            self.assertApart({"added": v["c-street"], "removed": v["c-heritage"]}, f"changes ({theme})")
        self.assertIn('["1", "Native", "var(--c-street)"], ["0", "Non-native", "var(--c-user)"]', JS)
        self.assertIn(".delta.plus { color: var(--c-street); }", CSS)
        self.assertIn(".delta.minus { color: var(--c-heritage); }", CSS)

    def test_temperature_bands(self):
        bands = dict(re.findall(r'\.weather-card\[data-band="([a-z-]+)"\] \{ --w: (#[0-9a-fA-F]{6}); \}', CSS))
        self.assertEqual(list(bands), ["cool", "mild", "warm", "hot", "very-hot"])
        self.assertApart(bands, "temperature bands")

    def test_amenity_rings(self):
        for theme in ("light", "dark"):
            block = re.search(theme + r": \{ heritage: \"(#\w{6})\", hawker: \"(#\w{6})\", amenity: \"(#\w{6})\" \}", JS)
            self.assertIsNotNone(block, f"POI_COLORS.{theme} not found")
            self.assertApart(dict(zip(("heritage", "hawker", "amenity"), block.groups())), f"amenity rings ({theme})")
        self.assertIn('"circle-color": dark() ? "#0f1411" : "#ffffff"', JS, "amenities are hollow rings, not filled dots")


if __name__ == "__main__":
    unittest.main()
