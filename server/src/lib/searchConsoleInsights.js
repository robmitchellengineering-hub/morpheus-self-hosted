// Turning Search Console rows into "what should I do next" — pure, so the rules
// are asserted rather than eyeballed (scripts/verify-search-console.mjs).
//
// Everything in this file is pure and dependency-free on purpose: the guard runs
// in CI's no-install job, so it must not reach @prisma/client through
// lib/searchConsole.js (hazard H4 — there is no lockfile to install from, and
// H12's class is a module that only fails once something loads it). That is why
// Google's error classification lives here beside the derivation rather than in
// the file that talks to Google.
//
// THE HONESTY RULES THIS FILE EXISTS TO KEEP
//
// 1. Every number here comes from Google for the account's OWN property. There
//    is no search volume, no difficulty score, no competitor number and no
//    ranking estimate, and nothing in the returned shape has a field to put one
//    in — the same discipline as keyword research (lib/keywordResearch.js).
// 2. "Low CTR" is measured against the SITE'S OWN data at that position, not an
//    industry benchmark. A generic "position 3 should get 11%" table is a
//    fabricated precision: it is wrong for a brand term, wrong for a long-tail
//    query, and unverifiable by the operator. Comparing a page to its own
//    positions is something the operator can check for themselves.
// 3. An aggregate position is IMPRESSION-WEIGHTED. Averaging the positions of
//    rows would report a site's position as if every query mattered equally,
//    which is how a site ranking #1 for nothing and #80 for something looks
//    "average" — the same mistake as averaging averages.
// 4. Empty input returns empty output, never a zero that reads as "you have no
//    traffic". The caller distinguishes "no data in this window" from "we could
//    not read it".

/**
 * Turn a Google API failure into something the operator can act on.
 *
 * The one that matters in practice is `accessNotConfigured`: the OAuth consent
 * works and the token is valid, but the Search Console API has not been enabled
 * on the Cloud project, so every call answers 403. Left raw that reads as "your
 * connection is broken" and sends someone hunting in the wrong place, so it is
 * named explicitly with the fix.
 */
export function describeGoogleError(status, body) {
  const err = body && body.error ? body.error : {};
  const reason = Array.isArray(err.errors) && err.errors[0] ? err.errors[0].reason : err.status;
  const message = err.message || '';

  if (status === 403 && (reason === 'accessNotConfigured' || /has not been used in project|is disabled/i.test(message))) {
    return {
      code: 'API_NOT_ENABLED',
      message: 'The Search Console API is not enabled on this deployment\'s Google Cloud project. Enable it at https://console.cloud.google.com/apis/library/searchconsole.googleapis.com and try again — the Google connection itself is fine.',
    };
  }
  if (status === 401) {
    return { code: 'TOKEN_REJECTED', message: 'Google rejected the stored token. Disconnect and reconnect Search Console.' };
  }
  if (status === 403) {
    return {
      code: 'NO_ACCESS',
      message: `Google refused that property for this account (${message || 'insufficient permission'}). Check the property is verified for the Google account you connected.`,
    };
  }
  if (status === 404) {
    return { code: 'NO_SUCH_PROPERTY', message: 'That property does not exist for this account any more. Re-pick it from the list.' };
  }
  return { code: 'GOOGLE_ERROR', message: message || `Google returned HTTP ${status}.` };
}

/** Positions at or beyond this are worth improving: page one's tail. */
export const STRIKING_MIN_POSITION = 8;
/** Past this, a query is usually a different project rather than a nudge. */
export const STRIKING_MAX_POSITION = 20;
/** Below this many impressions in the window, a position is mostly noise. */
export const STRIKING_MIN_IMPRESSIONS = 20;
/** A CTR finding needs enough impressions to mean anything. */
export const LOW_CTR_MIN_IMPRESSIONS = 50;
/** Share of the site's own positional median below which a CTR stands out. */
export const LOW_CTR_BASELINE_RATIO = 0.5;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** The position bands a CTR is compared within. Coarse on purpose: a band with
 *  a handful of rows should not produce a confident-looking median. */
export const POSITION_BANDS = [
  { id: '1-3', min: 1, max: 3 },
  { id: '4-7', min: 4, max: 7 },
  { id: '8-20', min: 8, max: 20 },
  { id: '21-50', min: 21, max: 50 },
  { id: '51+', min: 51, max: Infinity },
];

export function positionBand(position) {
  const p = num(position);
  const band = POSITION_BANDS.find((b) => p >= b.min && p <= b.max);
  return band ? band.id : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Totals for a set of rows.
 *
 * CTR is derived from the totals (clicks ÷ impressions), not averaged from the
 * rows' CTRs; position is impression-weighted. Both are the same quantities
 * Search Console itself reports for a property, so the operator can check them
 * against Google's own screen.
 */
export function totals(rows = []) {
  let clicks = 0;
  let impressions = 0;
  let weighted = 0;
  for (const r of rows) {
    const c = num(r.clicks);
    const i = num(r.impressions);
    clicks += c;
    impressions += i;
    weighted += num(r.position) * i;
  }
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : null,
    position: impressions > 0 ? weighted / impressions : null,
    rows: rows.length,
  };
}

/**
 * The site's OWN median CTR per position band, with the count behind each.
 *
 * `n` is returned because a median over two rows is not a baseline, and the
 * caller has to be able to say so. Bands that cannot be measured are absent
 * rather than filled with a guess.
 */
export function positionalBaseline(rows = []) {
  const bands = {};
  for (const band of POSITION_BANDS) bands[band.id] = { ctrs: [], impressions: 0 };
  for (const r of rows) {
    const band = positionBand(r.position);
    if (!band) continue;
    const impressions = num(r.impressions);
    if (impressions <= 0) continue;
    bands[band].ctrs.push(num(r.ctr));
    bands[band].impressions += impressions;
  }
  const out = {};
  for (const [id, b] of Object.entries(bands)) {
    out[id] = { medianCtr: median(b.ctrs), rows: b.ctrs.length, impressions: b.impressions };
  }
  return out;
}

function withKey(row, key) {
  return {
    key: String((row.keys && row.keys[0]) || ''),
    clicks: Math.round(num(row.clicks)),
    impressions: Math.round(num(row.impressions)),
    ctr: num(row.ctr),
    position: num(row.position),
    signal: key,
  };
}

/**
 * Queries close enough to page one that a nudge could move them.
 *
 * Sorted by impressions, because that is the honest proxy for "worth doing
 * first": a position-11 query with 2,000 impressions is a bigger opportunity
 * than one with 20, and we have no volume data to rank them by instead.
 */
export function strikingDistance(rows = [], {
  minPosition = STRIKING_MIN_POSITION,
  maxPosition = STRIKING_MAX_POSITION,
  minImpressions = STRIKING_MIN_IMPRESSIONS,
} = {}) {
  return rows
    .filter((r) => {
      const p = num(r.position);
      return p >= minPosition && p <= maxPosition && num(r.impressions) >= minImpressions;
    })
    .map((r) => withKey(r, 'google-search-console'))
    .sort((a, b) => b.impressions - a.impressions);
}

/**
 * Queries whose CTR is well below what this site gets at the same position.
 *
 * The comparison is within the row's own band, using the site's median for that
 * band, and a band needs at least 3 measured rows before it is used at all —
 * otherwise one unlucky row becomes the baseline for itself and nothing is ever
 * flagged. When a band cannot be measured, no rows are flagged from it, and the
 * payload says which bands those were.
 */
export function lowCtr(rows = [], {
  minImpressions = LOW_CTR_MIN_IMPRESSIONS,
  ratio = LOW_CTR_BASELINE_RATIO,
  minBaselineRows = 3,
} = {}) {
  const baseline = positionalBaseline(rows);
  const out = [];
  for (const r of rows) {
    const impressions = num(r.impressions);
    if (impressions < minImpressions) continue;
    const band = positionBand(r.position);
    if (!band) continue;
    const b = baseline[band];
    if (!b || b.rows < minBaselineRows || b.medianCtr === null || b.medianCtr <= 0) continue;
    if (num(r.ctr) < b.medianCtr * ratio) {
      out.push({
        ...withKey(r, 'local median for this position'),
        band,
        bandMedianCtr: b.medianCtr,
        bandRows: b.rows,
      });
    }
  }
  return out.sort((a, b) => b.impressions - a.impressions);
}

/** The biggest rows by a dimension — top queries or top pages. */
export function topRows(rows = [], limit = 10) {
  return [...rows]
    .map((r) => withKey(r, 'google-search-console'))
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
    .slice(0, limit);
}

/** Bands with too little of the site's own data to compare against. */
export function bandsWithoutBaseline(rows = [], minBaselineRows = 3) {
  const baseline = positionalBaseline(rows);
  return POSITION_BANDS
    .filter((b) => baseline[b.id].impressions > 0 && baseline[b.id].rows < minBaselineRows)
    .map((b) => b.id);
}

/**
 * The whole overview payload for one property and window.
 *
 * `queryRows` and `pageRows` are the two Search Analytics calls the caller has
 * already made (dimension=query and dimension=page); this function does no I/O.
 */
export function buildOverview({ queryRows = [], pageRows = [], days = 28, property = null } = {}) {
  const queryBaseline = positionalBaseline(queryRows);
  return {
    property,
    days,
    totals: totals(queryRows),
    topQueries: topRows(queryRows, 10),
    topPages: topRows(pageRows, 10),
    strikingDistance: strikingDistance(queryRows, {}),
    lowCtr: lowCtr(queryRows, {}),
    baseline: queryBaseline,
    // Named explicitly so the UI can say "not enough of your own data to judge
    // positions 21-50 yet" rather than showing an empty list that reads as
    // "nothing to fix".
    bandsThinOnData: bandsWithoutBaseline(queryRows),
    // What this data is, and what it is not. Rendered in the panel: a number
    // without its provenance is the thing that gets repeated out of context.
    disclosure: {
      source: 'Google Search Console, for the property you selected',
      window: `the last ${days} days`,
      windowLabel: 'Search Console reports on Pacific time, and the last day or two may still settle',
      notIncluded: 'Search Console\'s public API has no backlinks method, so nothing here describes who links to you — use the Links report in Search Console for that.',
      noEstimates: 'Every figure is Google\'s own. Morpheus adds no volume, difficulty or ranking estimates.',
    },
  };
}
