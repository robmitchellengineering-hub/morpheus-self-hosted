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

/**
 * What an own-key call costs the operator, in credits. DECIDED — ROB, 2026-09-28.
 *
 * The inference is theirs (their key, their provider bill); what remains is our plumbing — a few
 * seconds of container CPU, ~440KB of egress and one database row, measured at roughly
 * $0.0002–0.001 a call. One credit ($0.005) covers that 5–25× over while still being ~16× cheaper
 * than a platform-key call (~16.3 credits), and at the volume measured in production it covers the
 * whole hosting floor: 4,637 calls/month recovers ~$23 against a ~$10 monthly floor.
 *
 * It is deliberately FLAT and not token-priced: a per-token own-key rate would be more proportional
 * and less explicable, for a difference of fractions of a cent per call.
 *
 * This is the "extremely cheep" Rob asked for, and it is NOT free — a complete free path cannot be
 * covered at current prices, which is why the product's own intent line was changed from "a genuinely
 * free path" to "a genuinely cheap path" in the same change. See scripts/verify-ai-cost-claims.mjs,
 * which fails the build if any customer-facing copy claims otherwise.
 */
export const OWN_KEY_CALL_CREDITS = 1;

/** Is this AI call running on the operator's own provider key (ai.js tier 1) rather than ours? */
export function isOwnKeyProvider(provider) {
  return String(provider || '') === 'custom';
}
