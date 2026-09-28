// Token System Build Plan Step 3 (2026-09-01) — pre-call reserve + reconcile
// billing enforcement. See TOKEN-SYSTEM-BUILD-PLAN.md Step 3 for the design
// this implements, and the decisions locked in this session:
//   - Credit rate: $5 per 1,000 credits -> 1 credit = $0.005 retail.
//   - Precision: credit_balance/credits_charged/CreditTransaction.credits are
//     all Decimal(14,4) -- a fraction-of-a-cent chat turn must not round to
//     a free call.
//   - Insufficient balance at the pre-call check: hard block only, no
//     overdraft grace. reconcileCredits() (post-call) never re-blocks --
//     by the time it runs the call already happened and was already billed
//     for by the pre-call reservation.
import { prisma } from '../db.js';
import { getModelRate, computeCostUsd } from './modelPricing.js';
import { splitOvershoot } from './billingClamp.js';

// Re-exported so existing importers keep working. The logic lives in
// billingClamp.js, which imports nothing at all, so the no-install CI guard can
// assert its invariant without dragging in the Prisma client — importing it
// from this file instead is what took the guards job down on 2026-09-19
// (ERR_MODULE_NOT_FOUND: '@prisma/client', reached via db.js).
export { splitOvershoot };

// Rob's pricing decision, 2026-09-02: for any DeepSeek-served call (this
// platform's paid-tier default), retail bills at a fixed 2x DeepSeek Pro's
// peak-time rate -- regardless of whether Flash or Pro actually served the
// request. This extends the "always assume the worst case" approach already
// used for peak/off-peak time (costEstimate.js's MODEL_PRICING is pinned to
// DeepSeek's peak rate, never off-peak) one step further to the model
// itself: rather than billing a Flash-served call at Flash's own (much
// lower) real cost, every DeepSeek call is billed as if it ran on Pro at
// peak time. Pro's real peak rate is exactly 3x Flash's real peak rate
// (both keep the same 3:1 output:input ratio: $1.32/$0.44 = $3.96/$1.32 =
// 3), so this simply triples the retail price of a Flash-served call versus
// billing it at its own real cost; a call that genuinely runs on Pro at
// peak time is billed exactly what it costs (2x, no extra margin) -- same
// as before this change. Real cost tracking (UsageEvent.cost_usd, DeepSeek
// balance depletion, Admin Panel margin visibility, all computed in
// ai.js's recordUsageEvent from the model that actually served the call)
// is untouched by this -- only the retail/credit-charging basis below
// changed.
function isDeepSeekModel(modelId) {
  return /^deepseek(-|$)/i.test(String(modelId || ''));
}

// $/M-token rate RETAIL billing should use for a given served model --
// DeepSeek Pro's peak rate (admin-overridable via its own ModelCatalogEntry
// row, so there's still exactly one place to correct it) for any DeepSeek
// model, or the served model's own real rate for everything else
// (unchanged prior behavior -- this only touches DeepSeek billing).
async function resolveBillingRate(model) {
  if (isDeepSeekModel(model)) return getModelRate('deepseek-v4-pro');
  return getModelRate(model);
}

// Markup RETAIL billing should use -- DeepSeek Pro's own markup setting for
// any DeepSeek model (so Flash- and Pro-served calls always share one
// billing policy), or the served model's own markup for everything else.
async function resolveBillingMarkup(model) {
  return getModelMarkup(isDeepSeekModel(model) ? 'deepseek-v4-pro' : model);
}

export const CREDIT_RATE_USD = 0.005; // $5 / 1,000 credits, decided 2026-09-01

// Pre-call estimates are deliberately biased high: reconciliation should
// usually refund a small amount back to the user, never surprise them with
// a large true-up charge after the fact (TOKEN-SYSTEM-BUILD-PLAN.md Step 3's
// "cap the overshoot risk with a conservative estimate multiplier").
const ESTIMATE_SAFETY_MULTIPLIER = 1.4;
const CHARS_PER_TOKEN = 4; // rough, standard heuristic for a pre-call estimate only

// Per-role *output* token expectations, and the rule that decides which number
// a reservation uses. Both live in billingEstimate.js — a module with no imports
// — so a guard can assert the rule as behaviour without reaching the Prisma
// client through this file. See its header for why that matters and what the
// rule was getting wrong.
export { ROLE_OUTPUT_ESTIMATE, DEFAULT_OUTPUT_ESTIMATE, estimateOutputTokens } from './billingEstimate.js';
import { estimateOutputTokens } from './billingEstimate.js';

// Token-block purchase denominations. Revised 2026-09-02: round $2/$4/$8
// blocks (was $1.87/$5/$10, a Step 3 placeholder) -- picked to sit close to
// $8 retail per 1M tokens at the default 2.0x markup against DeepSeek's
// real ~$4/M peak-time cost (Step 6b's provider). Credits = intendedNetUsd /
// CREDIT_RATE_USD; stripeChargeUsd = computeGrossedUpCharge(intendedNetUsd),
// both verified numerically (server/src/lib/billing.js's own formula run
// through Python, not hand-computed) before shipping real Stripe prices:
//   $2.00 -> 400 credits  -> $2.37 charged
//   $4.00 -> 800 credits  -> $4.43 charged
//   $8.00 -> 1600 credits -> $8.55 charged
// src/components/matrix/CreditBalance.jsx mirrors this array for display —
// keep both in sync; the array *index* is what the client sends to
// createTokenCheckout.js, which looks the real price up here, server-side.
export const TOKEN_BLOCKS = [
  { intendedNetUsd: 2.00, credits: 400, stripeChargeUsd: 2.37 },
  { intendedNetUsd: 4.00, credits: 800, stripeChargeUsd: 4.43 },
  { intendedNetUsd: 8.00, credits: 1600, stripeChargeUsd: 8.55 },
];

// Step 6 (2026-09-01, server/src/functions/createTokenCheckout.js) — the
// Stripe fee gross-up formula itself, factored out so the first-purchase
// surcharge below can apply it to a different intended-net value than the
// ones baked into TOKEN_BLOCKS.stripeChargeUsd above. charge = (net + $0.30)
// / (1 - 2.9%), Stripe's standard US card rate; rounded to the cent.
export function computeGrossedUpCharge(intendedNetUsd) {
  return Math.round(((intendedNetUsd + 0.30) / (1 - 0.029)) * 100) / 100;
}

// A new account's 200 free signup credits are worth $1.00 retail at the
// decided $5/1,000 rate (200 * $0.005). TOKEN-SYSTEM-BUILD-PLAN.md's Step 6
// design recoups that giveaway on the buyer's FIRST real purchase only, by
// adding it to the block's intended-net value before the fee gross-up —
// e.g. the $4 block's first purchase becomes a $5.00-intended-net charge
// ($5.46) instead of the standard $4.43. Every purchase after the first is
// standard pricing (TOKEN_BLOCKS.stripeChargeUsd, unchanged).
export const FIRST_PURCHASE_RECOUP_USD = 1.00;

// True if this account has never completed a paid token purchase before —
// createTokenCheckout.js uses this to decide whether the recoup surcharge
// above applies to the checkout session it's about to create.
export async function isFirstTokenPurchase(userId) {
  const prior = await prisma.creditTransaction.findFirst({
    where: { created_by_id: userId, status: 'paid' },
    select: { id: true },
  });
  return !prior;
}

export class InsufficientCreditsError extends Error {
  constructor(needed, available) {
    super(`Insufficient credits: this action needs ~${needed.toFixed(2)}, account has ${available.toFixed(2)}. Buy more credits in Settings.`);
    this.name = 'InsufficientCreditsError';
    this.status = 402;
    // Stable machine-readable code (2026-09-02), forwarded by
    // functions.routes.js's error handler alongside needed/available so the
    // frontend can reliably detect "out of credits" and pop up the buy-more
    // modal (src/components/matrix/InsufficientCreditsModal.jsx) instead of
    // just showing error text — checking `code` rather than `status === 402`
    // keeps this working even if some other error path ever reuses 402 for
    // something unrelated.
    this.code = 'INSUFFICIENT_CREDITS';
    this.needed = needed;
    this.available = available;
  }
}

// Underlying-cost -> retail-credits conversion, applying the model's markup
// (admin-editable via ModelCatalogEntry, defaults to 2.0x) then the flat
// credit rate.
function usdToCredits(costUsd, markup) {
  return (costUsd * (markup ?? 2.0)) / CREDIT_RATE_USD;
}

async function getModelMarkup(modelId) {
  try {
    const entry = await prisma.modelCatalogEntry.findUnique({ where: { model_id: modelId } });
    if (entry?.active && entry.markup_multiplier != null) return entry.markup_multiplier;
  } catch {
    // ModelCatalogEntry may not exist yet on an older/unmigrated DB -- fall
    // through to the default rather than breaking billing over a lookup.
  }
  return 2.0;
}

// Pre-call estimate, in *credits* (retail, markup already applied) -- what
// reserveCredits() below will attempt to deduct before the AI call runs.
// Uses the RETAIL rate/markup (resolveBillingRate/resolveBillingMarkup
// above), not necessarily the served model's own real rate -- for a
// DeepSeek call that's Pro's peak rate at 2x, always, so the reservation
// lands close to what reconcileAgainstActualUsage will actually charge
// instead of needing a large top-up at reconcile time.
export async function estimatePreCallCredits(prompt, role, model, maxTokens) {
  const inputTokens = Math.ceil(String(prompt || '').length / CHARS_PER_TOKEN);
  const outputTokens = estimateOutputTokens(role, maxTokens);
  const rate = await resolveBillingRate(model);
  const estimatedUsd = computeCostUsd(inputTokens, outputTokens, rate) * ESTIMATE_SAFETY_MULTIPLIER;
  const markup = await resolveBillingMarkup(model);
  return usdToCredits(estimatedUsd, markup);
}

// Atomically deducts `estimatedCredits` from the user's balance, but only if
// the balance covers it -- a single conditional SQL UPDATE (via Prisma's
// updateMany + a `gte` filter in the WHERE clause), so two concurrent calls
// from the same account can't both pass a balance check that only one of
// them should. Throws InsufficientCreditsError (status 402) if it can't.
//
// Whether a call should reserve AT ALL is a separate rule and lives in
// lib/creditPolicy.js — import-free, so a guard can test it without dragging
// Prisma into the no-install job.
export async function reserveCredits(userId, estimatedCredits) {
  const result = await prisma.user.updateMany({
    where: { id: userId, credit_balance: { gte: estimatedCredits } },
    data: { credit_balance: { decrement: estimatedCredits } },
  });
  if (result.count === 0) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { credit_balance: true } });
    throw new InsufficientCreditsError(estimatedCredits, Number(user?.credit_balance ?? 0));
  }
}

// Post-call true-up: refunds the difference if the pre-call estimate overshot
// (the common case, by design, since the estimate carries a 1.4x safety
// multiplier), or takes the small remainder if it undershot.
//
// Never throws / never re-blocks -- the call already happened and was paid for
// by the reservation; this only corrects the amount. But it also never takes
// the balance below zero: if the account cannot cover the shortfall, the
// remainder is absorbed as a platform cost and logged, because an honest meter
// cannot meter what isn't there. The exposure is one partial call per
// exhaustion, and the next call is hard-blocked anyway.
export async function reconcileCredits(userId, reservedCredits, actualCredits) {
  const diff = reservedCredits - actualCredits; // positive = refund back to the user
  if (Math.abs(diff) < 1e-9) return { refunded: 0, absorbed: 0 };

  if (diff > 0) {
    await prisma.user.update({
      where: { id: userId },
      data: { credit_balance: { increment: diff } },
    });
    return { refunded: diff, absorbed: 0 };
  }

  const owed = -diff;
  // Atomic conditional take: succeeds only if the balance genuinely covers it,
  // so concurrent calls cannot both pass a check only one should.
  const taken = await prisma.user.updateMany({
    where: { id: userId, credit_balance: { gte: owed } },
    data: { credit_balance: { decrement: owed } },
  });
  if (taken.count === 1) return { refunded: 0, absorbed: 0 };

  // Short. Zero the balance (guarded, so a concurrent top-up is never wiped)
  // and absorb the remainder rather than carrying a negative balance.
  const before = Number(
    (await prisma.user.findUnique({ where: { id: userId }, select: { credit_balance: true } }))?.credit_balance ?? 0,
  );
  await prisma.$executeRawUnsafe(
    'UPDATE users SET credit_balance = 0 WHERE id = $1 AND credit_balance < $2::numeric',
    userId,
    owed,
  );
  const { absorb } = splitOvershoot(owed, before);
  if (absorb > 0) {
    console.warn(
      `[billing] absorbed ${absorb.toFixed(4)} credits ($${(absorb * CREDIT_RATE_USD).toFixed(4)}) for ${userId}: `
      + 'the call exceeded its reservation and the balance could not cover the difference. '
      + 'Balance clamped at 0 rather than going negative.',
    );
  }
  return { refunded: 0, absorbed: absorb };
}

// Convenience wrapper combining the actual-tokens -> retail-credits
// conversion with the reconcile step, so ai.js's recordUsageEvent() doesn't
// need to know about rate/markup lookups directly. Takes real token counts
// (not a pre-computed cost_usd) because the RETAIL basis is no longer
// necessarily the served model's own cost -- for a DeepSeek call this
// re-prices the actual tokens at Pro's peak rate (resolveBillingRate above),
// regardless of whether Flash or Pro actually served the request. The
// model's own real cost is still computed and logged separately by the
// caller (UsageEvent.cost_usd) for accurate margin/balance tracking; this
// function only decides what the *user* is charged.
export async function reconcileAgainstActualUsage(userId, model, reservedCredits, inputTokens, outputTokens) {
  const rate = await resolveBillingRate(model);
  const markup = await resolveBillingMarkup(model);
  const billedCostUsd = computeCostUsd(inputTokens, outputTokens, rate);
  const actualCredits = usdToCredits(billedCostUsd, markup);
  await reconcileCredits(userId, reservedCredits, actualCredits);
  return actualCredits;
}
