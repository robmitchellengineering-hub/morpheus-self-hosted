// createBillingPortal — let a Valiant Verification subscriber manage their own
// subscription: add/remove developer seats, change payment method, cancel.
// PUBLIC: a client manages their own billing, not a signed-in Morpheus user.
//
// The seat count IS the subscription's line-item quantity (the checkout sets
// line_items[0][quantity] = seats), so the Stripe Customer Portal's
// "update quantity" control is the head-count control. No second system.
//
// Accepts either a checkout session id (what the success URL carries) or a
// Stripe customer id, resolves the customer, and returns a portal session URL.
import { stripeFetch, encodeForm } from '../lib/stripe.js';

export default async function handler({ body }) {
  const { sessionId, customerId, returnUrl } = body || {};

  let customer = customerId;
  if (!customer && sessionId) {
    if (typeof sessionId !== 'string' || !sessionId.startsWith('cs_')) {
      throw Object.assign(new Error('invalid sessionId'), { status: 400 });
    }
    const session = await stripeFetch(`/checkout/sessions/${encodeURIComponent(sessionId)}`);
    customer = session.customer;
  }
  if (!customer) {
    throw Object.assign(new Error('sessionId or customerId required'), { status: 400 });
  }

  const portal = await stripeFetch('/billing_portal/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: encodeForm({
      customer,
      return_url: returnUrl || undefined,
    }),
  });

  return { url: portal.url };
}
