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
import { TOKEN_BLOCKS, computeGrossedUpCharge, FIRST_PURCHASE_RECOUP_USD, isFirstTokenPurchase } from '../lib/billing.js';
import { stripeFetch, encodeForm } from '../lib/stripe.js';
import { safeReturnUrl } from '../lib/corsOrigin.js';

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
