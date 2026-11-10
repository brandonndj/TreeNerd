"""Download every raw source listed in data/sources.json into build/raw/.

Usage:  python -m pipeline.fetch [trees|tables|datagovsg|roads|wcvp|all]
"""
from __future__ import annotations

import concurrent.futures as cf
import json
import shutil
import sys
import time

from .common import DATAGOVSG_KEY, RAW, SOURCES, http, http_json, log, write_json

ARC = SOURCES["arcgis"]
DGS = SOURCES["datagovsg"]


# --------------------------------------------------------------------- ArcGIS
def _layer_url(path: str) -> str:
    return f"{ARC['base']}/{path}"


def fetch_arcgis_layer(name: str, cfg: dict, workers: int = 6) -> int:
    """Fetch a full layer by objectId chunks (parallel, robust to sparse IDs)."""
    url = _layer_url(cfg["path"]) + "/query"
    fields = cfg.get("outFields", ["*"])
    banned = set(cfg.get("neverRequest", []))
    if fields == ["*"] and banned:
        raise ValueError(f"{name}: outFields '*' not allowed when neverRequest is set")
    assert not banned & set(fields), f"{name}: requesting banned fields"

    meta = http_json(_layer_url(cfg["path"]), {"f": "json"})
    oid = meta.get("objectIdField") or next(
        f["name"] for f in meta["fields"] if f["type"] == "esriFieldTypeOID")
    is_spatial = bool(meta.get("geometryType"))
    ids = http_json(url, {"where": "1=1", "returnIdsOnly": "true", "f": "json"})["objectIds"] or []
    ids.sort()
    size = cfg.get("pageSize", 1000)
    chunks = [ids[i:i + size] for i in range(0, len(ids), size)]
    log(f"{name}: {len(ids):,} records in {len(chunks)} pages")

    def get(chunk):
        params = {
            "objectIds": ",".join(map(str, chunk)),
            "outFields": ",".join(fields),
            "returnGeometry": "true" if is_spatial else "false",
            "outSR": 4326,
            "geometryPrecision": 7,
            "f": "geojson" if is_spatial else "json",
        }
        d = json.loads(http(url, data=params))  # POST: ID lists are long
        if "error" in d:
            raise RuntimeError(f"{name}: {d['error']}")
        if is_spatial:
            return d["features"]
        return [{"type": "Feature", "geometry": None, "properties": f["attributes"]}
                for f in d["features"]]

    feats = []
    t0 = time.time()
    with cf.ThreadPoolExecutor(workers) as ex:
        for i, part in enumerate(ex.map(get, chunks), 1):
            feats.extend(part)
            if i % 100 == 0:
                log(f"  {name}: {i}/{len(chunks)} pages ({time.time() - t0:.0f}s)")
    for f in feats:  # belt and braces: strip personal data if ever returned
        for k in banned:
            f["properties"].pop(k, None)
    if len(feats) != len(ids):
        raise RuntimeError(f"{name}: got {len(feats)} of {len(ids)} records")
    write_json(RAW / f"arcgis_{name}.geojson", {
        "type": "FeatureCollection",
        "lastEditDate": (meta.get("editingInfo") or {}).get("lastEditDate"),
        "features": feats,
    })
    return len(feats)


def fetch_trees():
    cfg = ARC["layers"]["trees"]
    n = fetch_arcgis_layer("trees", cfg)
    exp = cfg.get("expectedCount")
    if exp and n < exp * 0.9:
        raise RuntimeError(f"trees: only {n} records, expected ~{exp}; refusing to continue")


def fetch_tables():
    for name, cfg in ARC["layers"].items():
        if name != "trees":
            fetch_arcgis_layer(name, cfg)


# ---------------------------------------------------------------- data.gov.sg
def fetch_datagovsg(only=None):
    for name, cfg in DGS["datasets"].items():
        if only is not None and name not in only:
            continue
        if only is None and cfg.get("fallbackOnly"):
            continue  # fetched by fetch_roads() only if OSM fails
        dest = RAW / f"dgs_{name}.{'csv' if cfg.get('format') == 'CSV' else 'geojson'}"
        for attempt in range(6):
            try:
                r = http_json(DGS["pollDownload"].format(id=cfg["id"]))
                url = (r.get("data") or {}).get("url")
                if not url:
                    raise RuntimeError(r.get("errorMsg") or "no url yet")
                dest.write_bytes(http(url, timeout=600))
                log(f"data.gov.sg {name}: {dest.stat().st_size / 1e6:.1f} MB")
                break
            except Exception as e:  # rate limited (429) or still preparing
                if attempt == 5:
                    if cfg.get("required"):
                        raise
                    log(f"data.gov.sg {name}: SKIPPED ({e})")
                    break
                time.sleep(10 * (attempt + 1))
        time.sleep(1 if DATAGOVSG_KEY else 4)  # be polite: download API is rate limited


# ---------------------------------------------------------------------- roads
def fetch_roads():
    """Download an OSM extract (.osm.pbf) and extract named roads to GeoJSON."""
    urls = SOURCES["roads"]["primary"]["urls"]
    pbf = RAW / "osm.pbf"
    for u in urls:
        try:
            log(f"OSM: downloading {u}")
            pbf.write_bytes(http(u, timeout=900))
            break
        except Exception as e:
            log(f"OSM: {u} failed: {e}")
    else:
        log("OSM unavailable: falling back to SLA major roads (major roads only)")
        (RAW / "osm_roads.geojson").unlink(missing_ok=True)
        fetch_datagovsg(only={"major_roads_sla"})
        return
    extract_osm_roads(pbf, RAW / "osm_roads.geojson")
    pbf.unlink()


def extract_osm_roads(pbf, dest):
    import osmium  # pyosmium

    keep = set(SOURCES["roads"]["primary"]["highwayTypes"])
    bbox = SOURCES["roads"]["primary"]["bbox"]
    feats = []
    fp = osmium.FileProcessor(str(pbf)).with_locations().with_filter(osmium.filter.KeyFilter("highway"))
    for o in fp:
        if not o.is_way():
            continue
        tags = o.tags
        hw = tags.get("highway")
        name = tags.get("name") or tags.get("official_name")
        if hw not in keep or not name:
            continue
        try:
            coords = [(n.lon, n.lat) for n in o.nodes]
        except osmium.InvalidLocationError:
            continue
        if len(coords) < 2:
            continue
        if not any(bbox[0] <= x <= bbox[2] and bbox[1] <= y <= bbox[3] for x, y in coords):
            continue
        feats.append({
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": coords},
            "properties": {
                "osm_id": o.id, "name": name, "highway": hw,
                "name_zh": tags.get("name:zh"), "name_ms": tags.get("name:ms"),
                "name_ta": tags.get("name:ta"),
            },
        })
    write_json(dest, {"type": "FeatureCollection", "features": feats})
    log(f"OSM: {len(feats):,} named road ways")


def fetch_species_reference():
    """Kew's World Checklist of Vascular Plants: fills species family/origin gaps (see pipeline/enrich.py)."""
    from .enrich import WCVP_ZIP, WCVP_URL
    WCVP_ZIP.write_bytes(http(WCVP_URL, timeout=900))
    log(f"WCVP: {WCVP_ZIP.stat().st_size / 1e6:.0f} MB")


def main(argv):
    what = argv[1] if len(argv) > 1 else "all"
    RAW.mkdir(parents=True, exist_ok=True)
    steps = {"trees": fetch_trees, "tables": fetch_tables,
             "datagovsg": fetch_datagovsg, "roads": fetch_roads, "wcvp": fetch_species_reference}
    for name, fn in steps.items():
        if what in (name, "all"):
            fn()
    log("fetch done; disk:", shutil.disk_usage(RAW).free // 1_000_000, "MB free")


if __name__ == "__main__":
    main(sys.argv)
