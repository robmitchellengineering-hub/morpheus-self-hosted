// Token System Build Plan Step 6 (2026-09-01) — Stripe Checkout session
// creation for a token-block purchase. Follows the same pattern as
// createDonationCheckout.js/createTemplateCheckout.js (price_data built
// inline, since these are fixed denominations with no persisted Stripe
// Price id) and reuses the marketplace's existing Stripe account/keys.
//
// Authenticated (not in functions.routes.js's PUBLIC_FUNCTIONS) — a
// purchase must be tied to a real logged-in account so the webhook knows
// whose credit_balance to credit. The block and its price are looked up
// server-side from lib/billing.js's TOKEN_BLOCKS by index; the client only
// ever sends *which* block it wants, never an amount — so a tampered
// request can't buy credits below the real price.
import { TOKEN_BLOCKS, computeGrossedUpCharge, FIRST_PURCHASE_RECOUP_USD, isFirstTokenPurchase, applyExpiredPurchasedCredits } from '../lib/billing.js';
import { stripeFetch, encodeForm } from '../lib/stripe.js';
import { safeReturnUrl } from '../lib/corsOrigin.js';
import { prisma } from '../db.js';
import { creditBalanceCap, wouldExceedBalanceCap } from '../lib/creditPolicy.js';

export default async function handler({ user, body, req }) {
  if (!user) throw Object.assign(new Error('Sign in to buy credits'), { status: 401 });

  const { blockIndex, successUrl, cancelUrl } = body;
  const block = TOKEN_BLOCKS[blockIndex];
  if (!block) throw Object.assign(new Error('Invalid token block'), { status: 400 });

  // WHERE THE BUYER LANDS IS OURS TO DECIDE, NOT THE CALLER'S (2026-09-23).
  //
  // These two used to travel from the request body straight into Stripe, so the
  // post-payment redirect was caller-controlled: an open redirect on a payment
  // flow. The price was never at risk — the block is looked up server-side by
  // index — but this is not something to leave in a path a widget token can
  // reach, so both now have to be on the origin the request came from.
  //
  // `req.get('origin')` is already validated: the CORS middleware refuses an
  // origin that is not allowed before any handler runs. A non-browser caller
  // (no Origin) falls back to the configured frontend.
  const returnBase = (typeof req?.get === 'function' ? req.get('origin') : '') || process.env.FRONTEND_URL || '';
  const safeSuccess = safeReturnUrl(successUrl, '/?credits=success', returnBase);
  const safeCancel = safeReturnUrl(cancelUrl, '/?credits=cancelled', returnBase);

  // Expiry is applied before the cap so the cap judges the balance the customer
  // actually has, and before the Stripe session so nobody pays for credits the
  // policy would refuse. Gated on CREDITS_EXPIRY_MONTHS: unset = a no-op.
  await applyExpiredPurchasedCredits(user.id);

  // Balance cap, enforced at purchase creation (docs/CREDITS-POLICY.md §6).
  // A paid purchase that races an existing checkout is honoured by the webhook
  // rather than confiscated — this is the gate the customer sees, not a clawback.
  const cap = creditBalanceCap();
  if (cap != null) {
    const account = await prisma.user.findUnique({ where: { id: user.id }, select: { credit_balance: true } });
    // Fail closed: a cap that is configured but cannot be judged must refuse the
    // purchase, never fall back to "no balance, no problem".
    if (!account) {
      throw Object.assign(new Error('Your account could not be read, so the purchase was refused rather than allowed past the balance cap.'), {
        status: 409,
        code: 'CREDIT_BALANCE_CAP',
        cap,
        credits: block.credits,
      });
    }
    const rawBalance = account.credit_balance;
    const balance = Number(rawBalance);
    // A null column is not a zero balance. Refuse rather than let an unreadable
    // account slip past the cap.
    if (rawBalance == null || !Number.isFinite(balance)) {
      throw Object.assign(
        new Error('Your credit balance could not be read, so the purchase was refused rather than allowed past the balance cap.'),
        { status: 409, code: 'CREDIT_BALANCE_CAP', cap, credits: block.credits },
      );
    }
    if (wouldExceedBalanceCap(balance, block.credits, cap)) {
      const next = Math.round((balance + block.credits) * 10000) / 10000;
      throw Object.assign(
        new Error(`This purchase would take your balance to ${next} credits, over the ${cap}-credit account cap. Contact support to raise the cap.`),
        { status: 409, code: 'CREDIT_BALANCE_CAP', cap, balance, credits: block.credits },
      );
    }
  }

  const isFirstPurchase = await isFirstTokenPurchase(user.id);
  const intendedNetUsd = isFirstPurchase ? block.intendedNetUsd + FIRST_PURCHASE_RECOUP_USD : block.intendedNetUsd;
  const chargeUsd = isFirstPurchase ? computeGrossedUpCharge(intendedNetUsd) : block.stripeChargeUsd;

  const appId = process.env.BASE44_APP_ID || '';

  const session = await stripeFetch('/checkout/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: encodeForm({
      mode: 'payment',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][product_data][name]': `${block.credits.toLocaleString()} Morpheus Credits`,
      'line_items[0][price_data][product_data][description]': isFirstPurchase
        ? 'Includes a one-time recoup of your 200 free signup credits.'
        : 'Pay-as-you-go credits for Morpheus AI actions.',
      'line_items[0][price_data][unit_amount]': Math.round(chargeUsd * 100),
      'line_items[0][quantity]': 1,
      success_url: safeSuccess,
      cancel_url: safeCancel,
      client_reference_id: user.id,
      customer_email: user.email || undefined,
      metadata: {
        base44_app_id: appId,
        type: 'token_purchase',
        user_id: user.id,
        credits: block.credits,
        intended_net_usd: intendedNetUsd,
        is_first_purchase: isFirstPurchase ? 'true' : 'false',
      },
    }),
  });

  return { url: session.url };
}
