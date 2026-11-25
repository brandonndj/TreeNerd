# Changelog

What changed for people using TreeNerd, newest first. New entries are posted to the [Telegram channel](https://t.me/treenerd) when they go live; entries under "Internal" are for developers and aren't posted.

## 2026-11-24: Weather now, and colours for colour-blind visitors

### Added
- The temperature card is now a weather card with live NEA readings, each showing where it's from and when:
  - Heat stress at the nearest station, with NEA's rating (low, moderate or high).
  - The 2-hour forecast for the area.
  - Rain at the nearest rain gauge, shown while it's raining there.
  - Lightning, shown when NEA records a strike within 10 km in the last 15 minutes.
  - The UV index (measured at Changi, one reading for Singapore), in the daytime.
  - Air quality: the latest 1-hour PM2.5 reading for the nearest NEA region (north, south, east, west or central), with NEA's band and its advice when the air isn't normal.
- The weather card now also appears on tree pages, planning areas, subzones and roads up to 3 km across, as well as parks and the area around any spot. It says where its distances are measured from.

### Changed
- The map's "Show" panel is now called "Tree types". Even when it's closed, it shows the colour of each type and how many trees are on the map. If some types are switched off, it says so (for example "4 of 6 types") with their dots shown as hollow rings, and a "Show all" link switches them all back on.
- New map colours that stay easy to tell apart with red-green colour blindness (and blue-yellow too), in light and dark mode. Before, botanic-garden and conservation-area trees looked almost the same to some people, as did native and non-native species.
- Park amenities, hawker centres and heritage sites are now hollow rings on the map, each kind in its own colour, so they no longer look like tree dots.
- Trails and the selected-tree ring are now dark blue (white in dark mode), apart from every tree colour.

### Fixed
- The site no longer says it shows "every tree in Singapore". It shows the trees NParks records (the current count is in the About panel); forest trees, such as those in the nature reserves, aren't recorded one by one.
- Weather distances under 1 km are shown to the nearest 100 m, matching how precisely the location is looked up.
- Rankings say how many places they list ("Top 12") instead of always "Top 25", which was wrong when fewer qualified.
- The About panel's explanations (how far a tree can be from a road or trail, the census year, the carbon limit) now come from the latest data update, so they can't fall out of step with it.

### Internal
- Each build publishes its method limits in `meta.method`; the app reads them, falling back to the pipeline's defaults for older builds (`tests/test_method.py` keeps the two in step). The fixed tree count is gone from page descriptions. The build logs park facility classes it doesn't show, so new ones are noticed. Reasons for design and data choices are now in `docs/DECISIONS.md`.
- An hourly Worker check of NEA's feeds opens a GitHub issue (workflow `nea-alert.yml`) when one has been failing for over an hour, and closes it on recovery. It needs the Worker's `GITHUB_TOKEN` secret to be able to run workflows (the same permission the missed-update rebuild uses). NEA requests send the Worker secret `DATAGOVSG_API_KEY` if it's set.
- The link-preview image is redrawn by `tools/og_image.cjs`, without a tree count.
- `/api/weather` keeps `reading` (air temperature) as before and adds `heat`, `forecast`, `rain`, `lightning`, `uv` and `air`, each null without a fresh reading; one failing feed doesn't hide the others. Its replies are no longer kept stale in browsers. Parsing is in `src/weather.ts`, tested against NEA responses saved on 24 Nov.
- `tests/test_colours.py` reads the colours from `public/app.css` and `public/app.js`, simulates protanopia, deuteranopia and tritanopia (Machado et al. 2009) and fails if any two colours that carry meaning come within CIEDE2000 ΔE 15 of each other. `tools/colours.py` prints a report.

## 2026-11-23: Temperature card, and corrections

### Changed
- The live air temperature is now a card near the top of park pages and "near" views: a large reading, the NEA station it comes from, how far away it is, and when it was taken. The card's colour runs from blue to red on Singapore's own scale: dark blue under 26 °C, light blue to 29 °C, yellow to 31 °C, orange to 33 °C, dark red above.

### Fixed
- The About panel said trees in parks are listed under the park. In fact a park tree within 30 m of a named road counts for both the road and the park (about 29% of park trees), so it appears on both pages. The text now says so.

## 2026-11-22: Trails, amenities, heritage and more

### Added
- Trails: the Round Island Route, Coast-to-Coast Trail, Rail Corridor and NParks' other park connector routes, plus each town's cycling paths. See the route on the map, how many trees line it and how many per km. Find them in search or under "Leafiest trails and cycling routes".
- Park amenities: toilets, drinking fountains, playgrounds, shelters, BBQ pits, fitness corners and more, shown on park pages and around any spot. Hawker centres too.
- Heritage nearby: historic sites and national monuments around you, alongside heritage trees, with links to the National Heritage Board's pages.
- Trees per 1,000 residents for each area and subzone, from the 2020 census, with a ranking. Areas with under 1,000 residents get no figure.
- About this road: a short description from the National Library Board for about 110 roads.
- Live air temperature at the nearest NEA weather station, with its name and distance, on park pages and around any spot.

### Fixed
- The map's data sources are now a tidy card, one source per line, that fits phones, iPads and computers.
- The close and clear buttons have a bigger, bolder X that's easier to see and tap on phones.

## 2026-11-10: Accuracy, iPhone and iPad, reliability

### Accuracy
- Every data update is audited before it's published: all place and species figures are re-counted, and 300 random trees are compared with NParks' live records.
- Carbon is no longer estimated where the model doesn't apply: palms, and trunks recorded as wider than 2.12 m across. Single figs had been credited with up to 490 tonnes. The tree card says why there's no figure. Together with wood density, the island total is about 16% lower than at launch.
- Clearer wording: "of trees are native species"; changes read "not tracked yet" until a comparison has been made; data that's overdue for an update is labelled.

### iPhone and iPad
- Every control is at least 44 × 44 points on touch screens.
- On iPads and landscape iPhones, the top buttons no longer sit on the legend, the legend starts closed, and the side panel is narrower.
- Tapping quickly no longer lets a slow answer replace what you opened after it.

### Changed
- Tree data now updates once a week. It used to update whenever NParks' records changed as well, which was almost daily.

### Reliability
- Data updates are checked more thoroughly before the site switches to them, and can be undone in one step if something is wrong.

### Internal
- Tiles and search files switch together with the database, so a rollback restores a matching set. A `Roll back data` workflow does it in one step.
- `/api/health` for uptime monitoring; a failed update opens an issue; a missed weekly update triggers a rebuild.
- The three build requirements are written down in PRINCIPLES.md and enforced by tests, including a run in Safari's engine.
- New changelog entries are posted to the Telegram channel when they reach `main`.
- "Always optimise cost" is now a standing rule in PRINCIPLES.md and CLAUDE.md.
- Each data update writes about 6.3 million database rows instead of 8.9 million (partial indexes, no girth index), and updates run weekly only, to stay inside the database's included usage.

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
