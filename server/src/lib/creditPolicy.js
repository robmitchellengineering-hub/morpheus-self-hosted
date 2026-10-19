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
// Both halves of that are settled, and the second one landed the same day (`#418`):
//   * own-key calls are METERED — charging continues for every non-exempt call, whatever
//     key it used; and
//   * the RATE is FLAT — `FLAT_CALL_CREDITS` below, applied by `isFlatRateCall()`.
// This block called the rate "OPEN … nothing is implemented" for a day AFTER the flat charge
// shipped, which is the same doc-drift this codebase keeps producing.
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
 * What a FLAT-RATED call costs the operator, in credits. DECIDED — ROB, 2026-09-28.
 *
 * The inference is either theirs (their key, their provider bill) or, for a model on
 * `FLAT_RATE_MODELS`, not something we price per token; what remains in both cases is our plumbing
 * — a few seconds of container CPU, ~440KB of egress and one database row, measured at roughly
 * $0.0002–0.001 a call. One credit ($0.005) covers that 5–25× over while still being ~16× cheaper
 * than a platform-key call (~16.3 credits), and at the volume measured in production it covers the
 * whole hosting floor: 4,637 calls/month recovers ~$23 against a ~$10 monthly floor.
 *
 * It is deliberately FLAT and not token-priced: a per-token rate for a call we treat as plumbing
 * would look more proportional and be less explicable, for a difference of fractions of a cent.
 *
 * This is the "extremely cheep" Rob asked for, and it is NOT free — a complete free path cannot be
 * covered at current prices, which is why the product's own intent line was changed from "a genuinely
 * free path" to "a genuinely cheap path" in the same change. See scripts/verify-ai-cost-claims.mjs,
 * which fails the build if any customer-facing copy claims otherwise.
 */
export const FLAT_CALL_CREDITS = 1;

/**
 * The own-key name for the same number. Nothing in the product reads it any more — the call sites
 * moved to `FLAT_CALL_CREDITS` when the flat rule stopped being only about keys — but it is kept
 * exported (and asserted equal to the value above) so a stale import cannot silently become
 * `undefined` and charge zero.
 */
export const OWN_KEY_CALL_CREDITS = FLAT_CALL_CREDITS;

/**
 * Models billed FLAT — one credit a turn, whatever key served them — because the flat rule is about
 * what a call costs US, not about who is holding the key.
 *
 * DECIDED — ROB, 2026-09-28: "Make the gemini rate 1 credit per turn just like the other byo."
 *
 * WHY IT CAME UP, measured in production rather than assumed: `gemini-3.5-flash-lite` is not in the
 * static pricing table, so its 99 calls (2026-08-31 → 09-01, ALL on the platform key) were priced
 * from `DEFAULT_PRICING` {in 1, out 5} and charged ~609 credits — 603.77 of them to one non-exempt
 * user — against a recorded cost basis of $1.94. A price nobody chose was applied to a model nobody
 * had priced. That is exactly the gap `scripts/reality.mjs` and the billing-ledger check exist to
 * flag, and the fix Rob chose is the own-key treatment applied by MODEL instead of by key.
 *
 * Adding another model here is a one-line decision, deliberately: a flat rate is a pricing choice,
 * and a broad family match (`/gemini/`) would silently flat-rate a paid sibling later.
 */
export const FLAT_RATE_MODELS = new Set(['gemini-3.5-flash-lite']);

/**
 * The date the flat-MODEL rule took effect. Rows charged BEFORE it are history: they were charged
 * under the old token-priced rule and are REPORTED by the ledger check, never failed — money already
 * taken from a user is not rewritten by a later price change. Same reasoning as the 2026-09-01
 * admin-role row handled in `scripts/verify-billing-ledger.mjs`.
 */
export const FLAT_RATE_SINCE = '2026-09-28';

/** Is this AI call running on the operator's own provider key (ai.js tier 1) rather than ours? */
export function isOwnKeyProvider(provider) {
  return String(provider || '') === 'custom';
}

/**
 * Model ids are spelled inconsistently across this codebase: the table in `costEstimate.js` carries
 * `gemini_3_flash` and `gemini_3_1_pro` (DOTS and hyphens both flattened to underscores, so those two
 * match no real id) while production records `gemini-3.5-flash-lite`. Stripping every separator from
 * both sides is the only comparison that folds those spellings together without guessing which
 * separator was meant — a first version that only swapped `_` for `-` failed its own guard on
 * `gemini_3_5_flash_lite`, which is exactly the kind of near-miss a flat-rate set must not have.
 */
function canonicalModelId(model) {
  return String(model || '').trim().toLowerCase().replace(/[_.\-\s]/g, '');
}

/**
 * Does this call bill FLAT — one credit, not priced by its tokens?
 *
 * True in two cases, and they are the same case economically: the inference was not ours to price.
 *   * an own-key call (`provider: 'custom'`) — the user's key paid the provider; or
 *   * a flat-rate MODEL (`FLAT_RATE_MODELS`, e.g. gemini-3.5-flash-lite) — see that set for why.
 *
 * Takes an object rather than two arguments so a call site cannot pass them in the wrong order.
 */
export function isFlatRateCall({ provider, model } = {}) {
  if (isOwnKeyProvider(provider)) return true;
  const id = canonicalModelId(model);
  if (!id) return false;
  for (const flat of FLAT_RATE_MODELS) if (canonicalModelId(flat) === id) return true;
  return false;
}
