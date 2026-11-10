# Changelog

## 2026-11-10: Accuracy, iPhone and iPad, reliability

### Accuracy
- Every data update is audited before it's published: all place and species figures are re-counted, and 300 random trees are compared with NParks' live records.
- Carbon is no longer estimated where the model doesn't apply: palms, and trunks recorded as wider than 2.12 m across. Single figs had been credited with up to 490 tonnes. The tree card says why there's no figure. Together with wood density, the island total is about 16% lower than at launch.
- Clearer wording: "of trees are native species"; changes read "not tracked yet" until a comparison has been made; data that's overdue for an update is labelled.

### iPhone and iPad
- Every control is at least 44 × 44 points on touch screens.
- On iPads and landscape iPhones, the top buttons no longer sit on the legend, the legend starts closed, and the side panel is narrower.
- Tapping quickly no longer lets a slow answer replace what you opened after it.

### Reliability
- Tiles and search files switch together with the database, so a rollback restores a matching set. A `Roll back data` workflow does it in one step.
- `/api/health` for uptime monitoring; a failed update opens an issue; a missed weekly update triggers a rebuild.
- The three build requirements are written down in PRINCIPLES.md and enforced by tests, including a run in Safari's engine.

## 2026-11-10: Rankings, recent changes and better carbon estimates

### Added
- Rankings: the roads, parks and areas with the most trees, species or stored carbon, and the widest trunks. Tap the empty search box.
- Recent changes: trees added to, or no longer in, NParks' records, on each place and for the whole island. This starts filling in from the second data update after launch.
- MRT and LRT stations in search, showing the trees within 250 m.
- The browser's Back and Forward buttons step through the places, trees and lists you opened.
- Tree-type filters are kept in the link, so a shared link shows the same trees.
- A loading card when a tree takes a moment to open.

### Changed
- Carbon estimates use each species' wood density (Global Wood Density Database v.2) instead of one value for every tree. The island-wide total is about 5% lower.
- "Near me" and address lookups send a position rounded to about 10 m, and request logs are off.

### Fixed
- The two largest constituencies were only partly highlighted on the map (takes effect with the next data update).
- Screen readers now hear which search result is selected.
- The dev preview site can't be indexed by search engines.

### Internal
- Integration tests for the API and the app in a browser, run in CI on a small fixture site.

## 2026-11-10: Species details

### Added
- Families for 1,085 species, and "non-native" origin for 370 species (127,341 trees, including the Rain Tree), where NParks had none. These come from Kew's World Checklist of Vascular Plants.
- Place panels show an origin breakdown (native / non-native / unknown) instead of a single "% native".
- An accuracy check on every data update: NParks' own answers are hidden and compared, and a field isn't filled if it falls below its bar. At launch, family matched 99.8% and origin 100%.

- Trees whose recorded girth and height can't both be right are flagged as a possible recording error, and their carbon isn't estimated.

### Fixed
- Wide screens: the map no longer shows the basemap's edges or its "Pedra Branca, not to scale" inset box.
- Tree dots missing on some corporate networks: tiles are now served one by one by the Worker instead of read from one large file with HTTP range requests, which some security proxies block.
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
