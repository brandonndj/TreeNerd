// Decisions made by the Worker's scheduled checks, kept pure so they can be tested (tests/schedule.test.mjs).

const DAY = 86400_000, HOUR = 3600_000;
/** A build older than this means the weekly update was missed (it runs every 7 days). */
export const OVERDUE_AFTER = 8 * DAY;
/** At most one automatic rebuild request in this long, so a run that keeps failing isn't retried in a loop. */
export const REBUILD_EVERY = 20 * HOUR;

/**
 * Whether to ask GitHub to run the data update now: only when the weekly update was missed (the build is
 * overdue), whether or not NParks has edited its records since, because the other sources (data.gov.sg,
 * roads) may have changed, and a site marked "update overdue" should recover on its own.
 */
export function rebuildDue({ now, builtAt, lastDispatch }: { now: number; builtAt: number; lastDispatch: number }) {
  const overdue = !Number.isFinite(builtAt) || now - builtAt > OVERDUE_AFTER;
  return overdue && now - (lastDispatch || 0) >= REBUILD_EVERY;
}
