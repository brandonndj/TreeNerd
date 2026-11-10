# Changelog

## 2026-11-10: Species details

### Added
- Families for 1,085 species, and "non-native" origin for 370 species (127,341 trees, including the Rain Tree), where NParks had none. These come from Kew's World Checklist of Vascular Plants.
- Place panels show an origin breakdown (native / non-native / unknown) instead of a single "% native".
- An accuracy check on every data update: NParks' own answers are hidden and compared, and a field isn't filled if it falls below its bar. At launch, family matched 99.8% and origin 100%.

- Trees whose recorded girth and height can't both be right are flagged as a possible recording error, and their carbon isn't estimated.

### Fixed
- Tapping a small tree next to a large one opens the small tree; the tree nearest your finger wins, and smaller trees are drawn on top.
- Trees on practically the same spot show a short list to choose from (or zoom in when the map is zoomed out).
- Data updates no longer interrupt the site: the idle database is loaded and checked before the site switches to it.

## 2026-11-09: Launch

### Added
- Map of ~890,000 trees in Singapore, coloured by type and sized by girth.
- Search for roads, parks, planning areas, subzones, park connectors, constituencies and species. It tolerates typos and abbreviations and matches multilingual species names.
- Address search by postal code, HDB block or building name.
- Place summaries with species breakdowns, estimated carbon, largest trees and CSV export.
- Tree cards, including heritage tree stories.
- Trees near me, plus "trees here" by right-clicking the map on a computer.
- Mobile bottom sheet, home-screen install, and light and dark themes that follow the device.
- Shareable links for every view, with link previews, a sitemap and search-engine metadata.
- About panel with sources and methodology, and feedback via Telegram.
- Weekly data refresh, plus an automatic refresh when the source data changes.

### Security
- Strict Content Security Policy and hardening headers, with vendored libraries.
- Read-only API with validation, rate limiting and edge caching.
- Pinned CI actions, hash-locked Python dependencies, npm audit and Dependabot security updates.
