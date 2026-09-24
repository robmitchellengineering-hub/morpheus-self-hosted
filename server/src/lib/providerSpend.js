// What the provider actually charged, measured rather than modelled.
//
// WHY THIS EXISTS
//
// The platform's cost figure is `UsageEvent.cost_usd`: an ESTIMATE from a static
// rate table. Measured on 2026-09-24 it ran about 2x the real DeepSeek charge —
// 30 days of estimate came to $172.75 against an actual spend under $100 — and
// the retail credits billed on top of that are 3.52x the estimate again. So
// every cost number the product shows is wrong by roughly a factor of two, and
// wrong in the direction that makes the platform look more expensive than it is.
//
// A better table would still be a model. The provider publishes a real balance
// (GET /user/balance, already polled every 15 minutes), and the DIFFERENCE
// between two readings across a window IS the spend — no pricing table anywhere
// in the path. These are the rules that turn readings into that number.
//
// Pure by design — no database, no network — so the arithmetic that reports
// real money can be tested with no install, the same reason lib/selfDevRunRules.js
// and lib/selfDevSyncSafety.js are pure. scripts/verify-provider-spend.mjs
// exercises it.
const round2 = (n) => Math.round(Number(n) * 100) / 100;

/**
 * Spend between the first and last reading in a window.
 *
 * @param {Array<{balanceUsd: number, readAt: string|Date}>} readings any order
 * @returns {{available: false, reason: string}
 *         | {available: true, spendUsd: number, creditedUsd: number, from: string, to: string, samples: number}}
 */
export function spendBetween(readings = []) {
  const rows = (Array.isArray(readings) ? readings : [])
    .filter((r) => r && Number.isFinite(Number(r.balanceUsd)) && r.readAt != null)
    .map((r) => ({ balanceUsd: Number(r.balanceUsd), at: new Date(r.readAt).getTime() }))
    .filter((r) => Number.isFinite(r.at))
    .sort((a, b) => a.at - b.at);

  if (rows.length < 2) {
    return { available: false, reason: 'need at least two balance readings to measure a delta; the poll records one every 15 minutes' };
  }

  const first = rows[0];
  const last = rows[rows.length - 1];
  const delta = first.balanceUsd - last.balanceUsd;

  // A negative delta is a top-up, and reporting it as negative spend would let a
  // credit look like a refund of usage. Separated so the two are never confused.
  return {
    available: true,
    spendUsd: round2(Math.max(0, delta)),
    creditedUsd: round2(Math.max(0, -delta)),
    from: new Date(first.at).toISOString(),
    to: new Date(last.at).toISOString(),
    samples: rows.length,
  };
}

/**
 * How far the estimate and the measured bill disagree.
 *
 * Reported as a ratio rather than a verdict: `estimateUsd / spendUsd`. A value
 * near 1 means the rate table tracks reality; 2 means the platform is reporting
 * twice what it pays, which is the state this module was written to expose.
 */
export function estimateVsActual(estimateUsd, measured) {
  const estimate = Number(estimateUsd) || 0;
  if (!measured?.available || !(measured.spendUsd > 0)) {
    return { comparable: false, reason: measured?.reason || 'no measured spend in this window' };
  }
  return {
    comparable: true,
    estimateUsd: round2(estimate),
    spendUsd: measured.spendUsd,
    // >1: the estimate overstates the bill. <1: it understates it, which is the
    // more dangerous direction and the reason this is reported both ways.
    ratio: Math.round((estimate / measured.spendUsd) * 100) / 100,
  };
}

/**
 * One line a human can read, and the only place the wording lives.
 *
 * Deliberately never says "cost" of the estimate: the whole failure being fixed
 * is a modelled number wearing the word for a measured one.
 */
export function describeSpend(measured) {
  if (!measured?.available) return `Actual provider spend: unavailable — ${measured?.reason || 'not measured'}.`;
  const credited = measured.creditedUsd > 0 ? `, plus $${measured.creditedUsd.toFixed(2)} topped up` : '';
  return `Actual provider spend: $${measured.spendUsd.toFixed(2)} over ${measured.samples} reading(s)${credited}.`;
}
