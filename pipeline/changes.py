"""Trees added to, or no longer in, NParks' records since the previous TreeNerd build.

Each build compares its tree ids with the previous published build (trees.csv.gz) and appends the
differences to a rolling log. A tree missing from the records isn't necessarily felled: it may
have been re-recorded. If a suspiciously large share changes at once (upstream renumbering, a
partial download), nothing is logged for that build.
"""
from __future__ import annotations

import csv
import gzip
import json
import time
from pathlib import Path

from .common import RAW, log

PREV_CSV = RAW / "prev_trees.csv.gz"
PREV_META = RAW / "prev_meta.json"
PREV_LOG = RAW / "prev_changes.json"
KEEP_DAYS = 180
MAX_SHARE = 0.05  # more than this added or removed at once is treated as a data problem, not news
PLACE_KEYS = {"road": "road_id", "park": "park_id", "subzone": "subzone_id", "planning_area": "pa_id", "constituency": "ed_id"}


def read_previous(path: Path = PREV_CSV) -> dict[int, dict] | None:
    if not path.exists():
        return None
    with gzip.open(path, "rt", newline="", encoding="utf-8") as fh:
        return {int(r["id"]): r for r in csv.DictReader(fh)}


def _f(v):
    try:
        return float(v) if v not in (None, "") else None
    except ValueError:
        return None


def diff(prev: dict[int, dict], trees: list[dict], species: dict[int, dict], places: list[dict],
         seen: str, since: str | None) -> tuple[list[dict], dict]:
    """Rows for trees added / removed between the previous build and this one, plus a summary."""
    now_ids = {t["id"] for t in trees}
    added = [t for t in trees if t["id"] not in prev]
    removed = [r for i, r in prev.items() if i not in now_ids]
    summary = {"seen": seen, "since": since, "added": len(added), "removed": len(removed)}
    base = max(len(prev), 1)
    if len(added) / base > MAX_SHARE or len(removed) / base > MAX_SHARE:
        log(f"changes: {len(added):,} added / {len(removed):,} removed of {len(prev):,} looks like a data "
            "problem; not logging this build")
        return [], {**summary, "skipped": True}
    # Places are stored by slug, not id: ids are reassigned on every build, slugs are stable.
    slug = {p["id"]: p["slug"] for p in places}
    by_name = {}
    for p in places:
        by_name.setdefault((p["kind"], p["name"]), p["slug"])
    rows = []
    for t in added:
        s = species.get(t["species_id"]) or {}
        rows.append({"tree_id": t["id"], "change": "added", "seen": seen, "since": since, "lng": t["lng"], "lat": t["lat"],
                     "common": s.get("common"), "scientific": s.get("scientific"), "girth_m": t["girth_m"],
                     **{kind: slug.get(t.get(col)) for kind, col in PLACE_KEYS.items()}})
    for r in removed:  # the previous export names places; map the names to slugs
        rows.append({"tree_id": int(r["id"]), "change": "removed", "seen": seen, "since": since,
                     "lng": _f(r.get("lng")), "lat": _f(r.get("lat")),
                     "common": r.get("common") or None, "scientific": r.get("scientific") or None,
                     "girth_m": _f(r.get("girth_m")),
                     **{kind: by_name.get((kind, r.get(kind))) for kind in ("road", "park", "subzone", "planning_area")},
                     "constituency": None})
    return rows, summary


def merge(log_rows: list[dict], new_rows: list[dict], today: str, keep_days: int = KEEP_DAYS) -> list[dict]:
    """Append this build's rows to the rolling log and drop entries older than keep_days."""
    cutoff = time.strftime("%Y-%m-%d", time.gmtime(time.mktime(time.strptime(today, "%Y-%m-%d")) - keep_days * 86400))
    key = lambda r: (r["tree_id"], r["change"], r["seen"])
    seen = {key(r) for r in new_rows}
    kept = [r for r in log_rows if r.get("seen", "") >= cutoff and key(r) not in seen]
    return kept + new_rows


def load_log(path: Path = PREV_LOG) -> list[dict]:
    if not path.exists():
        return []
    try:
        d = json.loads(path.read_text())
        return d if isinstance(d, list) else []
    except ValueError:
        return []


def previous_built_at(path: Path = PREV_META) -> str | None:
    try:
        return json.loads(path.read_text()).get("built_at")
    except (OSError, ValueError):
        return None
