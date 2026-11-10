"""Clean + enrich raw data and produce everything the Worker serves.

Inputs : build/raw/*           (from pipeline.fetch)
Outputs: build/out/
  trees.geojsonl        line-delimited features for tippecanoe -> trees.pmtiles
  d1/NN-*.sql           chunked SQL to load Cloudflare D1 (staging tables + swap)
  search.json           search index (roads, parks, areas, PCN loops, species, constituencies)
  species.json          species dictionary for the front end (legend, filters)
  meta.json             build stats, source dates, attribution
  trees.csv.gz          open data export (no personal data)

Usage: python -m pipeline.build
"""
from __future__ import annotations

import csv
import gzip
import json
import math
import re
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import shapely
from pyproj import Transformer
from shapely.geometry import shape

from .common import OUT, RAW, SOURCES, log, read_json, slugify, write_json

JOINS = SOURCES.get("joins", {})
ROAD_MAX = JOINS.get("roadMaxDistanceM", 30)
PCN_MAX = JOINS.get("pcnMaxDistanceM", 15)
HERITAGE_MAX = JOINS.get("heritageMatchM", 15)

TO_SVY21 = Transformer.from_crs(4326, 3414, always_xy=True)

CATEGORY = {  # GIS_Layer -> (code, label)
    "OPS.M1_STREETSCAPETREES": "street",
    "OPS.M1_PARKSTREES": "park",
    "OPS.M1_SBGTREES": "botanic",
    "OPS.TREEPLOTTING": "user",
    "OPS.M1_CONSERVATIONTREES": "conservation",
    "OPS.M1_HERITAGE_TREES": "heritage",
}
CAT_CODE = {"street": 1, "park": 2, "botanic": 3, "user": 4, "conservation": 5, "heritage": 6, "other": 0}
SIZE_CODE = {"XS": 1, "S": 2, "M": 3, "L": 4}
HEIGHT_BANDS = [3, 6, 9, 12, 15, 18, 21, 24]


# ------------------------------------------------------------------ cleaning
def norm_height(raw):
    """~70 spellings ('6-9', '6m - 9m', '>6 but ≤9', '<3', '>24', '7', '-1') -> (band, upper_m)."""
    if raw is None:
        return None, None
    s = str(raw).strip().lower().replace("≤", "<=")
    nums = [float(n) for n in re.findall(r"\d+(?:\.\d+)?", s)]
    if not nums or s.startswith("-"):
        return None, None
    if len(nums) == 1:
        n = nums[0]
        if s.startswith(">") or "more" in s:
            return ">24", 27 if n >= 24 else int(n) + 3
        if s.startswith("<"):
            return "0-3", 3 if n <= 3 else int(n)
        upper = n
    else:
        upper = max(nums)
    if upper > 24:
        return ">24", 27
    for b in HEIGHT_BANDS:
        if upper <= b:
            return f"{b - 3}-{b}", b
    return ">24", 27


def girth_band(g):
    if g is None:
        return None
    if g <= 0.5:
        return "0-0.5"
    if g <= 1.0:
        return "0.5-1.0"
    if g <= 1.5:
        return "1.0-1.5"
    return ">1.5"


def to_int(v):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def clean_scientific(s):
    """'Hopea odorata Roxb.' -> 'Hopea odorata' (keep cultivars / 'sp.' / hybrids)."""
    if not s:
        return None
    s = s.strip()
    m = re.match(r"^([A-Z][a-z-]+)\s+(x\s+)?([a-z-]+\.?)(?:\s+(subsp\.|var\.|f\.)\s+([a-z-]+))?", s)
    if not m:
        return s
    out = f"{m.group(1)} {m.group(2) or ''}{m.group(3)}"
    if m.group(4):
        out += f" {m.group(4)} {m.group(5)}"
    cv = re.search(r"'[^']+'", s)
    return out + (f" {cv.group(0)}" if cv else "")


def title(s):
    """'TAI KENG GARDENS PG' -> 'Tai Keng Gardens PG'; expand a few NParks abbreviations."""
    if not s:
        return s
    words = []
    for w in s.strip().split():
        u = w.upper()
        core = u.strip("()&/,.-")
        if u in EXPAND:
            words.append(EXPAND[u])
        elif core in KEEP_UPPER or re.fullmatch(r"[IVX]+|\d+[A-Z]?", core):
            words.append(w.upper())
        else:
            words.append(re.sub(r"(?<!')[a-z]+", lambda m: m.group(0).capitalize(), w.lower(), count=0)
                         if not w.islower() else w)
    out = " ".join(words)
    return re.sub(r"\((\w)", lambda m: "(" + m.group(1).upper(), out)


EXPAND = {"PK": "Park", "NR": "Nature Reserve", "SBG": "Singapore Botanic Gardens",
          "JLG": "Jurong Lake Gardens", "JLG:": "Jurong Lake Gardens:"}
KEEP_UPPER = {"PG", "PCN", "GRC", "SMC", "LC", "TNC", "CC", "BTC", "HDB", "MRT", "LRT", "CBD",
              "NE", "NW", "SE", "SW", "NSRCC", "SAFRA", "NUS", "NTU", "SMU", "SIT", "SUTD", "ECP"}


# --------------------------------------------------------------- carbon
def heritage_location(desc):
    """'Common Name : Rain Tree. Found in Fort Canning Park' -> 'Found in Fort Canning Park'.
    83 of 255 source records end in a bare 'Found in'; those return None rather than a broken sentence."""
    if not desc:
        return None
    s = re.sub(r"^\s*Common Name\s*:[^.]*\.\s*", "", desc).strip()
    s = re.sub(r"\s+", " ", s)
    return None if not s or re.fullmatch(r"Found in\.?", s, flags=re.I) else s


# Plants measured around a whole clump or aerial-root system: genuinely wide and short, never flagged.
CLUMP_FAMILIES = {"Arecaceae", "Pandanaceae", "Poaceae", "Musaceae", "Strelitziaceae", "Heliconiaceae"}


def implausible_measurements(girth_m, height_m, scientific, family):
    """True when the recorded girth and height can't both be right: a trunk wider than 0.3x the
    tree's height (upper bound of its height band). Figs (aerial roots), palms, pandans and bamboo
    are exempt. On the Nov 2026 data this flags 20 of ~875,000 trees, all physically implausible."""
    if not girth_m or not height_m:
        return False
    if (scientific or "").startswith("Ficus") or (family or "").split(" ")[0] in CLUMP_FAMILIES:
        return False
    return girth_m / math.pi > 0.3 * height_m


def carbon_estimate(girth_m, height_m, wood_density=0.6):
    """Chave et al. 2014 pantropical AGB; carbon = 47% of biomass. Rough estimate."""
    if not girth_m or girth_m <= 0:
        return None
    d_cm = girth_m * 100 / math.pi
    h = height_m - 1.5 if height_m else 6  # band upper bound -> midpoint
    agb = 0.0673 * (wood_density * d_cm ** 2 * max(h, 1.5)) ** 0.976
    return round(agb * 0.47, 1)


# --------------------------------------------------------------- geometry
def load_fc(name, required=True):
    p = RAW / name
    if not p.exists():
        if required:
            raise FileNotFoundError(p)
        log(f"  (optional {name} missing, skipped)")
        return []
    feats = read_json(p)["features"]
    return [f for f in feats if f.get("geometry")]


def to_svy21(geoms):
    """Project WGS84 shapely geoms to SVY21 (metres); drops Z."""
    return shapely.transform(np.asarray(geoms, dtype=object),
                             lambda xy: np.column_stack(TO_SVY21.transform(xy[:, 0], xy[:, 1])))


def build_geoms(feats):
    return to_svy21([shapely.force_2d(shape(f["geometry"])) for f in feats])


def polygon_join(points, feats, label):
    """For each point, the index of the (first) polygon containing it, else -1."""
    out = np.full(len(points), -1, dtype=np.int64)
    if not feats:
        return out
    geoms = shapely.make_valid(build_geoms(feats))
    tree = shapely.STRtree(geoms)
    pi, gi = tree.query(points, predicate="intersects")
    # smallest polygon wins when overlapping (e.g. park inside nature reserve)
    area = shapely.area(geoms)
    order = np.lexsort((area[gi], pi))[::-1]
    out[pi[order]] = gi[order]
    log(f"  {label}: {np.count_nonzero(out >= 0):,} trees matched")
    return out


def nearest_join(points, geoms, max_dist, label):
    idx = np.full(len(points), -1, dtype=np.int64)
    dist = np.full(len(points), np.nan)
    if len(geoms) == 0:
        return idx, dist
    tree = shapely.STRtree(geoms)
    (pi, gi), d = tree.query_nearest(points, max_distance=max_dist, return_distance=True, all_matches=False)
    idx[pi] = gi
    dist[pi] = d
    log(f"  {label}: {np.count_nonzero(idx >= 0):,} trees within {max_dist} m")
    return idx, dist


# Extra metres a road class must "beat" to win a tree: stops walkways and
# driveways (e.g. Orchard Promenade) stealing trees from the main road.
ROAD_PENALTY = {"pedestrian": 12, "service": 8, "living_street": 4,
                "motorway": 3, "motorway_link": 5, "trunk_link": 3, "primary_link": 3,
                "secondary_link": 3, "tertiary_link": 3}


def road_join(points, geoms, classes, max_dist, label):
    """Nearest road by distance + class penalty. Returns (geom idx, true distance)."""
    idx = np.full(len(points), -1, dtype=np.int64)
    dist = np.full(len(points), np.nan)
    if len(geoms) == 0:
        return idx, dist
    tree = shapely.STRtree(geoms)
    pi, gi = tree.query(points, predicate="dwithin", distance=max_dist)
    d = shapely.distance(points[pi], geoms[gi])
    pen = np.array([ROAD_PENALTY.get(c, 0) for c in classes], dtype=float)[gi]
    score = d + pen
    order = np.lexsort((-score, pi))  # per point: worst first, best last (last write wins)
    idx[pi[order]] = gi[order]
    dist[pi[order]] = d[order]
    log(f"  {label}: {np.count_nonzero(idx >= 0):,} trees within {max_dist} m")
    return idx, dist


# ------------------------------------------------------------------ SQL
def q(v):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (int, np.integer)):
        return str(int(v))
    if isinstance(v, (float, np.floating)):
        return repr(round(float(v), 7))
    if isinstance(v, (dict, list)):
        v = json.dumps(v, ensure_ascii=False, separators=(",", ":"))
    return "'" + str(v).replace("'", "''") + "'"


class SqlWriter:
    """Writes multi-row INSERTs into chunked files (D1: <100 KB/statement)."""

    def __init__(self, folder: Path, rows_per_stmt=200, stmts_per_file=500):
        self.folder = folder
        self.rows_per_stmt = rows_per_stmt
        self.stmts_per_file = stmts_per_file
        self.n_file = 0
        self.fh = None
        self.stmts = 0
        folder.mkdir(parents=True, exist_ok=True)
        for old in folder.glob("*.sql"):
            old.unlink()

    def raw(self, sql, name):
        self.n_file += 1
        (self.folder / f"{self.n_file:03d}-{name}.sql").write_text(sql)

    def insert(self, table, cols, rows):
        head = f"INSERT OR REPLACE INTO {table} ({','.join(cols)}) VALUES\n"  # safe to re-run
        batch = []
        for r in rows:
            batch.append("(" + ",".join(q(v) for v in r) + ")")
            if len(batch) >= self.rows_per_stmt:
                self._emit(table, head + ",\n".join(batch) + ";\n")
                batch = []
        if batch:
            self._emit(table, head + ",\n".join(batch) + ";\n")
        self._close()

    def _emit(self, table, stmt):
        if self.fh is None or self.stmts >= self.stmts_per_file:
            self._close()
            self.n_file += 1
            self.fh = open(self.folder / f"{self.n_file:03d}-{table}.sql", "w")
            self.stmts = 0
        self.fh.write(stmt)
        self.stmts += 1

    def _close(self):
        if self.fh:
            self.fh.close()
            self.fh = None


# ------------------------------------------------------------------ main
def main():
    t0 = time.time()
    OUT.mkdir(parents=True, exist_ok=True)

    # ---- species --------------------------------------------------------
    log("species")
    species = {}
    for f in read_json(RAW / "arcgis_species.geojson")["features"]:
        p = f["properties"]
        sid = to_int(p.get("Species_ID"))
        if sid is None:
            continue
        names = [n.strip() for n in (p.get("Common_Names") or "").split(",") if n.strip()]
        sci = " ".join(x for x in [p.get("Genus_Epithet"), p.get("Species_Epithet_Type"),
                                    p.get("Species_Epithet"), p.get("Infraspecific_Epithet")] if x)
        status = p.get("Local_Conservation_Status") or ""
        species[sid] = {
            "id": sid, "master_id": to_int(p.get("Master_ID")),
            "scientific": sci or p.get("Description"),
            "common": names[0] if names else None, "aliases": names[1:],
            "family": p.get("Family_Name"), "growth_form": p.get("Plant_Growth_Form"),
            "native_distribution": p.get("Native_Distribution"),
            "conservation_status": status or None,
            "native": 1 if status.startswith("Native") else (0 if status.startswith("Non-native") else None),
            "ffw_url": p.get("ffw_url"), "tree_count": 0,
        }
    carbon_table = {}
    for f in read_json(RAW / "arcgis_carbon.geojson")["features"]:
        p = f["properties"]
        if p.get("Carbon") not in (None, ""):
            carbon_table[(to_int(p["Species_ID"]), p["Girth_Cat"])] = float(p["Carbon"])

    # ---- trees ------------------------------------------------------------
    log("trees: load")
    raw_sci = defaultdict(Counter)  # species id -> scientific names (with authors) as written on trees
    raw = read_json(RAW / "arcgis_trees.geojson")
    source_edit = raw.get("lastEditDate")
    trees, seen_id, seen_xy = [], set(), set()
    dupes = 0
    for f in raw["features"]:
        p, g = f["properties"], f.get("geometry")
        tid = to_int(p.get("Public_treeid"))
        if not g or tid is None:
            continue
        lng, lat = g["coordinates"][:2]
        xy = (round(lng, 6), round(lat, 6))
        if tid in seen_id or xy in seen_xy:
            dupes += 1
            continue
        seen_id.add(tid)
        seen_xy.add(xy)
        girth = p.get("GRTH_SIZE")
        girth = float(girth) if girth not in (None, "") and float(girth) > 0 else None
        hb, hm = norm_height(p.get("HEIGHT"))
        cat = CATEGORY.get(p.get("GIS_Layer") or "", "user" if p.get("Type") == "USERTREE" else "other")
        sid = to_int(p.get("SPCS_CD"))
        if sid is not None and p.get("SPSC_NM"):
            raw_sci[sid][p["SPSC_NM"].strip()] += 1
        if sid not in species and sid is not None:
            names = [n.strip() for n in (p.get("COMMON_NM") or "").split(",") if n.strip()]
            species[sid] = {"id": sid, "master_id": None, "scientific": clean_scientific(p.get("SPSC_NM")),
                            "common": names[0] if names else None, "aliases": names[1:], "family": None,
                            "growth_form": None, "native_distribution": None, "conservation_status": None,
                            "native": None, "ffw_url": None, "tree_count": 0}
        dp = p.get("DatePlanted")
        le = p.get("last_edited_date")
        trees.append({
            "id": tid, "lng": round(lng, 7), "lat": round(lat, 7), "species_id": sid,
            "girth_m": girth, "girth_band": girth_band(girth) if girth else (p.get("Girth") or None),
            "size": p.get("SIZE") or None, "height_band": hb, "height_m": hm,
            "age": to_int(p.get("AGE")), "category": cat,
            "date_planted": time.strftime("%Y-%m-%d", time.gmtime(dp / 1000)) if dp else None,
            "incorrect": 1 if p.get("incorrect") == 1 else 0,
            "last_edited": time.strftime("%Y-%m-%d", time.gmtime(le / 1000)) if le and le > 0 else None,
        })
    log(f"trees: {len(trees):,} unique ({dupes:,} duplicates dropped)")
    del raw, seen_xy

    # ---- species gaps: family / origin from Kew's WCVP, gated by an accuracy check ----------
    from .enrich import MIN_FAMILY_AGREEMENT, MIN_ORIGIN_PRECISION, enrich_species, ensure_wcvp, score
    raw_names = {sid: c.most_common(1)[0][0] for sid, c in raw_sci.items()}
    w = ensure_wcvp()
    acc = score(species, raw_names, w)
    log(f"species accuracy check: family {acc['family_agreement']:.2%} of {acc['family_tested']}, "
        f"origin {acc['origin_precision']:.2%} of {acc['origin_tested']}")
    fill_family = acc["family_agreement"] >= MIN_FAMILY_AGREEMENT
    fill_origin = acc["origin_precision"] >= MIN_ORIGIN_PRECISION
    if not (fill_family and fill_origin):
        log(f"WARNING: below accuracy bar, not filling: {'' if fill_family else 'family '}{'' if fill_origin else 'origin'}"
            f" {acc['origin_wrong'][:5]}")
    enrich_species(species, raw_names, w, fill_family=fill_family, fill_origin=fill_origin)
    enrichment_report = {**acc, "filled_family": fill_family, "filled_origin": fill_origin,
                         "family_from_wcvp": sum(1 for s in species.values() if s.get("family_src")),
                         "origin_from_wcvp": sum(1 for s in species.values() if s.get("native_src"))}
    del w

    pts = to_svy21(shapely.points([(t["lng"], t["lat"]) for t in trees]))

    # ---- places (search targets) -------------------------------------------
    places = []  # dicts: id, kind, slug, name, alt, extra

    def add_place(kind, name, alt=None, extra=None, slug=None):
        pid = len(places) + 1
        places.append({"id": pid, "kind": kind, "slug": slug or slugify(name), "name": name,
                       "alt": alt or [], "extra": extra or {}})
        return pid

    # roads: OSM named ways grouped by name (fallback: SLA major roads)
    log("join: roads")
    road_feats = load_fc("osm_roads.geojson", required=False)
    road_source = "osm"
    if not road_feats:
        road_source = "sla"
        road_feats = [f for f in load_fc("dgs_major_roads_sla.geojson", required=False)
                      if "Road" in (f["properties"].get("FOLDERPATH") or "")
                      or "Expressway" in (f["properties"].get("FOLDERPATH") or "")]
        for f in road_feats:
            f["properties"]["name"] = title(f["properties"].get("NAME"))
    road_pid = {}
    road_geoms = build_geoms(road_feats)
    road_of_geom = np.empty(len(road_feats), dtype=np.int64)
    for i, f in enumerate(road_feats):
        pr = f["properties"]
        name = pr["name"].strip()
        key = slugify(name)
        if key not in road_pid:
            alt = [n for n in (pr.get("name_zh"), pr.get("name_ms"), pr.get("name_ta")) if n]
            road_pid[key] = add_place("road", name, alt, {"highway": pr.get("highway")})
        road_of_geom[i] = road_pid[key]
    road_classes = [f["properties"].get("highway") for f in road_feats]
    gi, road_dist = road_join(pts, road_geoms, road_classes, ROAD_MAX, f"roads ({road_source})")
    tree_road = np.where(gi >= 0, road_of_geom[np.maximum(gi, 0)], -1)

    def poly_places(fname, kind, name_fn, extra_fn=None, required=False, slug_fn=None):
        feats = load_fc(fname, required)
        ids = np.array([add_place(kind, name_fn(f["properties"]),
                                  extra=extra_fn(f["properties"]) if extra_fn else None,
                                  slug=slug_fn(f["properties"]) if slug_fn else None)
                        for f in feats], dtype=np.int64)
        return feats, ids

    log("join: polygons")
    sz_feats, sz_ids = poly_places("dgs_subzones_mp2019.geojson", "subzone",
                                   lambda p: title(p["SUBZONE_N"]),
                                   lambda p: {"code": p["SUBZONE_C"], "planning_area": title(p["PLN_AREA_N"]),
                                              "region": title(p["REGION_N"])},
                                   required=True, slug_fn=lambda p: p["SUBZONE_C"].lower())
    j = polygon_join(pts, sz_feats, "subzones")
    tree_subzone = np.where(j >= 0, sz_ids[np.maximum(j, 0)], -1)

    pa_feats, pa_ids = poly_places("dgs_planning_areas_mp2025.geojson", "planning_area",
                                   lambda p: title(p["PLN_AREA_N"]),
                                   lambda p: {"code": p["PLN_AREA_C"], "region": title(p["REGION_N"])},
                                   required=True)
    j = polygon_join(pts, pa_feats, "planning areas")
    tree_pa = np.where(j >= 0, pa_ids[np.maximum(j, 0)], -1)

    park_feats, park_ids = poly_places("dgs_parks_nature_reserves.geojson", "park",
                                       lambda p: title(p["NAME"]),
                                       lambda p: {"nature_reserve": p.get("N_RESERVE") not in (None, "0", 0)},
                                       required=True, slug_fn=lambda p: slugify(f"{p['NAME']}-{p.get('L_CODE', '')}"))
    j = polygon_join(pts, park_feats, "parks")
    tree_park = np.where(j >= 0, park_ids[np.maximum(j, 0)], -1)

    ed_feats, ed_ids = poly_places("dgs_electoral_2025.geojson", "constituency",
                                   lambda p: title(p.get("ED_DESC_FU") or p["ED_DESC"]))
    j = polygon_join(pts, ed_feats, "constituencies")
    tree_ed = np.where(j >= 0, ed_ids[np.maximum(j, 0)], -1)

    def flag_poly(fname, name_fn, label):
        feats = load_fc(fname, required=False)
        j = polygon_join(pts, feats, label)
        names = [name_fn(f["properties"]) for f in feats]
        return [names[k] if k >= 0 else None for k in j]

    tree_tca = flag_poly("dgs_tree_conservation_areas.geojson", lambda p: p["NAME"], "tree conservation areas")
    hr_feats = load_fc("dgs_heritage_road_buffers.geojson", required=False)
    hr_ids = np.array([add_place("heritage_road", title(f["properties"]["ROAD_NM"]),
                                 extra={"url": f["properties"].get("DESCRIPT")}, slug=slugify(
                                     "heritage-" + f["properties"]["ROAD_NM"])) for f in hr_feats], dtype=np.int64)
    j = polygon_join(pts, hr_feats, "heritage roads")
    tree_hr = np.where(j >= 0, hr_ids[np.maximum(j, 0)], -1) if len(hr_ids) else np.full(len(trees), -1)
    lu = load_fc("dgs_land_use_mp2025.geojson", required=False)
    j = polygon_join(pts, lu, "land use")
    lu_names = [title(f["properties"].get("LU_DESC")) for f in lu]
    tree_lu = [lu_names[k] if k >= 0 else None for k in j]

    log("join: lines")
    pcn = load_fc("dgs_park_connector_loop.geojson", required=False)
    pcn_pid = {}
    pcn_of = np.array([pcn_pid.setdefault(f["properties"]["PCN_LOOP"],
                                          add_place("pcn", f["properties"]["PCN_LOOP"]))
                       for f in pcn], dtype=np.int64)
    gi, _ = nearest_join(pts, build_geoms(pcn), PCN_MAX, "park connector loops")
    tree_pcn = np.where(gi >= 0, pcn_of[np.maximum(gi, 0)], -1) if len(pcn) else np.full(len(trees), -1)
    nw = load_fc("dgs_nature_ways.geojson", required=False)
    gi, _ = nearest_join(pts, build_geoms(nw), PCN_MAX, "nature ways")
    tree_nw = [nw[k]["properties"]["NAME"] if k >= 0 else None for k in gi]

    # heritage trees: match data.gov.sg HT register to nearest tree
    log("join: heritage register")
    ht = load_fc("dgs_heritage_trees.geojson", required=False)
    ht_info = {}
    if ht:
        htp = build_geoms(ht)
        tree_idx = shapely.STRtree(pts)
        (hi, ti), d = tree_idx.query_nearest(htp, max_distance=HERITAGE_MAX, return_distance=True)
        for h, t in zip(hi, ti):
            p = ht[h]["properties"]
            ht_info[int(t)] = {"ht_no": p.get("HT"), "ht_url": p.get("HYPERLINK"), "ht_desc": heritage_location(p.get("DESCRIPTION"))}
        log(f"  heritage register: {len(ht_info)}/{len(ht)} matched to a tree")

    # ---- per-tree derived ----------------------------------------------------
    log("derive: carbon, species counts, place stats")

    def carbon_for(t):
        cat = None
        if t["girth_m"]:
            g = t["girth_m"]
            cat = "G1" if g < 0.5 else "G2" if g <= 1.0 else "G3" if g <= 1.5 else "G4"
        # NParks' table (40 species x 4 girth classes) has undocumented units, so it is kept
        # as a raw reference value; carbon_kg is always the allometric estimate.
        return carbon_estimate(t["girth_m"], t["height_m"]), carbon_table.get((t["species_id"], cat))

    stats = defaultdict(lambda: {"n": 0, "species": Counter(), "heritage": 0, "carbon": 0.0,
                                 "bbox": [999, 999, -999, -999]})
    for i, t in enumerate(trees):
        t["road_id"] = int(tree_road[i]) if tree_road[i] >= 0 else None
        t["road_dist"] = round(float(road_dist[i]), 1) if tree_road[i] >= 0 else None
        t["subzone_id"] = int(tree_subzone[i]) if tree_subzone[i] >= 0 else None
        t["pa_id"] = int(tree_pa[i]) if tree_pa[i] >= 0 else None
        t["park_id"] = int(tree_park[i]) if tree_park[i] >= 0 else None
        t["pcn_id"] = int(tree_pcn[i]) if tree_pcn[i] >= 0 else None
        t["ed_id"] = int(tree_ed[i]) if tree_ed[i] >= 0 else None
        t["hr_id"] = int(tree_hr[i]) if tree_hr[i] >= 0 else None
        t["tca"] = tree_tca[i]
        t["nature_way"] = tree_nw[i]
        t["land_use"] = tree_lu[i]
        t.update(ht_info.get(i, {"ht_no": None, "ht_url": None, "ht_desc": None}))
        if t["ht_no"]:
            t["category"] = "heritage"
        sp = species.get(t["species_id"]) or {}
        t["measure_flag"] = 1 if implausible_measurements(t["girth_m"], t["height_m"], sp.get("scientific"), sp.get("family")) else 0
        t["carbon_kg"], t["carbon_nparks"] = carbon_for(t)
        if t["measure_flag"]:
            t["carbon_kg"] = None  # depends on girth and height, which don't agree
        t["cell"] = cell_of(t["lat"], t["lng"])
        if t["species_id"] in species:
            species[t["species_id"]]["tree_count"] += 1
        for pid in (t["road_id"], t["subzone_id"], t["pa_id"], t["park_id"], t["pcn_id"], t["ed_id"], t["hr_id"]):
            if pid is None:
                continue
            s = stats[pid]
            s["n"] += 1
            if t["species_id"] is not None:
                s["species"][t["species_id"]] += 1
            s["heritage"] += t["category"] == "heritage"
            s["carbon"] += t["carbon_kg"] or 0
            b = s["bbox"]
            b[0], b[1] = min(b[0], t["lng"]), min(b[1], t["lat"])
            b[2], b[3] = max(b[2], t["lng"]), max(b[3], t["lat"])

    for p in places:
        s = stats.get(p["id"])
        p["tree_count"] = s["n"] if s else 0
        p["species_count"] = len(s["species"]) if s else 0
        p["heritage_count"] = s["heritage"] if s else 0
        p["carbon_kg"] = round(s["carbon"]) if s else 0
        p["bbox"] = [round(v, 6) for v in s["bbox"]] if s else None
        p["top_species"] = [[sid, c] for sid, c in s["species"].most_common(10)] if s else []
    places_with_trees = [p for p in places if p["tree_count"] > 0]
    # disambiguate duplicate slugs within a kind (e.g. two parks with one name)
    seen = Counter()
    for p in places_with_trees:
        seen[(p["kind"], p["slug"])] += 1
        if seen[(p["kind"], p["slug"])] > 1:
            p["slug"] = f"{p['slug']}-{seen[(p['kind'], p['slug'])]}"

    # ---- outputs ---------------------------------------------------------------
    write_outputs(trees, species, places_with_trees, road_source, source_edit, t0, enrichment_report)


TILE_KEYS = {"road": "r", "park": "p", "planning_area": "a", "subzone": "u", "constituency": "e"}


def cell_of(lat, lng):
    """~220 m grid cell id used by the Worker for 'trees near me' queries."""
    return int((lat - 1.1) * 500) * 1000 + int((lng - 103.5) * 500)


def write_outputs(trees, species, places, road_source, source_edit, t0, enrichment=None):
    log("write: trees.geojsonl (tiles)")
    with open(OUT / "trees.geojsonl", "w") as fh:
        for t in trees:
            props = {"id": t["id"], "c": CAT_CODE[t["category"]]}
            for k, v in (("s", t["species_id"]), ("z", SIZE_CODE.get(t["size"] or "")),
                         ("h", t["height_m"]), ("g", round(t["girth_m"] * 100) if t["girth_m"] else None),
                         ("r", t["road_id"]), ("p", t["park_id"]), ("a", t["pa_id"]),
                         ("u", t["subzone_id"]), ("e", t["ed_id"])):
                if v is not None:
                    props[k] = v
            fh.write(json.dumps({"type": "Feature", "properties": props,
                                 "geometry": {"type": "Point", "coordinates": [t["lng"], t["lat"]]}},
                                separators=(",", ":")) + "\n")

    log("write: D1 SQL")
    w = SqlWriter(OUT / "d1")
    # The pipeline loads the idle one of two databases (see data.yml), so the SQL rebuilds tables in
    # place. Every file is safe to re-run: tables are recreated first, rows use INSERT OR REPLACE,
    # indexes use IF NOT EXISTS.
    schema = (Path(__file__).resolve().parent.parent / "schema.sql").read_text()
    tables = re.sub(r"CREATE (UNIQUE )?INDEX[^;]+;\s*", "", schema)
    drop = "".join(f"DROP TABLE IF EXISTS {t};\n" for t in
                   ("trees_new", "species_new", "places_new", "trees", "species", "places"))
    w.raw(drop + tables + "DELETE FROM meta WHERE key='build';\n", "tables")
    sp_cols = ["id", "master_id", "scientific", "common", "aliases", "family", "growth_form",
               "native_distribution", "conservation_status", "native", "ffw_url", "tree_count",
               "family_src", "native_src"]
    w.insert("species", sp_cols, ([s.get(c) for c in sp_cols] for s in species.values() if s["tree_count"]))
    pl_cols = ["id", "kind", "slug", "name", "alt", "tree_count", "species_count", "heritage_count",
               "carbon_kg", "bbox", "top_species", "extra"]
    w.insert("places", pl_cols, ([p[c] for c in pl_cols] for p in places))
    tr_cols = ["id", "lng", "lat", "cell", "species_id", "girth_m", "girth_band", "size", "height_band",
               "height_m", "age", "category", "date_planted", "incorrect", "road_id", "road_dist",
               "subzone_id", "pa_id", "park_id", "pcn_id", "ed_id", "hr_id", "tca", "nature_way",
               "land_use", "ht_no", "ht_url", "ht_desc", "carbon_kg", "carbon_nparks", "last_edited", "measure_flag"]
    w.insert("trees", tr_cols, ([t[c] for c in tr_cols] for t in trees))
    built = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    meta = {
        "built_at": built, "tree_count": len(trees), "species_count": sum(1 for s in species.values() if s["tree_count"]),
        "place_counts": dict(Counter(p["kind"] for p in places)),
        "category_counts": dict(Counter(t["category"] for t in trees)),
        "with_road": sum(1 for t in trees if t["road_id"]),
        "measurement_flags": sum(t["measure_flag"] for t in trees),
        "road_source": road_source,
        # place kinds whose id is a property of every tree in the tiles (the app highlights by it)
        "tile_keys": TILE_KEYS,
        "species_enrichment": {k: v for k, v in (enrichment or {}).items() if k != "family_differences"},
        "source_last_edit": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(source_edit / 1000)) if source_edit else None,
        "attribution": [SOURCES["arcgis"]["attribution"], SOURCES["datagovsg"]["attribution"],
                        "Species family/origin gaps: WCVP, World Checklist of Vascular Plants, Royal Botanic Gardens, Kew (CC BY 4.0)",
                        SOURCES["roads"]["primary"]["attribution"] if road_source == "osm"
                        else "Contains information from SLA National Map"],
    }
    indexes = "\n".join(re.findall(r"CREATE (?:UNIQUE )?INDEX[^;]+;", schema))
    # last file: indexes, then the build marker (its presence means the load completed)
    w.raw(indexes + f"\nINSERT OR REPLACE INTO meta VALUES ('build', {q(meta)});\n", "finish")

    log("write: search.json, species.json, meta.json, csv")
    search = [{"k": p["kind"], "s": p["slug"], "n": p["name"], "a": p["alt"], "c": p["tree_count"],
               "b": p["bbox"]} for p in places]
    search += [{"k": "species", "s": str(s["id"]), "n": s["common"] or s["scientific"],
                "a": [x for x in [s["scientific"], s["family"], *s["aliases"]] if x], "c": s["tree_count"]}
               for s in species.values() if s["tree_count"]]
    write_json(OUT / "search.json", search)
    write_json(OUT / "species.json", {str(s["id"]): {
        "n": s["common"], "sci": s["scientific"], "fam": s["family"], "nat": s["native"], "c": s["tree_count"]}
        for s in species.values() if s["tree_count"]})
    write_json(OUT / "meta.json", meta, compact=False)
    with gzip.open(OUT / "trees.csv.gz", "wt", newline="") as fh:
        wr = csv.writer(fh)
        place_name = {p["id"]: p["name"] for p in places}
        cols = ["id", "lng", "lat", "scientific", "common", "family", "girth_m", "height_band", "age",
                "category", "road", "subzone", "planning_area", "park", "carbon_kg"]
        wr.writerow(cols)
        for t in trees:
            s = species.get(t["species_id"]) or {}
            wr.writerow([t["id"], t["lng"], t["lat"], s.get("scientific"), s.get("common"), s.get("family"),
                         t["girth_m"], t["height_band"], t["age"], t["category"],
                         place_name.get(t["road_id"]), place_name.get(t["subzone_id"]),
                         place_name.get(t["pa_id"]), place_name.get(t["park_id"]), t["carbon_kg"]])
    log(f"done in {time.time() - t0:.0f}s:", json.dumps({k: meta[k] for k in
                                                       ("tree_count", "species_count", "with_road", "place_counts")}))


if __name__ == "__main__":
    main()
