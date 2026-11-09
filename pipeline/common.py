"""Shared helpers for the trees data pipeline (stdlib only)."""
from __future__ import annotations

import gzip
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCES = json.loads((ROOT / "data" / "sources.json").read_text())
BUILD = Path(os.environ.get("TREES_BUILD_DIR", ROOT / "build"))
RAW = BUILD / "raw"
OUT = BUILD / "out"
UA = "TreeNerd-pipeline/1.0 (+https://treenerd.fyi)"
# Optional: a data.gov.sg API key raises download rate limits (works without one).
DATAGOVSG_KEY = os.environ.get("DATAGOVSG_API_KEY", "").strip()


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, file=sys.stderr, flush=True)


def http(url: str, params: dict | None = None, data: dict | None = None,
         retries: int = 5, timeout: int = 120) -> bytes:
    """GET (or POST form if data) with exponential backoff."""
    if not url.startswith("https://"):
        raise ValueError(f"refusing non-HTTPS URL: {url[:80]}")
    if params:
        url = f"{url}?{urllib.parse.urlencode(params)}"
    body = urllib.parse.urlencode(data).encode() if data else None
    for attempt in range(retries):
        try:
            headers = {"User-Agent": UA}
            host = urllib.parse.urlsplit(url).hostname or ""
            if DATAGOVSG_KEY and host.endswith("data.gov.sg"):  # never sent to S3 download links
                headers["x-api-key"] = DATAGOVSG_KEY
            req = urllib.request.Request(url, data=body, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                return raw
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            code = getattr(e, "code", None)
            if code and 400 <= code < 500 and code != 429:
                raise
            wait = 2 ** (attempt + 1)
            log(f"  retry {attempt + 1}/{retries} in {wait}s: {e}")
            time.sleep(wait)
    raise RuntimeError(f"failed after {retries} retries: {url[:200]}")


def http_json(url, params=None, data=None, **kw):
    return json.loads(http(url, params, data, **kw))


def slugify(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def write_json(path: Path, obj, compact=True):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":") if compact else None,
                  indent=None if compact else 1)


def read_json(path: Path):
    with open(path) as f:
        return json.load(f)
