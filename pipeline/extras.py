"""Places and points of interest beyond the tree inventory: trails, park amenities, hawker centres,
heritage sites, residents per area, and the stories behind road names.

Each function takes what the build has already worked out (tree positions in SVY21 metres, the
places list) and returns plain data; build.py writes it out and audit.py checks it.
"""
from __future__ import annotations

import csv
import html
import re
from collections import Counter, defaultdict

import numpy as np
import shapely
from shapely.geometry import shape

from .common import RAW, SOURCES, log, read_json, slugify

TRAIL_MAX = SOURCES.get("joins", {}).get("trailMaxDistanceM", 15)

# NParks park facilities worth showing to visitors (car parks, notice boards and map boards are not).
FACILITY_CLASSES = {
    "TOILET": "Toilet", "DRINKING FOUNTAIN": "Drinking fountain", "PLAYGROUND": "Playground",
    "SHELTER": "Shelter", "FITNESS AREA": "Fitness area", "BBQ PIT": "BBQ pit", "CAMPSITE": "Campsite",
    "DOG-AREA": "Dog run", "THERAPEUTIC GARDEN": "Therapeutic garden", "ALLOTMENT GARDEN": "Allotment garden",
    "LOOKOUT POINT": "Lookout point", "AMPHITHEATRE": "Amphitheatre", "JETTY": "Jetty",
    "BICYCLE RENTAL SHOP": "Bicycle rental", "BICYCLE PARKING": "Bicycle parking", "F&B": "Food and drink",
    "FOOT RELAX": "Foot reflexology path", "MULTIPURPOSE COURT": "Multi-purpose court", "BABY": "Nursing room",
}
# A ratio over a handful of residents means nothing (Tengah had 10 in 2020), so areas below this get none.
MIN_RESIDENTS = 1000
# The census the resident figures come from (the file fetched is dgs_population_subzone_<year>.csv).
RESIDENTS_YEAR = 2020


def _lines(feats):
    """SVY21 line geometries for features (multi-part lines kept whole)."""
    from .build import to_svy21  # avoid a circular import at module load
    return to_svy21([shapely.force_2d(shape(f["geometry"])) for f in feats])


def load(name):
    p = RAW / name
    if not p.exists():
        log(f"  (optional {name} missing, skipped)")
        return []
    return [f for f in read_json(p)["features"] if f.get("geometry")]


# ------------------------------------------------------------------------------------- trails
def trails(pts) -> list[dict]:
    """Named routes, each with its line (SVY21), length and the indexes of trees within TRAIL_MAX metres.

    Sources: NParks' long-distance routes (Round Island Route and others) and LTA's cycling path network
    by town. Nature reserve trails are left out on purpose: the tree inventory records managed trees,
    not the forest around those trails, so their counts would be misleadingly small.
    """
    groups: dict[tuple[str, str], list] = defaultdict(list)  # (name, type) -> features
    for f in load("arcgis_trails.geojson"):
        groups[(f["properties"]["route"].strip(), "Park connector route")].append(f)
    for f in load("dgs_cycling_paths.geojson"):
        town = (f["properties"].get("CYL_PATH") or "").strip()
        if town:
            groups[(f"{town} cycling paths", "Cycling path network")].append(f)

    out = []
    tree_index = shapely.STRtree(pts)
    for (name, kind), feats in sorted(groups.items()):
        geom = shapely.union_all(_lines(feats))
        length_m = float(shapely.length(geom))
        if length_m < 200:  # a stub, not a route
            continue
        idx = tree_index.query(geom, predicate="dwithin", distance=TRAIL_MAX)
        out.append({"name": name, "type": kind, "geom": geom, "length_m": length_m,
                    "trees": np.unique(idx)})
    log(f"  trails: {len(out)} routes, {sum(len(t['trees']) for t in out):,} tree-route pairs within {TRAIL_MAX} m")
    return out


def trail_shapes(routes, slugs) -> dict:
    """GeoJSON of each route, simplified to ~5 m and in WGS84, for drawing on the map."""
    from pyproj import Transformer
    back = Transformer.from_crs(3414, 4326, always_xy=True)
    feats = []
    for r, slug in zip(routes, slugs):
        g = shapely.simplify(r["geom"], 5)
        g = shapely.transform(g, lambda xy: np.column_stack(back.transform(xy[:, 0], xy[:, 1])))
        g = shapely.set_precision(g, 1e-5)
        feats.append({"type": "Feature", "properties": {"s": slug}, "geometry": shapely.geometry.mapping(g)})
    return {"type": "FeatureCollection", "features": feats}


def area_shapes(items) -> dict:
    """GeoJSON outlines of areas, for drawing on the map: items are (feature in WGS84, slug, name).
    Simplified to about 3 m, which is finer than the map ever shows them."""
    feats = []
    for f, slug, name in items:
        g = shapely.set_precision(shapely.simplify(shapely.force_2d(shape(f["geometry"])), 0.00003), 1e-5)
        feats.append({"type": "Feature", "properties": {"s": slug, "n": name}, "geometry": shapely.geometry.mapping(g)})
    return {"type": "FeatureCollection", "features": feats}


# --------------------------------------------------------------------------- points of interest
def _text(v):
    v = html.unescape(re.sub(r"<[^>]+>", " ", str(v or ""))).strip()
    return re.sub(r"\s+", " ", v) if v and v != "None" else None


def _https(url):
    url = (url or "").strip()
    return url if url.startswith("https://") else None


def pois() -> list[dict]:
    """Park amenities (NParks), hawker centres (NEA), historic sites and national monuments (NHB)."""
    out, skipped = [], Counter()
    for f in load("dgs_park_facilities.geojson"):
        p = f["properties"]
        label = FACILITY_CLASSES.get((p.get("CLASS") or "").strip().upper())
        if not label:
            skipped[(p.get("CLASS") or "").strip().upper() or "(none)"] += 1
        if label and f["geometry"]["type"] == "Point":
            # NParks' own labels vary ("-", "seesaw", "Blk3 with toilet"), so the type is the name
            # and their label, when it says something, is the description.
            own = _text(p.get("NAME"))
            notes = [x for x in (own, _text(p.get("ADDITIONAL_INFO"))) if x and len(x) > 1 and x.lower() != label.lower()]
            out.append({"kind": "amenity", "class": label, "name": label,
                        "description": " · ".join(dict.fromkeys(notes)) or None, "url": None, "geometry": f["geometry"]})
    for f in load("dgs_hawker_centres.geojson"):
        p = f["properties"]
        if (p.get("STATUS") or "").strip().lower() != "existing":
            continue  # planned or being rebuilt: not somewhere to go today
        stalls = _text(p.get("NUMBER_OF_COOKED_FOOD_STALLS"))
        out.append({"kind": "hawker", "class": "Hawker centre", "name": _text(p.get("NAME")),
                    "description": f"{stalls} cooked food stalls" if stalls and stalls.isdigit() else None,
                    "url": None, "geometry": f["geometry"]})
    for name, kind, label in (("dgs_historic_sites.geojson", "heritage", "Historic site"),
                              ("dgs_monuments.geojson", "heritage", "National monument")):
        for f in load(name):
            p = f["properties"]
            out.append({"kind": kind, "class": label, "name": _text(p.get("NAME")),
                        "description": _text(p.get("DESCRIPTION")), "url": _https(p.get("HYPERLINK")),
                        "geometry": f["geometry"]})
    out = [p for p in out if p["name"] and p["geometry"]["type"] == "Point"]
    log(f"  points of interest: {dict(Counter(p['class'] for p in out).most_common())}")
    # Classes left out on purpose (car parks, notice boards...) and any new ones NParks adds: review
    # this line when it changes, and add a class to FACILITY_CLASSES if visitors would want it.
    log(f"  park facility classes not shown: {dict(skipped.most_common())}")
    return out


# ---------------------------------------------------------------------------------- residents
def _num(v):
    v = (v or "").replace(",", "").strip()
    return int(v) if v.isdigit() else 0


def residents() -> dict[tuple[str, str], int]:
    """Resident population (census of RESIDENTS_YEAR) by ('planning_area', name) and ('subzone', planning area, name)."""
    path = RAW / f"dgs_population_subzone_{RESIDENTS_YEAR}.csv"
    if not path.exists():
        log("  (resident population missing, skipped)")
        return {}
    out, pa = {}, None
    with open(path, newline="", encoding="utf-8-sig") as fh:
        for r in csv.DictReader(fh):
            name, total = (r.get("Number") or "").strip(), _num(r.get("Total_Total"))
            if not name or name == "Total":
                continue
            if name.endswith(" - Total"):
                pa = name[: -len(" - Total")].strip()
                out[("planning_area", pa.lower())] = total
            elif pa:
                out[("subzone", pa.lower(), name.lower())] = total
    return out


def apply_residents(places, pops) -> int:
    """Store residents and trees per 1,000 residents on planning areas and subzones. Returns places matched."""
    n = 0
    for p in places:
        if p["kind"] == "planning_area":
            key = ("planning_area", p["name"].lower())
        elif p["kind"] == "subzone":
            key = ("subzone", (p["extra"].get("planning_area") or "").lower(), p["name"].lower())
        else:
            continue
        people = pops.get(key)
        if people:
            p["extra"]["residents"] = people
            p["extra"]["residents_year"] = RESIDENTS_YEAR
            if people >= MIN_RESIDENTS:  # see MIN_RESIDENTS
                p["extra"]["trees_per_1000_residents"] = round(p["tree_count"] / people * 1000, 1)
                n += 1
    return n


# ------------------------------------------------------------------------------- road stories
def road_stories(places) -> int:
    """The National Library Board's description of a road, where its 'Streets and Places' entry has
    exactly the road's name. Returns the number of roads given a story."""
    entries = {}
    for f in load("dgs_streets_and_places.geojson"):
        raw = f["properties"].get("Description") or ""
        fields = dict(re.findall(r"<th>([A-Z_]+)</th>\s*<td>(.*?)</td>", raw, re.S))
        name, desc = _text(fields.get("NAME")), _text(fields.get("DESCRIPTION"))
        if name and desc:
            entries.setdefault(name.lower(), desc)
    n = 0
    for p in places:
        if p["kind"] == "road" and p["name"].lower() in entries:
            p["extra"]["story"] = entries[p["name"].lower()]
            p["extra"]["story_source"] = "National Library Board, Streets and Places"
            n += 1
    log(f"  road stories: {n} roads matched of {len(entries)} library entries")
    return n


def trail_slug(name):
    return slugify(name)
