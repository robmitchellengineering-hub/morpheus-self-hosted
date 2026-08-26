import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { secrets } from 'base44:runtime';
import { computeSplit } from '../../shared/stripeUtils.ts';

async function verifyStripeSignature(rawBody: string, signature: string, secret: string): Promise<any> {
  const parts = signature.split(',').reduce((acc, p) => {
    const [k, v] = p.split('=');
    if (k && v) acc[k.trim()] = v.trim();
    return acc;
  }, {} as Record<string, string>);

  const timestamp = parts['t'];
  const v1Signature = parts['v1'];
  if (!timestamp || !v1Signature) throw new Error('Invalid signature header');

  const age = Math.floor(Date.now() / 1000) - parseInt(timestamp);
  if (age > 300 || age < -300) throw new Error('Signature timestamp out of range');

  const signedPayload = `${timestamp}.${rawBody}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(signedPayload));
  const computed = Array.from(new Uint8Array(sigBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

  if (computed !== v1Signature) throw new Error('Invalid signature');
  return JSON.parse(rawBody);
}

export default async function(req: Request): Promise<Response> {
  try {
    const webhookSecret = secrets.get("STRIPE_WEBHOOK_SECRET");
    if (!webhookSecret) {
      console.error('STRIPE_WEBHOOK_SECRET not configured');
      return Response.json({ error: 'Webhook secret not configured' }, { status: 500 });
    }

    const signature = req.headers.get('stripe-signature') || '';
    const rawBody = await req.text();

    let event;
    try {
      event = await verifyStripeSignature(rawBody, signature, webhookSecret);
    } catch (e) {
      console.error('Signature verification failed:', e.message);
      return Response.json({ error: 'Invalid signature' }, { status: 400 });
    }

    if (event.type !== 'checkout.session.completed') {
      return Response.json({ received: true, ignored: event.type });
    }

    const session = event.data?.object || {};
    const metadata = session.metadata || {};
    const templateId = metadata.template_id;
    const buyerId = metadata.buyer_id || session.client_reference_id;
    const sellerId = metadata.seller_id || '';
    const templateName = metadata.template_name || '';

    if (!templateId || !buyerId) {
      console.error('Webhook missing template_id or buyer_id in metadata', metadata);
      return Response.json({ error: 'Missing metadata' }, { status: 400 });
    }

    const amount = (session.amount_total || 0) / 100;
    const { platformCut, sellerCut } = computeSplit(amount);

    const base44 = createClientFromRequest(req);

    // Idempotency: skip if this session was already recorded
    const existing = await base44.asServiceRole.entities.Purchase.filter({ stripe_session_id: session.id });
    if (existing.length === 0) {
      await base44.asServiceRole.entities.Purchase.create({
        template_id: templateId,
        template_name: templateName,
        buyer_id: buyerId,
        buyer_email: session.customer_details?.email || session.customer_email || '',
        seller_id: sellerId,
        amount,
        platform_cut: platformCut,
        seller_cut: sellerCut,
        stripe_session_id: session.id,
        status: 'paid'
      });
      console.log(`Purchase recorded: template=${templateId} buyer=${buyerId} amount=${amount} platform=${platformCut} seller=${sellerCut}`);
    }

    return Response.json({ received: true });
  } catch (error) {
    console.error('stripeWebhook error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}