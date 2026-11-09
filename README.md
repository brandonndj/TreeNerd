# 🌳 TreeNerd

**[treenerd.fyi](https://treenerd.fyi)**: explore every tree in Singapore.

TreeNerd maps Singapore's ~890,000 trees and makes them searchable by **road**, **park**, **planning area**, **subzone**, **park connector**, **constituency** or **species**. Pick a place to see how many trees it has, which species dominate, how much carbon they store, and its largest trees. Pick any tree to see its details.

## Features

- **Search that forgives typos and abbreviations**: "orchad rd", "upp thomson", "jln kayu". It also matches species by common, scientific and Chinese/Malay names.
- **Place summaries**: tree and species counts, share of native species, estimated carbon, heritage trees, top species (tap one to filter the map) and a CSV download.
- **Tree cards**: species, girth, height, age, estimated carbon, and which road, park, area and constituency the tree is in. Heritage trees include their story.
- **Address search**: postal codes, HDB blocks and building names (via OneMap) show the trees around that address.
- **Trees near me**, shareable links for every view, light and dark themes (following your device by default), and a mobile layout with a resizable bottom sheet. It can be added to the home screen.

## How it works

```
Data pipeline (GitHub Actions, weekly)
  fetch  → public tree inventory, open government geodata, OpenStreetMap roads
  build  → clean, de-duplicate, spatial joins, carbon estimates
  output → vector tiles + database + search index

Cloudflare
  Worker        → static site, JSON API, tile delivery
  D1 / R2       → database / tile and file storage
```

The front end is plain JavaScript with [MapLibre GL](https://maplibre.org) and [PMTiles](https://protomaps.com/docs/pmtiles), with no build step. The API is a TypeScript Cloudflare Worker. The pipeline is Python.

| Path | Contents |
|---|---|
| `public/` | Front end |
| `src/` | Worker (API, search) |
| `pipeline/` | Data fetch and build |
| `schema.sql` | Database schema |
| `tests/` | Pipeline and search tests |

## Methodology notes

- **Roads are derived, not supplied.** The source data has no street field. Each tree is assigned to the nearest named road within 30 m, with main roads preferred over walkways and driveways. About 83% of trees are matched to a road; most of the rest are in parks.
- **Carbon is an estimate.** It uses a standard pantropical allometric model (Chave et al., 2014) from girth and height band, so treat it as indicative.
- **Heights are banded** (3 m bands) as published by the source.

## Development

```bash
npm ci && npm test && npx tsc --noEmit                 # Worker + search
pip install --require-hashes -r pipeline/requirements.lock
python -m unittest discover -s tests                   # pipeline
```

## Security

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Data & attribution

- Tree data: [Trees.sg](https://treessg.nparks.gov.sg) © National Parks Board
- Boundaries, parks and heritage data: [data.gov.sg](https://data.gov.sg), under the [Singapore Open Data Licence](https://data.gov.sg/open-data-licence)
- Roads © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), [ODbL](https://opendatacommons.org/licenses/odbl/). The derived tree-to-road assignments are available under the ODbL.
- Basemap: [OneMap](https://www.onemap.gov.sg) © Singapore Land Authority
- Bundled libraries: MapLibre GL JS and PMTiles (BSD-3-Clause)

TreeNerd is an independent project and isn't affiliated with or endorsed by NParks or any government agency.
