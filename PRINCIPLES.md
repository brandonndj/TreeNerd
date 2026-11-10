# Build requirements

Three things are required of every TreeNerd build, in this order of priority. They are not
trade-offs against features or speed: a change that weakens any of them does not ship.

1. **Accuracy.** What the site shows must be true to the source data, or say plainly that it isn't known.
2. **iPhone and iPad experience.** The site is mostly used on iPhones and iPads; it must work well there first.
3. **Reliability.** The site stays up, stays current, and can always be put back to a known-good state.

Each requirement has automated checks. **The checks are part of the requirement**: they are never
skipped, disabled, loosened or marked as allowed to fail to get a build through. If a check is wrong,
fix the check in the same change and explain why.

## 1. Accuracy (most important)

**The rule:** every number, name and statement on the site is either correct for the data it came
from, or labelled as an estimate, or absent. Never a guess presented as a fact.

- **Show the source's value, not a tidied one.** Odd records are flagged, not hidden or "corrected".
- **Don't infer what the data can't support.** Unknown stays unknown: a species' origin isn't guessed,
  a tree missing from the records isn't called "felled", and "no changes" is only said once a
  comparison has actually been made.
- **Estimates only where the method applies.** The carbon model covers ordinary trunks; palms and
  trunks wider than it was fitted to get no figure, and the page says why.
- **Label estimates and their inputs** (for example, the wood density used and where it came from).
- **Filled-in data needs a measured accuracy bar**, checked on every build against values that are
  known. Below the bar, the field isn't filled.
- **Old data is labelled as old.** If an update is overdue, the site says so.

**Enforced by**

| Check | Where | What it does |
|---|---|---|
| Accuracy audit | `pipeline/audit.py`, run in the data workflow before publishing | Re-counts every place and species figure from the tree table; checks the search index and build summary against the database; range-checks the data; compares 300 random trees with NParks' live records. Any failure stops the update. |
| Enrichment accuracy bar | `pipeline/enrich.py` | Hides NParks' own family and origin labels, predicts them, and only fills gaps if agreement is at least 99% (family) and 100% (origin). |
| Change-log guard | `pipeline/changes.py` | A build where more than 5% of trees appear or vanish is treated as a data problem and not reported as news. |
| Load verification | data workflow | The database must hold exactly the rows the build produced before the site switches to it. |
| On-page accuracy tests | `tests/e2e/ui.test.mjs` | The figures on the page must equal the API's; estimates must carry their label and reason. |
| Unit tests | `tests/test_audit.py`, `test_enrich.py`, `test_changes.py`, `test_build.py` | Each rule above has a test that fails when the rule is broken. |

**When you add or change something that shows data:** add the figure to the audit (or a test that
compares it with an independent count), state its source and limits in the About panel and the
README's Methodology, and decide what the page shows when the value is unknown.

## 2. iPhone and iPad experience

**The rule:** design and test for iPhone and iPad first, in portrait and landscape. Desktop follows.

- **Touch targets are at least 44 × 44 points** on touch screens. No exceptions for "small" links.
- **Nothing overlaps or scrolls sideways** at any iPhone or iPad size, in either orientation.
- **The map stays visible.** Panels and the legend start small where space is short.
- **One-handed use on a phone:** results and details come up from the bottom.
- **Safe areas are respected** (notch, home indicator); no control sits under them.
- **Nothing depends on hover**, a mouse wheel or a right-click. Where desktop has one, touch has an equal (press and hold the map for "trees here").
- **Taps answer at once.** If the answer takes time, a loading state appears; a slow answer never
  replaces something the person opened afterwards.
- **Light and dark** both stay readable.
- **Works on restrictive networks:** ordinary requests only, with no reliance on partial-file requests.

**Enforced by**

| Check | Where | What it does |
|---|---|---|
| Size, overlap and overflow tests | `tests/e2e/ui.test.mjs` | On iPhone and iPad profiles, portrait and landscape, across the main views: every control at least 44 × 44, nothing overlapping the legend, no sideways scroll. |
| Behaviour tests | same | Bottom sheet, collapsed legend, theme, search, history, loading states, latest-tap-wins. |
| Safari's engine | CI `integration` job | The whole browser suite runs in WebKit as well as Chromium. |

**When you add or change UI:** check it on an iPhone and an iPad size in both orientations, add the
new view to `IOS_VIEWS` in the tests, and give every new control a 44-point target.

## 3. Reliability

**The rule:** visitors never see a broken or half-updated site, and any update can be undone.

- **Updates are all-or-nothing.** New data is loaded beside the live data, verified, then switched to
  in one step, together with the tiles and search files that belong to it.
- **The previous build is always kept** and can be restored with one action (`Roll back data` workflow).
- **Failures are loud.** A failed update opens an issue; a missed weekly update triggers a rebuild;
  `/api/health` reports when anything is missing or stale.
- **New code works with old data and old code with new data**, because the two deploy separately.
- **Nothing a visitor can send changes anything.** The API is read-only, validated, rate-limited and cached.
- **Every change is tested before it ships**, and reviewed on the dev site before `main`.

**Enforced by**

| Check | Where | What it does |
|---|---|---|
| CI | `.github/workflows/ci.yml` | Unit tests, type check, dependency audit, a build dry run, and the integration suite (API and browser, Chromium and WebKit). |
| Staged data updates | `.github/workflows/data.yml` | Audit, load the idle database, verify, publish its files, switch, confirm the live site switched. |
| Health endpoint | `/api/health` | 200 only when the database, search index and tiles are present and the data is under 10 days old. |
| Rollback | `.github/workflows/rollback.yml` | Switches back to the previous build after checking it is complete. |
| API tests | `tests/e2e/api.test.mjs` | Input validation, allowlists, security headers, cache behaviour, health. |

**When you change the data format, schema or deployment:** keep the Worker able to run on the
previous build (add, don't rename; tolerate missing fields), and say in the change what happens if
it has to be rolled back.

## Before merging to `main`

- [ ] `npm test`, `python -m unittest discover -s tests` and `npm run test:e2e` pass, unmodified.
- [ ] CI is green on both browsers.
- [ ] Any new figure is covered by the audit or an accuracy test, and documented.
- [ ] Any new UI was checked at iPhone and iPad sizes and added to the iOS tests.
- [ ] The change works with the data that is live today.
- [ ] The dev site was checked.
