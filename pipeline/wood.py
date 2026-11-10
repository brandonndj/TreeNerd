"""Wood density per species from the Global Wood Density Database v.2 (Fischer et al. 2026, CC BY 4.0).

The carbon estimate (Chave et al. 2014) needs wood density. A species uses its own value when the
database has one (under the name NParks uses, or the accepted name Kew gives for it), otherwise
the average for its genus. Trees with neither use the average over the trees that did match.
"""
from __future__ import annotations

import csv
import hashlib
from pathlib import Path

from .common import RAW, SOURCES, http, log

CFG = SOURCES.get("woodDensity", {})
FILES = {k: RAW / f"gwdd_{k}.csv" for k in ("binomial", "genus")}
VALID = (0.08, 1.5)  # g/cm3; anything outside is a data error (balsa is ~0.1, the densest woods ~1.4)


def fetch():
    for kind, cfg in CFG["files"].items():
        raw = http(cfg["url"], timeout=300)
        got = hashlib.md5(raw).hexdigest()  # integrity check against the published checksum, not security
        if got != cfg["md5"]:
            raise RuntimeError(f"wood density ({kind}): checksum {got} != {cfg['md5']}")
        FILES[kind].write_bytes(raw)
        log(f"wood density {kind}: {len(raw) / 1e6:.1f} MB")


def _read(path: Path, key: str) -> dict[str, float]:
    out = {}
    with open(path, newline="", encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            try:
                v = float(r["wsg_est"])
            except (TypeError, ValueError):
                continue
            if VALID[0] <= v <= VALID[1]:
                out[r[key].strip().lower()] = v
    return out


class WoodDensity:
    def __init__(self, binomial: dict[str, float], genus: dict[str, float]):
        self.binomial, self.genus = binomial, genus

    @classmethod
    def load(cls) -> "WoodDensity | None":
        if not all(p.exists() for p in FILES.values()):
            log("  (wood density tables missing: every tree uses the default)")
            return None
        return cls(_read(FILES["binomial"], "binomial"), _read(FILES["genus"], "genus"))

    def lookup(self, names: list[tuple[str | None, str | None]]) -> tuple[float | None, str | None]:
        """names: (genus, species) pairs to try in order, e.g. the name as recorded, then the accepted
        name. Returns (density, 'species' | 'genus') or (None, None)."""
        for genus, species in names:
            if genus and species:
                v = self.binomial.get(f"{genus} {species}".lower())
                if v is not None:
                    return v, "species"
        for genus, _ in names:
            if genus:
                v = self.genus.get(genus.lower())
                if v is not None:
                    return v, "genus"
        return None, None
