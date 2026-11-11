import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import announce  # noqa: E402

OLD = """# Changelog

## 2026-11-09: Launch

### Added
- Map of ~890,000 trees.
- Search for roads.
"""
NEW = """# Changelog

## 2026-11-12: Rankings

### Added
- Rankings: roads with the most trees. Tap the **empty** search box.
- See `/?top=road:trees` and the [guide](https://example.com/guide).

### Fixed
- Counts <b>&</b> labels on small screens.

### Internal
- Integration tests in CI.

## 2026-11-09: Launch

### Added
- Map of ~890,000 trees.
- Search for roads.
- Address search.
"""


class AnnounceTests(unittest.TestCase):
    def test_only_new_visitor_facing_entries(self):
        got = announce.new_entries(OLD, NEW)
        self.assertEqual([(r.split(":")[0], s) for r, s, _ in got],
                         [("2026-11-12", "Added"), ("2026-11-12", "Added"), ("2026-11-12", "Fixed"), ("2026-11-09", "Added")])
        self.assertFalse(any("Integration tests" in b for _, _, b in got))
        self.assertEqual(got[-1][2], "Address search.")

    def test_nothing_new_means_no_message(self):
        self.assertEqual(announce.messages(announce.new_entries(NEW, NEW)), [])
        # a push that only adds developer notes is not announced
        internal_only = NEW.replace("- Integration tests in CI.", "- Integration tests in CI.\n- More tests.")
        self.assertEqual(announce.messages(announce.new_entries(NEW, internal_only)), [])

    def test_message_text(self):
        (msg,) = announce.messages(announce.new_entries(OLD, NEW))
        self.assertTrue(msg.startswith("🌳 <b>TreeNerd update</b>"))
        self.assertIn("<i>Rankings</i>", msg)
        self.assertIn("<b>Added</b>\n• Rankings: roads with the most trees. Tap the <b>empty</b> search box.", msg)
        self.assertIn("• See /?top=road:trees and the guide.", msg)             # code ticks and link syntax removed
        self.assertIn("• Counts &lt;b&gt;&amp;&lt;/b&gt; labels on small screens.", msg)  # HTML from the changelog is escaped
        self.assertNotIn("Internal", msg)
        self.assertTrue(msg.endswith("https://treenerd.fyi"))

    def test_long_updates_are_split_under_the_limit(self):
        big = OLD + "\n## 2026-12-01: Big\n" + "".join(
            f"\n### Part {i}\n" + "".join(f"- Improvement number {i}.{j} with a reasonably long description of what changed.\n" for j in range(12))
            for i in range(8))
        msgs = announce.messages(announce.new_entries(OLD, big))
        self.assertGreater(len(msgs), 1)
        self.assertTrue(all(len(m) <= 4096 for m in msgs))
        self.assertEqual(sum(m.count("• ") for m in msgs), 96)
        self.assertIn("(continued)", msgs[1])


if __name__ == "__main__":
    unittest.main()
