# Decisions

Why TreeNerd works the way it does. Each entry says what was decided, why, and what would change it.
The rules every change must meet are in [PRINCIPLES.md](../PRINCIPLES.md); the method in detail is in the
README's Methodology. Add an entry when you make a choice someone might later question.

## Data and accuracy

**Never "every tree".** NParks records managed trees, not the forest, so the site says how many trees
NParks records (the live count) and that forest trees aren't included. The link-preview image carries no count.

**No figure is written into the code or the page text.** Counts (trees, stations, roads with stories)
come from the build and are shown from `/api/meta` or the database. The method's limits (road distance,
trail distance, census year, minimum residents, carbon limit, MRT radius) are published by each build in
`meta.method`; the app reads them, and its fallback for older builds is checked against the pipeline by
`tests/test_method.py`. Rankings say how many places are listed, not a fixed "Top 25". Page descriptions
for link previews give no number. *Why:* NParks' data changes weekly, and text that was true on the day
it was written goes quietly wrong. The README's percentages are dated for the same reason.

**Unknown stays unknown.** A species' origin is marked non-native only when Kew records its whole
native range outside Asia; otherwise it's left blank. Height is shown in NParks' 3 m bands, not as a
single number. *Why:* a guessed value looks exactly like a measured one.

**Roads are derived.** NParks gives no street, so each tree goes to the nearest named road within
`roadMaxDistanceM` (30 m), preferring main roads. A park tree that close to a road counts for both.
*Why:* that's what a visitor walking the road sees. Counting it once would hide either the road's trees
or the park's.

**Carbon is only estimated where the model applies.** Chave et al. (2014) was fitted to trunks 5-212 cm
across and doesn't cover palms, so no estimate is made outside that range. *Why:* single figs measured
around their aerial roots were being credited with up to 490 tonnes.

**Trees per resident needs 1,000 residents.** *Why:* a ratio over a handful of people means nothing
(Tengah had 10 in 2020).

**Trails leave out nature reserve paths.** *Why:* forest trees aren't recorded one by one, so the counts
would look tiny and mislead.

**Park amenities: a chosen list.** Car parks, notice boards and map boards aren't shown. The build logs
the classes it leaves out, so a new kind NParks adds is noticed and can be added to `FACILITY_CLASSES`.

**A big jump in changes is treated as a data problem.** More than 5% of trees appearing or disappearing
in one update isn't logged as news. *Why:* that is almost always NParks re-issuing records.

**Tree Conservation Areas: pages and outlines, no tree list.** The two areas hold about 129,000 recorded
trees. Listing or highlighting them would need an index on the trees table, rebuilt every update (about
0.6 million billed rows a month); the build works out their figures instead and the map draws the
boundary. The rule is quoted from NParks' current guidelines (girth over 1 m, measured 1 m above the
ground; older NParks material said 0.5 m). No count of "trees over 1 m" and no per-tree verdict: NParks'
records don't say at what height each girth was measured. No fine amount: it couldn't be confirmed from
the Act (the statute site refuses automated reads). The page says plainly that most private trees aren't
on the map, though the rule covers them, so a homeowner doesn't read "no dots" as "no rule".

**Area outlines are NParks' boundaries as published.** Every point is kept (coordinates to about 10 cm).
A simplified outline was within 3.6 m of NParks' line, but these are legal boundaries and the full
outlines are only about 80 KB, so there is no reason to redraw them. Which trees are inside is always
decided against NParks' original boundary.

**The "Conservation" tree type keeps NParks' name, with an explanation.** It's NParks' "conservation
trees" layer, mostly in nature parks and reserves, and different from the Tree Conservation Areas.
Renaming it (say, "Nature areas") would be our reading of the data, not NParks' definition.

## Live weather (NEA)

Readings come from NEA's real-time feeds (`src/weather.ts`). Each shows where it's from and when, and is
hidden once it's older than its feed's normal interval allows. Nothing is stored, and each feed is fetched
at most every two minutes, so there is no database cost.

| Shown | Why |
|---|---|
| Air temperature | People know it. Nearest station, under 30 min old. |
| Heat stress (WBGT) | The best single guide to whether a walk is comfortable. NEA's own rating, so we don't invent one. It already includes humidity, wind and sun. |
| 2-hour forecast | "Will it rain on my walk?" Nearest forecast area, named on the card. |
| Rain now | Measured, and from the densest network (rain gauges). Shown only while raining: no row is not a claim that it's dry. |
| Lightning | Safety in open parks. Shown for a strike within 10 km in the last 15 minutes. The 10 km is our choice, so the card shows the distance and never calls it "danger". NEA's feed includes strikes far outside Singapore. |
| UV index | Relevant to shade. NEA publishes one reading for Singapore, measured at Changi, and the card says so. Hidden at night (0). |
| PM2.5 (1-hour) | Air quality right now. Chosen by the owner over the 24-hour PSI, which lags. NEA's bands and advice are quoted from haze.gov.sg. The region is named, not called "here", because NEA doesn't publish region boundaries in this feed. |

| Not shown | Why |
|---|---|
| Humidity | Nearly always 60-95% in Singapore, so it doesn't help a decision; its effect is in heat stress. |
| Wind speed and direction | Measured in the open, not under trees, so it would misdescribe a shaded path. A "strong wind, keep away from trees" note would need a threshold NEA doesn't publish. |
| 24-hour PSI | Lags; replaced by 1-hour PM2.5 (owner's choice). |
| 24-hour and 4-day forecasts, radar | Not about the spot, and heavy on phones. |
| Flood alerts | About drains and roads, not trees. |

**Where the card appears.** Trees, parks, planning areas, subzones and roads up to 3 km across (from
the middle of the place's bounding box), and around any spot. Not on trails, park connectors (owner's
choice), constituencies or longer roads: one reading can't describe somewhere several km long. The card
says where distances are measured from.

**Distances under 1 km are shown to the nearest 100 m.** The point sent is rounded to 0.001° (about
100 m) so answers can be cached and a visitor's exact position never leaves the browser. Showing "640 m"
would claim more precision than that.

**One shared NEA cache, and backing off when refused.** data.gov.sg allows 12 real-time requests per
10 seconds with a development key (30 with a production key), and a weather card needs 7. When `/status`
fetched NEA directly, two open status tabs and a few visitors were enough to be refused. Now everything
reads through one 2-minute cache per data centre, and a refusal is remembered for 20 seconds so nothing
keeps asking. A production key would give more room.

**A feed that stops working is reported, not just hidden.** Hiding a reading keeps the page right, but
without an alert a broken feed could go unnoticed for weeks. The Worker checks every feed hourly and,
after an hour of trouble, opens a GitHub issue (at most one reminder a day), closing it on recovery.
Brief gaps don't alert. *Cost:* 7 requests an hour to NEA, and database writes only when the state
changes.

**Temperature colours follow Singapore's scale**, from NEA's 2024 readings (6.9 million, all stations):
under 26 °C is the coolest 5%, 26-29 a typical night or morning, 29-31 a typical day, 31-33 a hot
afternoon, 33 and up the hottest 2%. *Why:* a global scale would show almost every reading as hot.
Recheck against a newer year if the colours start to feel wrong.

## Design (iPhone and iPad first)

**Colour-blind-safe colours.** Every set of colours that means something stays distinguishable with
protanopia, deuteranopia and tritanopia (CIEDE2000 ΔE at least 15, checked by `tests/test_colours.py`).
Colour is never the only cue: legends name the types, points of interest are rings rather than dots,
and the trail is a neutral line. Temperature colours change in lightness as well as hue, so their order
survives colour blindness.

**Small screens first.** Touch targets are at least 44 points. Panels come up from the bottom on phones,
and nothing depends on hover. The weather card puts each reading's source on its own smaller line, so the
value reads first.

**The tree-types panel never hides a filter.** It's called "Tree types", not "Show" (which read as
a button) or Show/Hide (which would sit above the checkboxes and read as "hide these trees"). Closed, it
still shows a dot per type and the number of trees on the map, so the colours can be read and a filter
can't be forgotten: switched-off types are hollow rings and the count reads "4 of 6 types". "Show all"
appears only while something is off. Counts are the build's per-type counts.

**Features hide until their data exists.** Trails and the per-resident rankings appear only once the
live build has them. *Why:* code and data deploy separately, and an empty feature looks broken.

## Reliability and cost

**Blue/green data.** Each update loads into the database that isn't live, is audited, then switched to.
The previous build is kept for a one-step rollback.

**Weekly updates only.** An update rewrites the whole database: about 6.5 million billed rows, against
50 million included a month. No extra updates, rebuild triggers or full indexes on `trees` without
stating the cost.

**Edge caching before computing.** Anything that's the same for every visitor is cached at the edge;
API answers are keyed to the build. Live weather is cached for a minute and never kept stale in browsers.

**Tests run on their own Worker environment**, with a rate limit a fast test run can't hit, and on
WebKit (macOS) as well as Chromium, because most visitors use Safari on iOS.

**One page shows whether every dependency works.** `/status` checks the other services live on load (reused
for 30 seconds, rate-limited like the API), but reads NEA through the weather card's shared cache and reads when the scheduled jobs last ran. It shows whether each
secret is set and accepted, never its value. The jobs record their last run in the live database's meta
table (about 840 rows a month); that history starts again after each weekly update, which replaces the
database. It isn't linked or indexed; Cloudflare Access is what actually keeps it private.

**The dev site is behind Cloudflare Access** and shows a banner, so unfinished work isn't mistaken for
the live site.
