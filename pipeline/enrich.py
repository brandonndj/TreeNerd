"""Fill gaps in species family / origin from Kew's World Checklist of Vascular Plants (WCVP).

Accuracy rules (validated against NParks' own labels, see `python -m pipeline.enrich --evaluate`):
  * A name must resolve to exactly ONE accepted WCVP taxon. Homonyms are disambiguated by author;
    if still ambiguous, nothing is filled.
  * Synonyms are followed to their accepted name; family and range come from the accepted taxon.
  * Genus-only names ("Syzygium Species", "Dipterocarpus sp") get the genus' family only, never an origin.
  * Origin is filled in ONE direction only: "non-native" when the plant's entire native range is outside
    Asia (e.g. Rain Tree, South America). Being native somewhere in the region does NOT imply native to
    Singapore (only 75% agreement in evaluation), so "native" is never inferred.
  * Family names follow NParks' own naming where NParks uses that family (e.g. "Fabaceae (Leguminosae)").
  * NParks values always win; enrichment only fills empty fields and records its source.
"""
from __future__ import annotations

import csv
import io
import json
import re
import sys
import unicodedata
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

from .common import RAW, ROOT, http, log, read_json

WCVP_URL = "https://sftp.kew.org/pub/data-repositories/WCVP/wcvp.zip"
WCVP_ZIP = RAW / "wcvp.zip"
REGION = "MLY"  # WCVP/TDWG level-3 area "Malaya": Peninsular Malaysia and Singapore
OVERRIDES = ROOT / "data" / "species-overrides.json"
PLACEHOLDER = {"sp", "sp.", "spp", "spp.", "species", "hybrid", "hybrids", "cultivar", "cv", "cv.", "sp1", "sp2"}

ASIA = {"3", "4"}  # WCVP level-1 continents: Asia-Temperate, Asia-Tropical


# ------------------------------------------------------------------ names
def _ascii(s: str) -> str:
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()


def norm_name(s: str) -> str:
    """'Tabebuia × rosea-alba' / 'Tabebuia x rosea-alba' -> 'tabebuia rosea-alba'."""
    s = _ascii(s).lower().replace("×", " ")
    s = re.sub(r"\b(x)\b", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def author_tokens(a: str | None) -> set[str]:
    if not a:
        return set()
    a = _ascii(a).lower()
    a = re.sub(r"\b(ex|in|and|et|&|non|nom|illeg|sensu)\b", " ", a)
    return {t for t in re.split(r"[^a-z]+", a) if len(t) >= 3}


NAME_RE = re.compile(
    r"^(?P<genus>[A-Z][a-z-]+)\s+(?:(?P<hyb>[x×])\s+)?(?P<sp>[a-z][a-z-]*\.?)"
    r"(?:\s+(?P<rank>subsp\.|ssp\.|var\.|f\.|forma)\s+(?P<infra>[a-z-]+))?(?P<rest>.*)$")


def parse(raw: str) -> dict | None:
    """'Andira inermis (W.Wright) Kunth ex DC.' -> genus, species, infra, authors."""
    if not raw:
        return None
    s = re.sub(r"'[^']*'|\"[^\"]*\"", " ", raw).strip()  # drop cultivar names
    s = re.sub(r"\s+", " ", s)
    m = NAME_RE.match(s)
    if not m:
        g = re.match(r"^([A-Z][a-z-]+)\b", s)
        return {"genus": g.group(1), "species": None, "infra": None, "authors": None} if g else None
    sp = m.group("sp").rstrip(".")
    if sp.lower() in {p.rstrip(".") for p in PLACEHOLDER}:
        return {"genus": m.group("genus"), "species": None, "infra": None, "authors": None}
    rest = (m.group("rest") or "").strip()
    authors = None if not rest or rest.lower().startswith(("sp", "cv", "hybrid")) else rest
    return {"genus": m.group("genus"), "species": sp, "infra": m.group("infra"), "authors": authors}


# ------------------------------------------------------------------ WCVP index
class WCVP:
    def __init__(self, zip_path: Path):
        z = zipfile.ZipFile(zip_path)
        self.rows: dict[str, dict] = {}
        self.by_name: dict[str, list[str]] = defaultdict(list)
        self.genus_family: dict[str, Counter] = defaultdict(Counter)
        with z.open("wcvp_names.csv") as fh:
            for r in csv.DictReader(io.TextIOWrapper(fh, encoding="utf-8"), delimiter="|"):
                rank = r["taxon_rank"]
                if rank == "Genus" and r["taxon_status"] == "Accepted":
                    self.genus_family[r["genus"]][r["family"]] += 1
                if rank not in ("Species", "Subspecies", "Variety", "Form"):
                    continue
                pid = r["plant_name_id"]
                self.rows[pid] = {k: r[k] for k in ("taxon_status", "family", "genus", "species", "infraspecies",
                                                     "taxon_name", "taxon_authors", "accepted_plant_name_id", "taxon_rank")}
                self.by_name[norm_name(r["taxon_name"])].append(pid)
        self.native: dict[str, set[str]] = defaultdict(set)
        self.native_continents: dict[str, set[str]] = defaultdict(set)
        self.introduced: dict[str, set[str]] = defaultdict(set)
        self.has_dist: set[str] = set()
        with z.open("wcvp_distribution.csv") as fh:
            for r in csv.DictReader(io.TextIOWrapper(fh, encoding="utf-8"), delimiter="|"):
                if r["location_doubtful"] == "1" or r["extinct"] == "1":
                    continue
                pid = r["plant_name_id"]
                self.has_dist.add(pid)
                if r["introduced"] == "1":
                    self.introduced[pid].add(r["area_code_l3"])
                else:
                    self.native[pid].add(r["area_code_l3"])
                    self.native_continents[pid].add(r["continent_code_l1"])
        log(f"WCVP: {len(self.rows):,} names, {len(self.has_dist):,} taxa with distributions")

    def accepted(self, pid: str) -> str | None:
        r = self.rows.get(pid)
        if not r:
            return None
        if r["taxon_status"] == "Accepted":
            return pid
        acc = r["accepted_plant_name_id"]
        return acc if acc in self.rows and self.rows[acc]["taxon_status"] == "Accepted" else None

    def resolve(self, p: dict) -> tuple[str | None, str]:
        """Return (accepted plant_name_id, how) or (None, reason)."""
        name = f"{p['genus']} {p['species']}" + (f" {p['infra']}" if p.get("infra") else "")
        cands = self.by_name.get(norm_name(name), [])
        if not cands and p.get("infra"):  # fall back to the species when the variety isn't listed
            cands = self.by_name.get(norm_name(f"{p['genus']} {p['species']}"), [])
        cands = [c for c in cands if self.rows[c]["taxon_status"] in ("Accepted", "Synonym")]
        if not cands:
            return None, "not found"
        accepted = {c: self.accepted(c) for c in cands}
        accepted = {c: a for c, a in accepted.items() if a}
        if not accepted:
            return None, "no accepted taxon"
        if len(set(accepted.values())) == 1:
            return next(iter(accepted.values())), "unique"
        # several different taxa share this name: let the author decide
        want = author_tokens(p.get("authors"))
        if want:
            scored = [(len(want & author_tokens(self.rows[c]["taxon_authors"])), a) for c, a in accepted.items()]
            best = max(s for s, _ in scored)
            winners = {a for s, a in scored if s == best and s > 0}
            if len(winners) == 1:
                return winners.pop(), "author"
        # prefer an accepted name over synonyms only if exactly one accepted name exists
        direct = {a for c, a in accepted.items() if self.rows[c]["taxon_status"] == "Accepted"}
        if len(direct) == 1 and not want:
            return direct.pop(), "accepted-over-synonyms"
        return None, "ambiguous"

    def non_native(self, pid: str) -> bool:
        """True only when WCVP has a native range for the taxon and none of it is in Asia."""
        return bool(self.native_continents.get(pid)) and not (self.native_continents[pid] & ASIA)

    def origin(self, pid: str) -> str | None:
        """'native' / 'introduced' / 'absent' for the region, or None if WCVP has no distribution."""
        if pid not in self.has_dist:
            return None
        if REGION in self.native[pid]:
            return "native"
        if REGION in self.introduced[pid]:
            return "introduced"
        return "absent"


# ------------------------------------------------------------------ NParks labels
def norm_family(f: str | None) -> str | None:
    return f.split("(")[0].strip().split()[0] if f else None


def nparks_native(status: str | None) -> int | None:
    s = (status or "").lower()
    if s.startswith("native"):
        return 1
    if s.startswith("non-native"):
        return 0
    return None


def ensure_wcvp():
    if not WCVP_ZIP.exists():
        log("WCVP: downloading")
        WCVP_ZIP.write_bytes(http(WCVP_URL, timeout=900))
    return WCVP(WCVP_ZIP)


def family_naming(species: dict[int, dict]) -> dict[str, str]:
    """WCVP family -> the exact string NParks uses for it (e.g. 'Fabaceae' -> 'Fabaceae (Leguminosae)')."""
    seen = defaultdict(Counter)
    for s in species.values():
        f = s.get("family")
        if f and s.get("family_src") is None:
            seen[norm_family(f)][f] += 1
    return {k: c.most_common(1)[0][0] for k, c in seen.items()}


def genus_families(species: dict[int, dict]) -> dict[str, Counter]:
    """Genus -> Counter of NParks family strings (used for 'Genus sp.' placeholders)."""
    out = defaultdict(Counter)
    for sid, s in species.items():
        g = (s.get("scientific") or "").split(" ")[0]
        if g and s.get("family") and s.get("family_src") is None:
            out[g][s["family"]] += 1
    return out


def enrich_one(s: dict, raw_name: str | None, w: WCVP, naming: dict, genus_fam: dict[str, Counter]) -> dict:
    """Fill s['family'] / s['native'] when empty. Returns provenance info."""
    p = parse(raw_name or s.get("scientific") or "")
    info = {"parsed": p}
    if not p:
        return info
    nparks_genus = genus_fam.get(p["genus"])
    if p["species"]:
        pid, how = w.resolve(p)
        info["match"] = how
        if pid:
            acc = w.rows[pid]
            info["accepted"] = f"{acc['taxon_name']} {acc['taxon_authors']}".strip()
            if not s.get("family"):
                if nparks_genus and len(nparks_genus) == 1:  # keep NParks' naming for genera it already files
                    s["family"], s["family_src"] = next(iter(nparks_genus)), "nparks-genus"
                else:
                    s["family"], s["family_src"] = naming.get(acc["family"], acc["family"]), "wcvp"
            if s.get("native") is None and w.non_native(pid):
                s["native"], s["native_src"] = 0, "wcvp"
                info["origin"] = "native range outside Asia"
            return info
    # genus-only placeholder, or a name WCVP doesn't list: family from the genus, never an origin
    if not s.get("family"):
        if nparks_genus and len(nparks_genus) == 1:
            s["family"], s["family_src"] = next(iter(nparks_genus)), "nparks-genus"
            info["match"] = "genus (NParks)"
        else:
            fams = w.genus_family.get(p["genus"])
            if fams and len(fams) == 1:
                f = next(iter(fams))
                s["family"], s["family_src"] = naming.get(f, f), "wcvp-genus"
                info["match"] = "genus (WCVP)"
    return info


def enrich_species(species: dict[int, dict], raw_names: dict[int, str], w: WCVP | None = None,
                   fill_family: bool = True, fill_origin: bool = True):
    """Fill family / native in-place where NParks has none. Returns per-species provenance."""
    w = w or ensure_wcvp()
    overrides = json.loads(OVERRIDES.read_text()) if OVERRIDES.exists() else {}
    naming, genus_fam = family_naming(species), genus_families(species)
    prov = {}
    for sid, s in species.items():
        o = overrides.get(str(sid))
        if o:
            for k in ("family", "native"):
                if k in o and s.get(k) in (None, ""):
                    s[k], s[f"{k}_src"] = o[k], "override"
            prov[sid] = {"match": "override"}
            continue
        if s.get("family") and s.get("native") is not None:
            continue
        trial = {"scientific": s.get("scientific"), "family": s.get("family"), "native": s.get("native")}
        prov[sid] = enrich_one(trial, raw_names.get(sid), w, naming, genus_fam)
        if fill_family and not s.get("family") and trial.get("family"):
            s["family"], s["family_src"] = trial["family"], trial["family_src"]
        if fill_origin and s.get("native") is None and trial.get("native") is not None:
            s["native"], s["native_src"] = trial["native"], trial["native_src"]
    return prov


# ------------------------------------------------------------------ evaluation
def load_inputs():
    """Species (NParks table + names seen on trees) and tree counts, from build/raw."""
    table = {}
    for f in read_json(RAW / "arcgis_species.geojson")["features"]:
        p = f["properties"]
        try:
            sid = int(p["Species_ID"])
        except (TypeError, ValueError):
            continue
        sci = " ".join(x for x in [p.get("Genus_Epithet"), p.get("Species_Epithet_Type"), p.get("Species_Epithet"),
                                    p.get("Infraspecific_Epithet")] if x)
        table[sid] = {"scientific": sci, "family": p.get("Family_Name"), "status": p.get("Local_Conservation_Status")}
    names, counts = defaultdict(Counter), Counter()
    for f in read_json(RAW / "arcgis_trees.geojson")["features"]:
        p = f["properties"]
        try:
            sid = int(p.get("SPCS_CD"))
        except (TypeError, ValueError):
            continue
        counts[sid] += 1
        if p.get("SPSC_NM"):
            names[sid][p["SPSC_NM"].strip()] += 1
    raw_names = {sid: c.most_common(1)[0][0] for sid, c in names.items()}
    return table, raw_names, counts


def score(species: dict[int, dict], raw_names: dict[int, str], w: WCVP) -> dict:
    """Accuracy check: hide NParks' answer for every species that has one, run the production rules,
    and compare. `species` values need 'scientific', 'family', 'native' as supplied by NParks."""
    truth = {sid: s for sid, s in species.items() if s.get("family_src") is None and s.get("native_src") is None}
    naming, genus_fam = family_naming(truth), genus_families(truth)
    fam, nat = Counter(), Counter()
    fam_diff, nat_wrong = Counter(), []
    for sid, t in truth.items():
        if not t.get("family") and t.get("native") is None:
            continue
        g = (t.get("scientific") or "").split(" ")[0]
        gf = genus_fam
        if g in genus_fam and t.get("family"):  # leave-one-out: a species can't vouch for its own genus
            c = Counter(genus_fam[g]); c[t["family"]] -= 1
            gf = {**genus_fam, g: +c}
        trial = {"scientific": t.get("scientific"), "family": None, "native": None}
        enrich_one(trial, raw_names.get(sid), w, naming, gf)
        if t.get("family"):
            if not trial["family"]:
                fam["not filled"] += 1
            elif norm_family(trial["family"]) == norm_family(t["family"]):
                fam["correct"] += 1
            else:
                fam["different"] += 1
                fam_diff[(t["family"], trial["family"])] += 1
        if t.get("native") is not None:
            if trial["native"] is None:
                nat["left blank"] += 1
            elif trial["native"] == t["native"]:
                nat["correct"] += 1
            else:
                nat["wrong"] += 1
                nat_wrong.append(raw_names.get(sid) or t.get("scientific"))
    f_n = fam["correct"] + fam["different"]
    o_n = nat["correct"] + nat["wrong"]
    return {
        "family_tested": f_n, "family_agreement": fam["correct"] / f_n if f_n else 1.0,
        "family_differences": [f"{a} -> {b} x{n}" for (a, b), n in fam_diff.most_common()],
        "origin_tested": o_n, "origin_precision": nat["correct"] / o_n if o_n else 1.0,
        "origin_left_blank": nat["left blank"], "origin_wrong": nat_wrong,
    }


# Minimum accuracy (measured by `score`) for each field to be filled in a build.
MIN_FAMILY_AGREEMENT = 0.99
MIN_ORIGIN_PRECISION = 1.0


def evaluate():
    """Print the accuracy report and gap coverage for the current build/raw data."""
    table, raw_names, counts = load_inputs()
    w = ensure_wcvp()
    species = {sid: {"scientific": t["scientific"], "family": t["family"], "native": nparks_native(t["status"])}
               for sid, t in table.items()}
    m = score(species, raw_names, w)
    print("\n=== Accuracy (NParks answers hidden, production rules) ===")
    print(f"  family agreement : {m['family_agreement']:.2%} of {m['family_tested']} species")
    for d in m["family_differences"]:
        print(f"      naming difference: {d}")
    print(f"  origin precision : {m['origin_precision']:.2%} of {m['origin_tested']} filled values"
          f" ({m['origin_left_blank']} left blank on purpose)")
    if m["origin_wrong"]:
        print("      wrong:", m["origin_wrong"])
    for sid in counts:  # species seen on trees but missing from the NParks table
        species.setdefault(sid, {"scientific": None, "family": None, "native": None})
    before_f = {sid for sid in counts if not species[sid].get("family")}
    before_n = {sid for sid in counts if species[sid].get("native") is None}
    prov = enrich_species(species, raw_names, w)
    after_f = {sid for sid in before_f if species[sid].get("family")}
    after_n = {sid for sid in before_n if species[sid].get("native") is not None}
    trees = lambda ids: sum(counts[i] for i in ids)
    print("\n=== Gaps filled ===")
    print(f"  family: {len(after_f)}/{len(before_f)} species ({trees(after_f):,}/{trees(before_f):,} trees)")
    print(f"  origin: {len(after_n)}/{len(before_n)} species marked non-native ({trees(after_n):,}/{trees(before_n):,} trees)")
    print("  how names matched:", dict(Counter(v.get("match") for v in prov.values())))


if __name__ == "__main__":
    if "--evaluate" in sys.argv:
        evaluate()
