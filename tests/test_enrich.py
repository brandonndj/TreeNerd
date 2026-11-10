import io
import tempfile
import unittest
import zipfile
from pathlib import Path

from pipeline.enrich import WCVP, enrich_species, norm_family, parse, score

NAMES = ["plant_name_id", "taxon_rank", "taxon_status", "family", "genus", "species", "infraspecies",
         "taxon_name", "taxon_authors", "accepted_plant_name_id"]
DIST = ["plant_name_id", "continent_code_l1", "area_code_l3", "introduced", "extinct", "location_doubtful"]


def mini_wcvp(path: Path):
    names = [
        # id, rank, status, family, genus, species, infra, name, authors, accepted
        ("1", "Species", "Accepted", "Fabaceae", "Samanea", "saman", "", "Samanea saman", "(Jacq.) Merr.", "1"),
        ("2", "Species", "Accepted", "Clusiaceae", "Garcinia", "parviflora", "", "Garcinia parviflora", "(Benth.) Miq.", "2"),
        ("3", "Species", "Synonym", "Quiinaceae", "Garcinia", "parviflora", "", "Garcinia parviflora", "Aubl.", "4"),
        ("4", "Species", "Accepted", "Quiinaceae", "Quiina", "guianensis", "", "Quiina guianensis", "Aubl.", "4"),
        ("5", "Species", "Synonym", "Myrtaceae", "Syzygium", "gratum", "", "Syzygium gratum", "(Wight) S.N.Mitra", "6"),
        ("6", "Species", "Accepted", "Myrtaceae", "Syzygium", "antisepticum", "", "Syzygium antisepticum", "(Blume) Merr. & L.M.Perry", "6"),
        ("7", "Genus", "Accepted", "Apocynaceae", "Plumeria", "", "", "Plumeria", "L.", "7"),
        ("8", "Species", "Accepted", "Vitaceae", "Leea", "indica", "", "Leea indica", "(Burm.f.) Merr.", "8"),
        ("9", "Species", "Accepted", "Malvaceae", "Brachychiton", "acerifolius", "", "Brachychiton acerifolius", "F.Muell.", "9"),
    ]
    dist = [
        ("1", "8", "VEN", "0", "0", "0"), ("1", "4", "MLY", "1", "0", "0"),   # S. America, introduced in Malaya
        ("2", "4", "MLY", "0", "0", "0"),
        ("4", "8", "GUY", "0", "0", "0"),
        ("6", "4", "MLY", "0", "0", "0"),
        ("8", "4", "IND", "0", "0", "0"),                                      # native to Asia, not Malaya
        ("9", "5", "QLD", "0", "0", "0"),                                      # Australia
    ]
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("wcvp_names.csv", "\n".join(["|".join(NAMES)] + ["|".join(r) for r in names]) + "\n")
        z.writestr("wcvp_distribution.csv", "\n".join(["|".join(DIST)] + ["|".join(r) for r in dist]) + "\n")


class EnrichTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        zp = Path(cls.tmp.name) / "wcvp.zip"
        mini_wcvp(zp)
        cls.w = WCVP(zp)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_parse(self):
        self.assertEqual(parse("Andira inermis (W.Wright) Kunth ex DC.")["authors"], "(W.Wright) Kunth ex DC.")
        self.assertIsNone(parse("Plumeria Species")["species"])
        self.assertIsNone(parse("Dipterocarpus sp")["species"])
        self.assertEqual(parse("Terminalia mantaly 'Tricolor'")["species"], "mantaly")
        self.assertEqual(parse("Aggreflorum longifolium subsp. sativum")["infra"], "sativum")

    def test_norm_family(self):
        self.assertEqual(norm_family("Fabaceae (Leguminosae)"), "Fabaceae")

    def test_homonym_resolved_by_author(self):
        pid, how = self.w.resolve(parse("Garcinia parviflora (Benth.) Miq."))
        self.assertEqual(self.w.rows[pid]["family"], "Clusiaceae")
        pid, _ = self.w.resolve(parse("Garcinia parviflora Aubl."))
        self.assertEqual(self.w.rows[pid]["family"], "Quiinaceae")

    def test_synonym_followed_to_accepted(self):
        pid, _ = self.w.resolve(parse("Syzygium gratum"))
        self.assertEqual(self.w.rows[pid]["taxon_name"], "Syzygium antisepticum")

    def test_origin_rules(self):
        resolve = lambda n: self.w.resolve(parse(n))[0]
        self.assertTrue(self.w.non_native(resolve("Samanea saman")))            # S. America
        self.assertTrue(self.w.non_native(resolve("Brachychiton acerifolius"))) # Australia
        self.assertFalse(self.w.non_native(resolve("Leea indica")))             # native in Asia -> never inferred
        self.assertFalse(self.w.non_native(resolve("Syzygium gratum")))         # native in Malaya

    def test_enrich_fills_only_gaps_and_marks_source(self):
        species = {
            1: {"scientific": "Samanea saman", "family": None, "native": None},
            2: {"scientific": "Leea indica", "family": None, "native": None},
            3: {"scientific": "Plumeria Species", "family": None, "native": None},
            4: {"scientific": "Samanea saman", "family": "Fabaceae (Leguminosae)", "native": 1},  # NParks wins
        }
        enrich_species(species, {}, self.w)
        self.assertEqual((species[1]["native"], species[1]["native_src"]), (0, "wcvp"))
        self.assertEqual(species[1]["family"], "Fabaceae (Leguminosae)")  # NParks' naming for the family
        self.assertIsNone(species[2]["native"])
        self.assertEqual(species[2]["family"], "Vitaceae")
        self.assertEqual(species[3]["family"], "Apocynaceae")
        self.assertNotIn("native", {k for k in species[3] if species[3][k] is not None})
        self.assertEqual(species[4]["native"], 1)
        self.assertNotIn("native_src", species[4])

    def test_gate_can_switch_filling_off(self):
        species = {1: {"scientific": "Samanea saman", "family": None, "native": None}}
        enrich_species(species, {}, self.w, fill_family=False, fill_origin=False)
        self.assertIsNone(species[1]["family"])
        self.assertIsNone(species[1]["native"])

    def test_score_counts_wrong_origin(self):
        # NParks says native; a rule that called it non-native would show up as wrong
        species = {1: {"scientific": "Samanea saman", "family": "Fabaceae", "native": 1}}
        m = score(species, {}, self.w)
        self.assertEqual(m["origin_tested"], 1)
        self.assertEqual(m["origin_precision"], 0.0)
        species = {1: {"scientific": "Samanea saman", "family": "Fabaceae", "native": 0}}
        self.assertEqual(score(species, {}, self.w)["origin_precision"], 1.0)


if __name__ == "__main__":
    unittest.main()
