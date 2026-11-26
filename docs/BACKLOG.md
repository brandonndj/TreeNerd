# Backlog

Findings from reviews that haven't been built yet, kept so they aren't lost. Each says why it matters and
anything already checked. Move an item out (and into `docs/DECISIONS.md` if it needed a choice) when it's
built. Figures are dated.

## UI and UX (review of 25 Nov 2026: iPhone 16 Pro, iPad 11-inch, laptop)

- **iPhone search results are cut off** ("Orchard MRT St…"): the list is as wide as the search box. Let it
  use the full screen width.
- **iPhone rankings start with three rows of buttons** (kind and measure) before any result. Use two
  compact pickers, or one row that scrolls sideways.
- **iPad text is small** (12-13 px for figures and labels in the panel). Raise it a step on tablets;
  consider a slightly wider panel in landscape.
- **Laptop:** a "/" shortcut to jump to search; use the width (wider panel, stat tiles in one row).
- **First visit:** nothing says you can tap a tree or press and hold the map. A one-line hint that goes
  away after first use.

## Data we already download but don't use (25 Nov 2026)

These are fetched every week and ignored; use them or stop fetching them (each costs update time).

- **NParks tree summary** (`TreesSG_TreesSummary`, 22 MB) and **heritage roads layer**
  (`TreesSG_HeritageRoads_New`): no use yet.
- **NParks park points** (`parks_points`) and **Central Nature Reserve hiking trails**
  (`cnr_hiking_trails`): trails are left out on purpose (forest trees aren't recorded one by one, so tree
  counts would mislead), but the lines could still be drawn without counts.
- **East Coast Park** is eight places (Areas A-H, as NParks names them on site). A combined "East Coast
  Park" page could sit above them, without replacing the areas.
- **Hawker centre addresses** (`ADDRESS_MYENV`) aren't shown in the hawker popup.
- NParks' tree field **FLOWERING** is "No" for every tree (25 Nov 2026): no information; don't show it.

## Datasets worth adding (data.gov.sg, checked 25 Nov 2026)

- **Nature Ways** (NParks): today only the name shows on tree pages. Pages and map lines like trails;
  they are NParks' forest-style planted corridors, so tree counts along them are meaningful.
- **Community in Bloom** (NParks, `d_f91a8b057cfb2bebf2e531ad8061e1c1`): 1,772 community gardens, points
  with names. "Community gardens near you".
- **Therapeutic Gardens** (`d_1fcf196c4f9f64155774a0cc6b368716`, 25 points, with wheelchair access,
  programmes, audience) and **Nature Playgardens** (`d_0bb9834ae2256f7840bd6cb5129d1113`, 35 points).
- **Coastal and Marine Habitat Map 2018** (NParks): mangroves and other habitats as areas.
- **SLA Vacant State land**: the Tree Conservation Area rule also covers vacant land, but this covers
  State land only, so it can't be presented as "where the rule applies".
- Not useful here: LTA traffic layers, NEA waste and health layers.

## Known limits (documented, nothing to do yet)

- **Subzones are from the 2019 Master Plan**, planning areas from 2025: no 2025 subzones are published
  yet, and the 2020 census counts residents by 2019 subzone. 185 trees (0.02%) sit in a 2019 subzone that
  straddles a 2025 planning-area boundary. Switch when 2025 subzones and matching census figures appear.
- **NParks' path field "wheeling"** isn't defined anywhere we could find, so paths aren't described as
  wheelchair-friendly. Use it once NParks defines it.
- **The fine for felling in a Tree Conservation Area** isn't stated: it couldn't be read from the Act
  (Singapore Statutes Online refuses automated reads). Confirm it by hand before adding it.

## Outside services: what can break, and what guards it

| Service | What can go wrong | Guard |
|---|---|---|
| NParks tree layer (ArcGIS) | Moved, renamed or truncated | Fetch refuses under 90% of the expected count; audit compares with the previous update and with 300 live records |
| data.gov.sg downloads | Dataset retired, rate limits | Required datasets stop the update; optional ones are compared with the previous update (a drop over 20% stops it) |
| NEA real-time feeds | Format change, rate limits (12/10 s dev key, 30/10 s production) | One shared cache, back-off on refusal, hourly check opens an issue after an hour |
| OneMap | Token expiry, outage | Token refreshed; /status checks sign-in, search and tiles |
| OpenStreetMap extract | Download fails | Falls back to SLA major roads; the audit's road-match floor then stops the update |
| Kew WCVP | Server down | Last copy kept in the workflow cache |
| GitHub | Scheduled workflows switched off after 60 days without activity | /status shows the workflow's state; the Worker requests a missed update after 8 days |
| Cloudflare D1 | Rows-written billing | Weekly updates only; no full indexes on trees |
