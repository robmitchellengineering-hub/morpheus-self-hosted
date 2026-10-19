import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { stripeFetch, encodeForm } from '../../shared/stripeUtils.ts';

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json();
    const { templateId, buyerId, buyerEmail, successUrl, cancelUrl } = body;
    if (!templateId) return Response.json({ error: 'templateId required' }, { status: 400 });
    if (!successUrl || !cancelUrl) return Response.json({ error: 'successUrl and cancelUrl required' }, { status: 400 });
    // buyerId is optional — anonymous public buyers can purchase without an account.

    const template = await base44.entities.Template.get(templateId);
    if (!template) return Response.json({ error: 'Template not found' }, { status: 404 });
    if (!template.price || template.price <= 0) return Response.json({ error: 'Template is free' }, { status: 400 });
    if (!template.stripe_price_id) return Response.json({ error: 'Template not configured for payment' }, { status: 400 });

    const appId = Deno.env.get("BASE44_APP_ID") || '';

    // Self-healing: if the stored Stripe price ID has been deleted or points
    // to another account, regenerate it from the template's stored price so
    // the buyer isn't blocked by a stale reference.
    const ensurePriceId = async (): Promise<string> => {
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
          metadata: { base44_app_id: appId, template_id: templateId }
        })
      });
      const priceObj = await stripeFetch('/prices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: encodeForm({
          product: product.id,
          unit_amount: Math.round(template.price * 100),
          currency: 'usd',
          metadata: { base44_app_id: appId, template_id: templateId }
        })
      });
      await base44.entities.Template.update(templateId, { stripe_price_id: priceObj.id });
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
          client_reference_id: buyerId || undefined,
          customer_email: buyerEmail || undefined,
          metadata: {
            base44_app_id: appId,
            template_id: templateId,
            buyer_id: buyerId || 'anonymous',
            seller_id: template.author_id || '',
            template_name: template.name,
            amount: template.price
          }
        })
      });
    } catch (e) {
      const msg = e.message || String(e);
      // Translate the raw Stripe minimum-amount error into a clear message
      // so the buyer knows the template is mispriced, not that checkout broke.
      if (/must convert to at least/i.test(msg)) {
        return Response.json({ error: 'This template is priced below Stripe\'s minimum checkout amount. Please contact the seller to adjust the price.' }, { status: 400 });
      }
      throw e;
    }

    return Response.json({ url: session.url });
  } catch (error) {
    console.error('createTemplateCheckout error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}