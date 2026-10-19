// Ported from base44/functions/createTemplateCheckout/entry.ts.
// Server-side Stripe Checkout session creation for a paid template.
import { prisma } from '../db.js';
import { stripeFetch, encodeForm } from '../lib/stripe.js';

export default async function handler({ user, body }) {
  const { templateId, buyerEmail, successUrl, cancelUrl } = body;
  if (!templateId) throw Object.assign(new Error('templateId required'), { status: 400 });
  if (!successUrl || !cancelUrl) throw Object.assign(new Error('successUrl and cancelUrl required'), { status: 400 });
  // Unlike the original (anonymous public buyers could purchase without an
  // account), this deployment requires a logged-in buyer — confirmed
  // decision, not an oversight (better fraud/support/refund handling at
  // scale). This route isn't in PUBLIC_FUNCTIONS so auth is already
  // enforced before reaching here; take the buyer id from the verified
  // session rather than trusting a client-supplied value, so it can never
  // be spoofed or come back empty/'anonymous'.
  if (!user) throw Object.assign(new Error('Sign in to purchase a template'), { status: 401 });
  const buyerId = user.id;

  const template = await prisma.template.findUnique({ where: { id: templateId } });
  if (!template) throw Object.assign(new Error('Template not found'), { status: 404 });
  if (!template.price || template.price <= 0) throw Object.assign(new Error('Template is free'), { status: 400 });
  if (!template.stripe_price_id) throw Object.assign(new Error('Template not configured for payment'), { status: 400 });

  const appId = process.env.BASE44_APP_ID || '';

  // Self-healing: if the stored Stripe price ID has been deleted or points
  // to another account, regenerate it from the template's stored price so
  // the buyer isn't blocked by a stale reference.
  const ensurePriceId = async () => {
    if (template.stripe_price_id) {
      try {
        await stripeFetch(`/prices/${template.stripe_price_id}`);
        return template.stripe_price_id;
      } catch (e) {
        console.warn(`createTemplateCheckout: stored price '${template.stripe_price_id}' invalid, regenerating — ${e.message}`);
      }
    }
    const product = await stripeFetch('/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: encodeForm({
        name: template.name,
        description: (template.description || '').substring(0, 350) || undefined,
        metadata: { base44_app_id: appId, template_id: templateId },
      }),
    });
    const priceObj = await stripeFetch('/prices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: encodeForm({
        product: product.id,
        unit_amount: Math.round(template.price * 100),
        currency: 'usd',
        metadata: { base44_app_id: appId, template_id: templateId },
      }),
    });
    await prisma.template.update({ where: { id: templateId }, data: { stripe_price_id: priceObj.id } });
    return priceObj.id;
  };

  const priceId = await ensurePriceId();

  let session;
  try {
    session = await stripeFetch('/checkout/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: encodeForm({
        mode: 'payment',
        'line_items[0][price]': priceId,
        'line_items[0][quantity]': 1,
        success_url: successUrl,
        cancel_url: cancelUrl,
        client_reference_id: buyerId,
        customer_email: buyerEmail || user.email || undefined,
        metadata: {
          base44_app_id: appId,
          template_id: templateId,
          buyer_id: buyerId,
          seller_id: template.author_id || '',
          template_name: template.name,
          amount: template.price,
        },
      }),
    });
  } catch (e) {
    const msg = e.message || String(e);
    // Translate the raw Stripe minimum-amount error into a clear message
    // so the buyer knows the template is mispriced, not that checkout broke.
    if (/must convert to at least/i.test(msg)) {
      throw Object.assign(
        new Error("This template is priced below Stripe's minimum checkout amount. Please contact the seller to adjust the price."),
        { status: 400 },
      );
    }
    throw e;
  }

  return { url: session.url };
}
