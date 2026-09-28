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
// DECIDED — ROB, 2026-09-28. THE OWN-KEY "FREE PATH" IS CLOSED, AND NO FREE AI PATH
// IS COMING. Verified the same day: this function is never told which AI key the call
// will use, so a user who has set their own provider key in Settings → AI Provider
// (ai.js tier 1, `provider: 'custom'`) is STILL charged credits — and that is now the
// intended behaviour, not an oversight. Rob's words: "The own ai models need to be
// charged at a rate that covers internal costs i dont think we can do a true complete
// free path at the moment as costs still need to be covered but we can make that
// extremely cheep."
//
// So there are two separate things, and only the first is settled:
//   * SETTLED — own-key calls are metered. Charging continues for every non-exempt
//     call, whatever key it used. Nothing in this file changes.
//   * OPEN — the RATE for an own-key call should be extremely cheap (near what it
//     costs us) rather than the standard markup. The rate is NOT decided, so nothing
//     is implemented: a cheaper rate for `provider: 'custom'` is a billing change
//     that lands with its own guard update, in this file and
//     `scripts/verify-ai-cost-claims.mjs` together.
//
// WHAT MUST NOT HAPPEN IN THE MEANTIME: any copy — settings, capabilities JSON,
// onboarding, an app's README — that promises a free AI path. There is no free path,
// and `scripts/verify-ai-cost-claims.mjs` fails the build if one is written.
export function shouldReserveCredits(billingUser) {
  if (!billingUser) return false; // no account to bill — an absence, not a free pass
  if (String(billingUser.role || '').trim().toLowerCase() === 'admin') return false;
  if (billingUser.billing_exempt === true) return false;
  return true;
}
