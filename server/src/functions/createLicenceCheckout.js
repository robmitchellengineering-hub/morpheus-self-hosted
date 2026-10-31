// createLicenceCheckout.js — buy a seat of the Valiant SDK, monthly.
//
// WHY THIS EXISTS. There was no way for anyone to buy a licence: no checkout, and the webhook ignored the subscription events that would
// have minted one. This creates the subscription that produces `invoice.paid` every month, which is what mints the licence and renews it.
//
// THE PRICE IS OURS TO DECIDE, NOT THE CALLER'S. The client sends a seat COUNT; the amount comes from the Stripe price configured for this
// deployment. An unset price is a refusal with a sentence, never a default amount — charging a guessed price is worse than not selling.
import { stripeFetch, encodeForm } from '../lib/stripe.js';
import { safeReturnUrl } from '../lib/corsOrigin.js';
import { seatPriceId } from '../lib/licencePurchase.js';

export default async function handler({ user, body, req }) {
  if (!user) throw Object.assign(new Error('Sign in to buy a licence'), { status: 401 });

  const price = seatPriceId();
  if (!price) {
    throw Object.assign(new Error('This deployment has no licence price configured (STRIPE_PRICE_VVS_SEAT), so no licence can be sold'), { status: 503 });
  }

  // Seats are a number the buyer chooses, bounded so a typo cannot start a 10,000-seat subscription. Five seats means five machines and
  // five CI runners — the licence states both, and the SDK enforces the machine count per seat.
  const seats = Math.max(1, Math.min(100, Number.parseInt(body?.seats, 10) || 1));

  const returnBase = (typeof req?.get === 'function' ? req.get('origin') : '') || process.env.FRONTEND_URL || '';
  const safeSuccess = safeReturnUrl(body?.successUrl, '/?licence=success', returnBase);
  const safeCancel = safeReturnUrl(body?.cancelUrl, '/?licence=cancelled', returnBase);

  const session = await stripeFetch('/checkout/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: encodeForm({
      mode: 'subscription',
      'line_items[0][price]': price,
      'line_items[0][quantity]': seats,
      success_url: safeSuccess,
      cancel_url: safeCancel,
      client_reference_id: user.id,
      customer_email: user.email || undefined,
      // The webhook does not need these to mint — `invoice.paid` carries the quantity — but they make a support question answerable from
      // the checkout session alone, and they mark the session so nothing else in the marketplace mistakes it for a template purchase.
      'metadata[type]': 'vvs_licence',
      'metadata[seats]': String(seats),
      'metadata[user_id]': user.id,
      'subscription_data[metadata][type]': 'vvs_licence',
      'subscription_data[metadata][seats]': String(seats),
    }),
  });

  return { ok: true, url: session.url, id: session.id, seats };
}
