# 🌳 TreeNerd

**[treenerd.fyi](https://treenerd.fyi)**: explore every tree in Singapore.

TreeNerd maps Singapore's ~890,000 trees and makes them searchable by **road**, **park**, **planning area**, **subzone**, **park connector**, **constituency**, **address** or **species**. Pick a place to see how many trees it has, which species dominate, how much carbon they store, and its largest trees. Pick any tree to see its details.

## Features

- **Forgiving search**: typos and abbreviations work ("orchad rd", "upp thomson", "jln kayu"), and species match by common, scientific, Chinese and Malay names.
- **Address search**: postal codes, HDB blocks and building names show the trees within 100–500 m.
- **Place summaries**: tree and species counts, share of native species, estimated carbon, heritage trees, and top species (tap one to filter the map). Each summary lists its largest trees and offers a CSV download.
- **Tree cards**: species, girth, height, age, estimated carbon, and the road, park, area and constituency the tree is in. Heritage trees include their story.
- **Trees near me**, using your location, or anywhere by right-clicking the map on a computer.
- **Made for phones**: a resizable bottom sheet and large tap targets. It can be installed to the home screen.
- **Light and dark themes**: follows your device by default and can be switched from the map.
- **Shareable links** for every view, with rich previews in messaging apps.

## Links

Every view has its own URL:

| URL | Opens |
|---|---|
| `/?p=road/orchard-road` | A place. Kinds: `road`, `park`, `subzone`, `planning_area`, `pcn`, `constituency`, `heritage_road` |
| `/?s=3106` | A species |
| `/?t=12561254` | A single tree |
| `/?near=1.30387,103.83586,150` | Trees within 150 m of a point (radius 100, 150, 250 or 500) |
| `/?q=238859` | The app with a search already filled in |

Add `#map=zoom/lat/lng` to any link to set the map view.

## How it works

```
Data pipeline (GitHub Actions: weekly, and whenever the source data changes)
  fetch  → public tree inventory, open government geodata, OpenStreetMap roads
  build  → clean, de-duplicate, spatial joins, carbon estimates
  output → vector tiles, database, search index, CSV export

Cloudflare Worker
  /              app shell, with per-link titles and previews
  /api/*         JSON API: search, places, trees, species, nearby, address search
  /tiles/*       vector tiles, one small request per tile (read from a PMTiles archive in R2)
  /data/*        data files (CSV export, archive)
  /sitemap.xml   every place and species page
```

- **Front end**: plain JavaScript with [MapLibre GL](https://maplibre.org) and [PMTiles](https://protomaps.com/docs/pmtiles), with no build step.
- **Worker**: TypeScript on Cloudflare Workers, with D1 (database), R2 (files) and edge caching keyed to each data build.
- **Zero-downtime updates**: two databases take turns. Each update loads the idle one, checks it, then switches the site over; the previous data stays as a rollback.
- **Pipeline**: Python with Shapely; tiles are built with Tippecanoe.

| Path | Contents |
|---|---|
| `public/` | Front end: `index.html`, `app.js`, `app.css`, icons, `_headers`, vendored libraries |
| `src/worker.ts` | Worker entry: routing, API, caching, rate limiting, scheduled freshness check |
| `src/search.ts` | Fuzzy search over places and species |
| `src/geocode.ts` | Address-search helpers (query clean-up, result parsing) |
| `src/pages.ts` | Page titles, link previews, sitemap |
| `pipeline/` | `fetch.py` (sources), `build.py` (cleaning, joins, outputs), `enrich.py` (species gaps from Kew, with accuracy check) |
| `data/sources.json` | Upstream sources used by the pipeline |
| `schema.sql` | Database schema |
| `tests/` | Pipeline, species-enrichment, search and address-search tests |

## Methodology

- **Roads are derived, not supplied.** The source data has no street field. Each tree is assigned to the nearest named road within 30 m, with main roads preferred over walkways and driveways. About 83% of trees are matched to a road; most of the rest are in parks.
- **Areas** (subzones, planning areas, parks, constituencies, conservation areas) are assigned by point-in-polygon.
- **Carbon is an estimate.** It uses a standard pantropical allometric model (Chave et al., 2014) on girth and height band, with 47% of biomass counted as carbon. Treat it as indicative.
- **Heights are banded** (3 m bands) as published by the source.
- **Species family and origin** come from NParks. Where NParks has none, they're filled from Kew's [World Checklist of Vascular Plants](https://powo.science.kew.org/about-wcvp):
  - Names are matched to one accepted plant. Outdated names are followed to their current one, and same-name clashes are settled by the author name. A match that stays unclear is skipped.
  - **Family** follows NParks' naming wherever NParks already lists the genus.
  - **Origin** is only ever filled as *non-native*, and only when the plant's entire native range is outside Asia. Being native to the region doesn't make a plant native to Singapore, so "native" is never inferred; those species stay unknown.
  - **Accuracy is checked on every update** by hiding NParks' own answers and comparing. In testing, family matched 99.8% (the rest were renamed families, such as Cordiaceae → Boraginaceae) and origin matched 100%. If a check falls below its bar, that field isn't filled.
  - The app labels every value that came from Kew.
- **Implausible measurements** are flagged, not hidden. A tree is flagged when its recorded girth and height can't both be right: a trunk wider than 0.3× the tree's height. About 20 trees in 875,000 are flagged. Figs (aerial roots), palms, pandans and bamboo are exempt, because they're measured around a whole clump. Flagged trees show a warning and no carbon estimate.
- **Freshness**: the data is rebuilt weekly and whenever the source data changes. The app shows the date of the last update.

## Privacy

- No accounts, no cookies set by TreeNerd, and nothing you type is stored.
- Your location is only used in your browser, and only when you tap "Near me".
- Address searches are passed to [OneMap](https://www.onemap.gov.sg) to find the location.
- Visits are counted with Cloudflare Web Analytics, which is cookieless and doesn't track individuals.

## Development

```bash
npm ci && npm test && npx tsc --noEmit                    # Worker, search and address tests
pip install --require-hashes -r pipeline/requirements.lock
python -m unittest discover -s tests                      # pipeline tests
```

## Feedback

Ideas, bugs or questions: join our [Telegram channel](https://t.me/treenerd). To report a vulnerability, see [SECURITY.md](SECURITY.md). For mistakes in the tree data itself (wrong species, felled trees), contact NParks; fixes flow into TreeNerd at the next update.

## Data & attribution

- Tree data: [Trees.sg](https://treessg.nparks.gov.sg) © National Parks Board
- Boundaries, parks and heritage data: [data.gov.sg](https://data.gov.sg), under the [Singapore Open Data Licence](https://data.gov.sg/open-data-licence)
- Roads © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), [ODbL](https://opendatacommons.org/licenses/odbl/). The derived tree-to-road assignments are available under the ODbL.
- Basemap and address search: [OneMap](https://www.onemap.gov.sg) © Singapore Land Authority
- Missing species families and origins: [WCVP](https://powo.science.kew.org/about-wcvp), World Checklist of Vascular Plants, facilitated by the Royal Botanic Gardens, Kew ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/))
- Bundled libraries: MapLibre GL JS and PMTiles (BSD-3-Clause)

TreeNerd is an independent project and isn't affiliated with or endorsed by NParks or any government agency.
