// Per-account opt-out for proactive Jarvis insight.
//
// WHY THIS IS THE WIDGET TOGGLE AND NOT A NEW SETTING
//
// Proactive insight reads across every life stream and business record and
// spends an LLM call, so an account that doesn't want it must be able to say so
// — otherwise the feature is something that happens TO the operator rather than
// for them.
//
// The control already existed: the insight renders in the "Jarvis's
// suggestions" widget (widgets/jarvis_suggestions.jsx), registered in
// src/pages/CommandDeck/deckWidgets.js with defaultEnabled true, and every
// account already has a deck_widget_instances row for it. So switching that
// widget off IS the opt-out: no new column, no new concept to learn, and
// nothing to migrate.
//
// The alternative — a new `deck_insight_enabled` column — was rejected on a
// concrete hazard, not on taste: src/entities.js listEntities() queries with no
// `select`, so it selects every column. Adding a column to any entity the
// frontend lists (CommandDeckContext.jsx:170 lists DeckBusinessProfile on every
// Deck load) makes that read throw `P2022 column does not exist` until the SQL
// is applied by hand — which would take down the whole Deck, not just the
// toggle. That is the documented incident class in lib/templateCompat.js and
// the earlier Deck "main data load silently broken in production" report.
//
// ABSENCE MEANS ENABLED. Rows are lazy-seeded (CommandDeckContext.jsx:195 only
// seeds when an account has NO widget rows at all) and the scheduler can run
// before an account has ever opened its Deck, so "no row" must resolve to the
// registry default of enabled, exactly as the frontend resolves it. Getting
// this backwards would silently opt every new account out of the feature.
export const INSIGHT_WIDGET_KEY = 'jarvis_suggestions';

// Mirrors `defaultEnabled: true` on this key in src/pages/CommandDeck/
// deckWidgets.js — asserted against that file by
// scripts/verify-insight-optout.mjs, because the server cannot import from src/.
export const INSIGHT_WIDGET_DEFAULT_ENABLED = true;

/**
 * Is this account opted out of proactive insight, given its widget rows?
 *
 * Absent row, non-array input, nulls and junk all resolve to NOT opted out —
 * the feature must never be switched off by a malformed read.
 *
 * @param {Array<{widget_key?: string, enabled?: boolean}>|null|undefined} widgetRows
 * @param {string} [key]
 * @returns {boolean}
 */
export function isInsightOptedOut(widgetRows, key = INSIGHT_WIDGET_KEY) {
  if (!Array.isArray(widgetRows)) return false;
  // `some`, not `every`: a disabled row must win. With the
  // @@unique([created_by_id, widget_key]) constraint there can only be one, but
  // if that ever stopped holding, respecting the opt-out (and not spending the
  // money) is the safe direction.
  return widgetRows.some((r) => r && r.widget_key === key && r.enabled === false);
}

/**
 * The subset of `userIds` that has opted out, from widget rows already fetched
 * in ONE batched query. Kept separate from the predicate because the scheduler
 * wants to settle this for every candidate account before it runs any of the
 * per-account activity probes — an opted-out account should cost nothing.
 *
 * Duplicate rows for one account collapse to a single id.
 *
 * @param {Array<{created_by_id?: string, widget_key?: string, enabled?: boolean}>|null|undefined} widgetRows
 * @param {Iterable<string>} userIds
 * @param {string} [key]
 * @returns {Set<string>}
 */
export function optedOutUserIds(widgetRows, userIds, key = INSIGHT_WIDGET_KEY) {
  const candidates = new Set(userIds || []);
  const out = new Set();
  if (!Array.isArray(widgetRows)) return out;
  for (const row of widgetRows) {
    if (!row || row.widget_key !== key || row.enabled !== false) continue;
    if (candidates.has(row.created_by_id)) out.add(row.created_by_id);
  }
  return out;
}
