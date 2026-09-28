// Is a Deck widget build still running, or did whatever was running it die?
//
// WHY THIS EXISTS. `buildDeckWidget.js` runs a ~15-minute build inside the server process — plan,
// code, review, push, merge, deploy. Then the merge triggers the deploy, and THE DEPLOY REPLACES THE
// PROCESS RUNNING THE BUILD. Whatever the build was going to do after the merge may simply never
// happen, and nothing catches it: the request is gone, so there is no exception to handle and no
// `finally` to run.
//
// Measured in production before this existed (2026-09-17 builds, read 2026-09-28): two rows sat at
// `deploying` and `verifying` for ELEVEN DAYS. Their widget code had merged and their registry
// entries were live, but the step that creates the account's `DeckWidgetInstance` row never ran, so
// the widget was unreachable — and Settings polls the newest row while its status is not done/failed,
// so the progress bar sat frozen on a build that had finished a week earlier.
//
// The fix is not "make the process survive its own deploy" — that is not possible. It is:
//   1. finish the DURABLE work (install the widget, reach a terminal status) BEFORE the wait, and
//   2. treat a non-terminal row that has stopped reporting as dead, so a bar can never hang forever.
//
// This module is the RULE for (2) and nothing else, so `scripts/verify-deck-widget-build.mjs` can
// test every branch in CI's no-install job. It is import-free on purpose — same reason
// creditPolicy.js and onrampChecklist.js are.

/** The statuses that mean a build is finished with, one way or the other. */
export const TERMINAL_BUILD_STATUSES = ['done', 'failed'];

/** Is this status terminal? Unknown/absent statuses are NOT terminal — see isStaleBuild. */
export function isTerminalBuildStatus(status) {
  return TERMINAL_BUILD_STATUSES.includes(String(status || '').trim().toLowerCase());
}

/**
 * How long a non-terminal row may go without an update before it is treated as dead.
 *
 * A build takes ~15 minutes end to end and rewrites this row at every stage (and every step inside
 * the build stage), so a healthy row is never quiet for long. 30 minutes is 2× the whole build: long
 * enough that a slow step cannot trip it, short enough that a user is not staring at a dead bar for
 * the rest of the day. Deliberately NOT "the time since creation" — that would kill a build that is
 * merely slow, which is the false positive that would get this switched off.
 */
export const STALE_BUILD_MS = 30 * 60 * 1000;

/**
 * Has this row stopped reporting? `nowMs` is injected so the rule is testable without a clock.
 *
 * A row with no usable timestamp is NOT stale: an unknown age is an absence of evidence, and failing
 * a build because its timestamp could not be read would be the guard inventing a fact.
 */
export function isStaleBuild(build, nowMs) {
  if (!build) return false;
  if (isTerminalBuildStatus(build.status)) return false;
  const stamp = build.updated_date ?? build.created_date;
  const at = stamp ? new Date(stamp).getTime() : NaN;
  if (!Number.isFinite(at) || at <= 0) return false;
  if (!Number.isFinite(nowMs)) return false;
  return nowMs - at > STALE_BUILD_MS;
}

/** Minutes since the row last moved, for the message. Null when the age is unknown. */
export function quietMinutes(build, nowMs) {
  const stamp = build?.updated_date ?? build?.created_date;
  const at = stamp ? new Date(stamp).getTime() : NaN;
  if (!Number.isFinite(at) || at <= 0 || !Number.isFinite(nowMs)) return null;
  return Math.max(0, Math.round((nowMs - at) / 60000));
}

/**
 * What to tell the user about a row that stopped reporting. Names the stage it died in, because the
 * stage is the only evidence of how far it got — and says plainly that nothing is still running, so
 * they know a retry is the next move rather than waiting longer.
 */
export function staleBuildMessage(build, nowMs) {
  const stage = String(build?.status || 'unknown');
  const quiet = quietMinutes(build, nowMs);
  const suffix = quiet === null ? 'it stopped reporting' : `it has not reported for ${quiet} minute${quiet === 1 ? '' : 's'}`;
  return `Stalled at "${stage}" — ${suffix}. Nothing is still running: a widget build runs inside the `
    + 'server process, and the deploy it triggers replaces that process, so the last steps can be cut '
    + 'off. Anything already merged is live; start the build again to finish it.';
}
