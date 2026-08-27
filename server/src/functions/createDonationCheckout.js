// New — not a base44 port. Backs the landing page's "KEEP MORPHEUS ALIVE"
// donate widget (base44's live version has this; the self-hosted rewrite
// didn't, since prior audits only ever covered the logged-in /workspace app
// and missed the pre-login landing page entirely). PUBLIC function — a
// visitor doesn't need to be signed in to donate, same as base44.
//
// Reuses the marketplace's existing Stripe account/keys (STRIPE_SECRET_KEY,
// STRIPE_WEBHOOK_SECRET) rather than a second account — confirmed decision.
// Unlike createTemplateCheckout, there's no persisted Template/Price to
// reuse: the amount is chosen per-donation (a fixed tier or a custom value),
// so this builds the Stripe line item inline with `price_data` instead of
// looking up a stored price id.
import { stripeFetch, encodeForm } from '../lib/stripe.js';

// Mirrors the $1 NEO tier — the lowest fixed tier on the landing widget —
// and comfortably clears Stripe's $0.50 USD checkout minimum.
const MIN_DONATION_USD = 1;
const MAX_DONATION_USD = 10000; // sanity ceiling against fat-fingered custom amounts

export default async function handler({ body }) {
  const { amount, donorEmail, successUrl, cancelUrl } = body;

  const parsedAmount = Number(amount);
  if (!Number.isFinite(parsedAmount) || parsedAmount < MIN_DONATION_USD || parsedAmount > MAX_DONATION_USD) {
    throw Object.assign(
      new Error(`Donation amount must be between $${MIN_DONATION_USD} and $${MAX_DONATION_USD}`),
      { status: 400 },
    );
  }
  if (!successUrl || !cancelUrl) {
    throw Object.assign(new Error('successUrl and cancelUrl required'), { status: 400 });
  }

  const appId = process.env.BASE44_APP_ID || '';

  const session = await stripeFetch('/checkout/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: encodeForm({
      mode: 'payment',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][product_data][name]': 'Morpheus donation',
      'line_items[0][price_data][product_data][description]': 'Keeps Morpheus alive and free for everyone.',
      'line_items[0][price_data][unit_amount]': Math.round(parsedAmount * 100),
      'line_items[0][quantity]': 1,
      success_url: successUrl,
      cancel_url: cancelUrl,
      customer_email: donorEmail || undefined,
      metadata: {
        base44_app_id: appId,
        type: 'donation',
        amount: parsedAmount,
      },
    }),
  });

  return { url: session.url };
}
