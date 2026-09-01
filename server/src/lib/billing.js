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

export const CREDIT_RATE_USD = 0.005; // $5 / 1,000 credits, decided 2026-09-01

// Pre-call estimates are deliberately biased high: reconciliation should
// usually refund a small amount back to the user, never surprise them with
// a large true-up charge after the fact (TOKEN-SYSTEM-BUILD-PLAN.md Step 3's
// "cap the overshoot risk with a conservative estimate multiplier").
const ESTIMATE_SAFETY_MULTIPLIER = 1.4;
const CHARS_PER_TOKEN = 4; // rough, standard heuristic for a pre-call estimate only

// Per-role *output* token expectations, used only to size the pre-call
// estimate -- the real charge always reconciles against actual usage (Step 2's
// real metering) once the call completes, regardless of how this guesses.
const ROLE_OUTPUT_ESTIMATE = { planner: 1500, coder: 3000, reviewer: 1500, diagnosis: 2000 };
const DEFAULT_OUTPUT_ESTIMATE = 1500;

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
export async function estimatePreCallCredits(prompt, role, model) {
  const inputTokens = Math.ceil(String(prompt || '').length / CHARS_PER_TOKEN);
  const outputTokens = ROLE_OUTPUT_ESTIMATE[role] || DEFAULT_OUTPUT_ESTIMATE;
  const rate = await getModelRate(model);
  const estimatedUsd = computeCostUsd(inputTokens, outputTokens, rate) * ESTIMATE_SAFETY_MULTIPLIER;
  const markup = await getModelMarkup(model);
  return usdToCredits(estimatedUsd, markup);
}

// Atomically deducts `estimatedCredits` from the user's balance, but only if
// the balance covers it -- a single conditional SQL UPDATE (via Prisma's
// updateMany + a `gte` filter in the WHERE clause), so two concurrent calls
// from the same account can't both pass a balance check that only one of
// them should. Throws InsufficientCreditsError (status 402) if it can't.
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

// Post-call true-up: refunds the difference if the pre-call estimate
// overshot (the common case, by design), or takes the small remainder if it
// undershot. Never throws / never re-blocks -- the call already happened and
// was already paid for by the reservation; this just corrects the amount.
export async function reconcileCredits(userId, reservedCredits, actualCredits) {
  const diff = reservedCredits - actualCredits; // positive = refund back to the user
  if (Math.abs(diff) < 1e-9) return;
  await prisma.user.update({
    where: { id: userId },
    data: { credit_balance: { increment: diff } },
  });
}

// Convenience wrapper combining the actual-cost -> credits conversion with
// the reconcile step, so ai.js's recordUsageEvent() doesn't need to know
// about markup lookups directly.
export async function reconcileAgainstActualUsage(userId, model, reservedCredits, actualCostUsd) {
  const markup = await getModelMarkup(model);
  const actualCredits = usdToCredits(actualCostUsd, markup);
  await reconcileCredits(userId, reservedCredits, actualCredits);
  return actualCredits;
}
