// Whether the "building your widget" card on Settings should be on screen at all.
//
// WHY THIS EXISTS. A RUNNING build must be visible — that is the entire point of the card. A FINISHED
// one (done or failed) has already said what it had to say, and it was staying on screen forever:
//
//   * the only way to clear it was the X, and that X wrote the row's id to `localStorage` — so "I
//     cleared this" really meant "I cleared this on this browser until its site data is wiped". A
//     different device, a private window, or a cleared cache brought yesterday's failure straight back;
//   * and no dismissal at all meant the card stayed until the user pressed X, so a failed build became
//     permanent furniture in Settings.
//
// Rob, 2026-10-04: *"we still have that failed widget in my settings"* — a build that failed days
// earlier, on a card whose X had no way to stick.
//
// WHY THIS IS HERE AND NOT IN `server/src/lib/deckWidgetBuildState.js`. That module is the SERVER's
// rule for finishing abandoned rows, and it is reached from the entity read path. This card is decided
// in the browser, which cannot import server code — so the client-side rule lives here, and
// `scripts/verify-deck-widget-build.mjs` asserts the terminal-status list below still matches the
// server's, so the two can never drift apart quietly.
//
// Pure and import-free, so it runs in CI's no-install job and in `node --test` unchanged.

/** A finished build, one way or the other. Kept in step with server/src/lib/deckWidgetBuildState.js. */
export const TERMINAL_BUILD_STATUSES = ['done', 'failed'];

/**
 * How long a FINISHED card keeps showing after it settles, if nobody dismisses it.
 *
 * 24 hours: long enough that finishing a build and coming back after lunch still shows the result,
 * short enough that yesterday's failure is not furniture. Nothing is lost when it expires — the row is
 * still in the database, and the next build (or the Deck's own error) surfaces what matters.
 */
export const TERMINAL_BUILD_VISIBLE_MS = 24 * 60 * 60 * 1000;

/** Is this status one of the finished ones? Unknown/absent is NOT terminal — see shouldShowWidgetBuildCard. */
export function isTerminalBuildStatus(status) {
  return TERMINAL_BUILD_STATUSES.includes(String(status || '').trim().toLowerCase());
}

/**
 * Should the newest build row be shown as a card? `nowMs` is injected so this needs no clock to test.
 *
 * The four rules, in order:
 *   1. No row → nothing to show.
 *   2. Not terminal → ALWAYS show, and the clock is never consulted. Hiding live progress because of a
 *      date would be far worse than any stale card, and an unrecognised status is a running build as
 *      far as this is concerned.
 *   3. Dismissed by id → hide. Only a settled row reaches here, so an old dismissal can never hide a
 *      NEW build (which carries a new id), and a running build has no X to press.
 *   4. Terminal and older than the window → hide. A missing or unreadable timestamp KEEPS the card: an
 *      unknown age is an absence of evidence, and guessing "old" would silently swallow the result of
 *      a build that may have just failed.
 *
 * This answers "show it?" only. The caller still owns deciding whether to keep POLLING, which must keep
 * following the row regardless of whether the card is on screen.
 *
 * @param {object|null} build newest DeckWidgetBuild row
 * @param {{dismissedId?: string|null, nowMs?: number, ttlMs?: number}} [options]
 * @returns {boolean}
 */
export function shouldShowWidgetBuildCard(build, options = {}) {
  const { dismissedId = null, nowMs = Date.now(), ttlMs = TERMINAL_BUILD_VISIBLE_MS } = options;
  if (!build) return false;
  if (!isTerminalBuildStatus(build.status)) return true;
  if (dismissedId && build.id && String(build.id) === String(dismissedId)) return false;
  const stamp = build.updated_date ?? build.created_date;
  const at = stamp ? new Date(stamp).getTime() : NaN;
  if (!Number.isFinite(at) || at <= 0) return true;
  if (!Number.isFinite(nowMs) || !Number.isFinite(ttlMs)) return true;
  return nowMs - at <= ttlMs;
}
