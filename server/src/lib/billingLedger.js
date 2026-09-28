// Does the money we recorded match the money we charged?
//
// WHY THIS EXISTS. `reality.mjs` already checks that every production model has a price, and that no
// account is left negative. What nothing checked — token plan Step 7, reported NOT BUILT — is the
// ledger itself: that `usage_events.credits_charged` is what the pricing policy says it should be, and
// that a user's `credit_balance` equals what their purchases and charges say it should be. Those are
// three different claims about the same money, written by three different code paths, and the whole
// "honest meter" promise rests on them agreeing.
//
// MEASURED, 2026-09-28, against production — so the shape of the truth is known before the checker was
// written, rather than assumed:
//
//   * The retail formula holds EXACTLY. A sampled row charged 14.9016 credits; the formula
//     (tokens × the resolved rate × markup ÷ $0.005) gives 14.9016. So the meter is self-consistent.
//   * `credit_balance == 200 + purchases − charged` holds for every account EXCEPT one, and that one
//     is the documented absorption case: the account exhausted, `reconcileCredits` refuses to take a
//     balance below zero, and the remainder is absorbed as platform cost. So the invariant needs that
//     case named, not an equality that would cry wolf on the intended behaviour.
//   * One admin row was charged 5.1348 credits on 2026-09-01 — the first day of usage, before the
//     role exemption was in force. The check therefore REPORTS it rather than failing on it: the role
//     a user held when a call was made is not recorded, so it cannot be verified retroactively.
//
// This module is the maths only, so `scripts/verify-billing-ledger-math.mjs` can test every branch in
// CI's no-install job. Its ONE import is `creditPolicy.js`, which is import-free for the same reason:
// the flat credit is a money constant and must have a single home rather than a literal here that can
// drift from the meter. The database half lives in `scripts/verify-billing-ledger.mjs`, which uses the
// REAL pricing functions (`resolveBillingRate`, `resolveBillingMarkup`, `usdToCredits`) so the checker
// cannot drift from the meter it is checking.
import { FLAT_CALL_CREDITS } from './creditPolicy.js';

/** The signup grant, as a column default rather than a transaction — see the schema. */
export const SIGNUP_CREDITS = 200;

/** Credits are Decimal(14,4); compare at that precision, never on raw floats. */
export function round4(value) {
  return Math.round(Number(value || 0) * 10000) / 10000;
}

/**
 * What a call SHOULD have been charged, from the same policy the meter implements.
 * `expected` is null when the row is exempt (nothing should have been charged).
 *
 * `flat` is the flat-rate call — an own-key call OR a model on creditPolicy.js's FLAT_RATE_MODELS;
 * callers should decide that with `isFlatRateCall()` so the rule has one home. `ownKey` is kept as
 * the older name for the own-key half of it, so a caller that has not been updated still means what
 * it always meant rather than silently token-pricing a flat call.
 */
export function expectedCharge({ inputTokens, outputTokens, inputPerM, outputPerM, markup, ownKey, flat }) {
  if (flat || ownKey) return round4(FLAT_CALL_CREDITS); // the flat rule — see lib/creditPolicy.js
  const usd = (Number(inputTokens || 0) * inputPerM + Number(outputTokens || 0) * outputPerM) / 1_000_000;
  const credits = (usd * markup) / 0.005;
  return round4(credits);
}

/** One charged row, judged. A gap of half a hundredth of a credit is float noise, not a discrepancy. */
export function checkChargeRow({ creditsCharged, inputTokens, outputTokens, inputPerM, outputPerM, markup, ownKey, flat }) {
  const expected = expectedCharge({ inputTokens, outputTokens, inputPerM, outputPerM, markup, ownKey, flat });
  const gap = round4(Number(creditsCharged || 0) - expected);
  return { ok: Math.abs(gap) < 0.005, expected, gap };
}

/** `balance == signup + purchases − charged`, before any explanation. */
export function impliedBalance({ purchased = 0, charged = 0 }) {
  return round4(SIGNUP_CREDITS + Number(purchased || 0) - Number(charged || 0));
}

/**
 * Why a balance does not equal its implied value. Three outcomes, and the difference matters:
 *   balanced  — they agree.
 *   absorbed  — the account ran out, the remainder was absorbed rather than taken below zero. This is
 *               the DOCUMENTED behaviour of reconcileCredits, so it is not a defect; the amount is the
 *               platform's exposure, and it should be reported as a cost, not as drift.
 *   drift     — anything else, which nothing in the design explains.
 */
export function classifyBalance({ balance, implied }) {
  const b = round4(balance);
  const i = round4(implied);
  if (Math.abs(b - i) < 0.005) return { state: 'balanced', absorbed: 0 };
  if (b === 0 && i < 0) return { state: 'absorbed', absorbed: round4(-i) };
  return { state: 'drift', absorbed: 0, delta: round4(i - b) };
}
