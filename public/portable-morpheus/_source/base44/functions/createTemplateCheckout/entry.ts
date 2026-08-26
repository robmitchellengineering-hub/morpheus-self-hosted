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
    const session = await stripeFetch('/checkout/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: encodeForm({
        mode: 'payment',
        'line_items[0][price]': template.stripe_price_id,
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

    return Response.json({ url: session.url });
  } catch (error) {
    console.error('createTemplateCheckout error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}