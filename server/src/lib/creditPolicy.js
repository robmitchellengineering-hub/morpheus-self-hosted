// Should an AI call reserve credits from the account that made it?
//
// Extracted from ai.js on 2026-09-28 so the rule has ONE home and can be tested
// without a database. Import-free on purpose: `scripts/verify-ai-cost-claims.mjs`
// runs in CI's no-install guards job, and `lib/billing.js` — where the reservation
// itself lives — imports Prisma, so a guard reaching the rule through it would drag
// a package into the one job that deliberately installs nothing. Same reason
// `deckMemoryText.js` and `onrampChecklist.js` are import-free.
//
// THE RULE TODAY IS ABOUT THE ACCOUNT AND NOTHING ELSE: no user row (no account to
// bill), an admin, or an explicit `billing_exempt` grant are exempt; everyone else
// pays.
//
// THE OPEN QUESTION, VERIFIED 2026-09-28 AND DELIBERATELY UNRESOLVED — DO NOT
// "FIX" IT BY ACCIDENT. This function is never told which AI key the call will use,
// so a user who has set their own provider key in Settings → AI Provider (ai.js
// tier 1, `provider: 'custom'`) is STILL charged credits. The product has described
// that path as costing nothing per call. Both cannot be true. Rob's decision, one of:
//
//   (1) exempt an own-key call — the call costs Morpheus nothing, so metering it
//       charges for a service we did not provide; the change is a `provider`
//       parameter here plus the copy, landed together; or
//   (2) keep charging, and delete the free-path promise wherever it is implied.
//
// Whichever is chosen, `scripts/verify-ai-cost-claims.mjs` is updated in the same
// change: a billing rule that moves without its guard is exactly how a published
// price and the meter drift apart.
export function shouldReserveCredits(billingUser) {
  if (!billingUser) return false; // no account to bill — an absence, not a free pass
  if (String(billingUser.role || '').trim().toLowerCase() === 'admin') return false;
  if (billingUser.billing_exempt === true) return false;
  return true;
}
