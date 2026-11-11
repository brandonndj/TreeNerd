# TreeNerd: instructions for AI coding sessions

Read `PRINCIPLES.md` before changing anything. Every build must meet its three requirements, in
this priority order, without compromise:

1. **Accuracy** (most important): nothing on the site may be wrong, guessed, or an estimate shown as fact.
2. **iPhone and iPad experience**: design and test for them first; 44-point touch targets; no overlap.
3. **Reliability**: all-or-nothing data updates, a kept rollback, loud failures, backward-compatible changes.

Rules for this repository:

- Never skip, disable, loosen or mark as allowed-to-fail any test, audit or CI check to get a change
  through. If a check is wrong, fix it in the same change and say why.
- Before pushing, run: `npm test`, `npx tsc --noEmit`, `python -m unittest discover -s tests`,
  `npm run test:e2e`.
- Any new figure shown to visitors must be added to `pipeline/audit.py` or to an accuracy test, and
  explained in the About panel and the README's Methodology.
- Any new view or control must be added to the iOS tests (`IOS_VIEWS` in `tests/e2e/ui.test.mjs`).
- The Worker must keep working on the data build that is live today: add fields, don't rename them,
  and tolerate their absence.
- Push to the working branch first (it deploys to dev.treenerd.fyi). `main` deploys the live site:
  push there only when the owner asks.
- After a pipeline, schema or tile change, regenerate the test fixture (`tests/e2e/make_fixture.py`).
- Every change visitors can notice needs a CHANGELOG.md entry in plain language: it is posted to the
  Telegram channel when it reaches `main`, word for word, so it must be accurate. Developer-only notes
  go under a `### Internal` heading, which is never posted.
- Keep the repository free of secrets and account-specific setup details.
