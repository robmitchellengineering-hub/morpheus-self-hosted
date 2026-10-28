// Purchased-credit expiry, as a pure rule.
//
// WHY THIS IS SEPARATE FROM billing.js. `billing.js` reaches Prisma through
// `db.js`, and CI's no-install guards job deliberately installs nothing
// (hazard H4). The expiry rule has to be testable there — the arithmetic is the
// part that can silently expire a customer's credits — so it lives here with no
// imports and `scripts/verify-credits-policy.mjs` calls it directly.
//
// THE RULE (docs/CREDITS-POLICY.md §7):
//   * only PURCHASED credits expire; the signup grant does not;
//   * consumption is allocated to purchases oldest-first, and the signup grant
//     is consumed LAST. Paid credits are therefore used before free ones, and
//     the free grant can never be the thing an expiry removes;
//   * a lot expires `months` calendar months after its purchase date;
//   * an expiry already applied is passed back in as `expiredCredits`, which is
//     why applying it twice does nothing (idempotence is arithmetic, not a flag).
//
// `remainingSignup` is returned so the database half can refuse to take the
// balance below the part of the signup grant the rule says is still unspent.
// That is a belt-and-braces guard: if a manual adjustment made the balance
// disagree with the lots, expiry under-takes rather than ever touching a grant.
//
// A credit is Decimal(14,4), so every returned amount is rounded to 4 places.

/** Credits compare at Decimal(14,4) precision. */
export function round4(value) {
  return Math.round(Number(value || 0) * 10000) / 10000;
}

/**
 * Add whole calendar months in UTC, clamping the day to the target month's last
 * day. 31 January + 1 month is 28/29 February, not 3 March — an expiry date that
 * jumps forward would give a customer less than the window they were sold.
 */
export function addMonths(date, months) {
  const from = new Date(date);
  if (Number.isNaN(from.getTime())) return null;
  const total = Number(months);
  if (!Number.isFinite(total)) return null;
  const day = from.getUTCDate();
  const target = new Date(Date.UTC(
    from.getUTCFullYear(),
    from.getUTCMonth() + Math.trunc(total),
    1,
    from.getUTCHours(),
    from.getUTCMinutes(),
    from.getUTCSeconds(),
    from.getUTCMilliseconds(),
  ));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target;
}

/**
 * How many purchased credits have expired as of `now`.
 *
 * @param {object} opts
 * @param {Array<{credits: number|string, created_date?: Date|string, createdDate?: Date|string}>} opts.purchases
 * @param {number} [opts.signupCredits] the non-expiring signup grant, consumed last
 * @param {number} opts.consumedCredits credits already spent (UsageEvent.credits_charged)
 * @param {number} [opts.expiredCredits] credits already expired (positive; expiry rows are negative in the ledger)
 * @param {number|null} opts.months configured window; null/<=0 = no expiry
 * @param {Date} [opts.now]
 * @returns {{credits: number, remainingSignup: number, lots: Array<{credits: number, expiresAt: string|null, remaining: number, expired: number, source: string}>}}
 */
export function expiredPurchasedCredits({
  purchases = [],
  signupCredits = 0,
  consumedCredits = 0,
  expiredCredits = 0,
  months = null,
  now = new Date(),
} = {}) {
  const signupRaw = Number(signupCredits ?? 0);
  const consumedRaw = Number(consumedCredits ?? 0);
  const expiredRaw = Number(expiredCredits ?? 0);

  // An unreadable or negative count is NOT zero. Zero consumption would leave
  // more of a paid lot looking unused and expire MORE of it, which is the one
  // direction this rule must never fail. Refuse to expire at all instead — the
  // same fail-closed direction `buildBudgetStore` uses for an unreadable budget.
  // `remainingSignup` is still returned so the database half never takes a
  // grant, even if a caller ignores `credits`.
  if (![signupRaw, consumedRaw, expiredRaw].every(Number.isFinite)
    || signupRaw < 0 || consumedRaw < 0 || expiredRaw < 0) {
    const protectedSignup = Number.isFinite(signupRaw) && signupRaw > 0 ? round4(signupRaw) : 0;
    return { credits: 0, remainingSignup: protectedSignup, lots: [] };
  }

  const signup = round4(signupRaw);
  const window = Number(months);
  // A window shorter than one whole month is not a window: `addMonths` would
  // truncate it to zero and expire the lot at the instant it was bought. The
  // config parser already refuses a fraction; this is the same rule for any
  // direct caller (a test, a future scheduler) so the safety does not depend on
  // which entry point reached the arithmetic.
  if (!Number.isFinite(window) || window < 1) {
    return { credits: 0, remainingSignup: signup, lots: [] };
  }

  const nowDate = new Date(now);
  if (Number.isNaN(nowDate.getTime())) {
    return { credits: 0, remainingSignup: signup, lots: [] };
  }

  const lots = (Array.isArray(purchases) ? purchases : [])
    .map((p) => {
      const created = new Date(p.created_date ?? p.createdDate);
      return { credits: Number(p.credits || 0), created };
    })
    .filter((p) => p.credits > 0 && !Number.isNaN(p.created.getTime()))
    .sort((a, b) => a.created - b.created);

  // Purchases are consumed first, oldest-first. Signup credits sit behind them,
  // so anything left after this walk is the unused purchased balance.
  let consumed = consumedRaw + expiredRaw;

  let expiredTotal = 0;
  const detail = [];
  for (const lot of lots) {
    const used = Math.min(lot.credits, consumed);
    consumed -= used;
    const remaining = round4(lot.credits - used);
    const expiresAt = addMonths(lot.created, window);
    const isExpired = remaining > 0 && expiresAt != null && expiresAt <= nowDate;
    if (isExpired) expiredTotal += remaining;
    detail.push({
      credits: round4(lot.credits),
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
      remaining,
      expired: isExpired ? remaining : 0,
      source: 'purchase',
    });
  }

  // Whatever consumption is left after every purchase has been used came from
  // the signup grant. The rest of the grant is protected from expiry.
  const remainingSignup = round4(Math.max(0, signup - Math.min(signup, consumed)));

  return { credits: round4(expiredTotal), remainingSignup, lots: detail };
}
