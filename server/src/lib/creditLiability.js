// Deferred-revenue arithmetic, with no imports.
//
// WHY THIS IS A SEPARATE, IMPORT-FREE MODULE. `scripts/credits-report.mjs` reads
// production through `pg`, and the no-install guards job cannot load a package
// (hazard H4). The part of the report that can be wrong without anything
// failing is the arithmetic — which credits count as a liability, and what that
// is as a share of the provider bill — so it lives here where
// `scripts/verify-credits-policy.mjs` can call it directly.
//
// THE DISTINCTION THAT MATTERS. A customer balance is not all deferred revenue.
// The 200-credit signup grant was never paid for, so it is not a stored-value
// liability. Purchased credits are. Consumption is allocated to purchases
// first (the same rule `creditExpiry.js` uses), so what remains of a purchase
// after charges and expiry is the outstanding purchased balance — capped by the
// account's actual balance, because a manual correction must not make the
// report claim money the account no longer holds.

/** Credits are Decimal(14,4); compare and print at that precision. */
export function round4(value) {
  return Math.round(Number(value || 0) * 10000) / 10000;
}

function positive(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Unused PURCHASED credits on one account.
 *
 * `purchased − expired − charged` is what is left of the paid lots, because
 * consumption is allocated to purchases first. `balance` caps it: the account
 * cannot owe more than it holds, whatever the lots say after a manual
 * adjustment. A negative or missing balance contributes nothing.
 *
 * @param {{balance?: number|string, purchased?: number|string, expired?: number|string, charged?: number|string}} account
 * @returns {number} credits, rounded to 4 places
 */
export function purchasedOutstanding({ balance = 0, purchased = 0, expired = 0, charged = 0 } = {}) {
  const held = positive(balance);
  const remainingLots = Math.max(0, positive(purchased) - positive(expired) - positive(charged));
  return round4(Math.min(held, remainingLots));
}

/**
 * The report's figures, from totals the database query already summed.
 *
 * `floatShare` is outstanding purchased liability divided by the provider bill
 * for the same window. It is `null`, never Infinity or NaN, when there was no
 * provider spend: "we sold credits and the provider cost nothing this month" is
 * a fact to show as not-applicable, not a number to invent.
 *
 * @param {object} input
 * @param {number} [input.soldCredits] credits sold in the window
 * @param {number} [input.soldUsd] dollars collected in the window
 * @param {number} [input.consumedCredits] credits consumed in the window
 * @param {number} [input.expiredCredits] purchased credits expired in the window
 * @param {number} [input.outstandingPurchasedCredits] unused purchased credits, all accounts
 * @param {number} [input.totalBalanceCredits] every account balance, signup included
 * @param {number} [input.providerCostUsd] provider cost in the window
 * @param {number} input.creditRateUsd the face rate used to value a credit
 */
export function deferredRevenueSummary({
  soldCredits = 0,
  soldUsd = 0,
  consumedCredits = 0,
  expiredCredits = 0,
  outstandingPurchasedCredits = 0,
  totalBalanceCredits = 0,
  providerCostUsd = 0,
  creditRateUsd,
} = {}) {
  const rate = Number(creditRateUsd);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new TypeError('creditRateUsd must be a positive finite number');
  }

  const purchased = round4(positive(outstandingPurchasedCredits));
  const provider = round4(positive(providerCostUsd));
  const liabilityUsd = round4(purchased * rate);

  return {
    soldCredits: round4(positive(soldCredits)),
    soldUsd: round4(positive(soldUsd)),
    consumedCredits: round4(positive(consumedCredits)),
    expiredCredits: round4(positive(expiredCredits)),
    outstandingPurchasedCredits: purchased,
    outstandingLiabilityUsd: liabilityUsd,
    totalBalanceCredits: round4(positive(totalBalanceCredits)),
    totalBalanceUsd: round4(positive(totalBalanceCredits) * rate),
    providerCostUsd: provider,
    floatShare: provider > 0 ? liabilityUsd / provider : null,
  };
}
