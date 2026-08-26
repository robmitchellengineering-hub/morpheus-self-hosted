// Ported from base44/functions/stripeWebhook/entry.ts.
// PUBLIC function — no authenticated user (webhooks aren't a logged-in
// request; buyer/seller are identified from the Stripe session metadata).
//
// index.js mounts express.raw({ type: 'application/json' }) on this route
// specifically, ahead of the JSON body parser, so `req.body` here is a
// Buffer of the exact bytes Stripe signed — required for HMAC verification.
//
// The original (base44/functions/stripeWebhook/entry.ts) verified the
// `Stripe-Signature` header itself using Web Crypto (crypto.subtle) against
// a secret read from Base44's `secrets.get("STRIPE_WEBHOOK_SECRET")`. Ported
// 1:1 to Node's built-in `crypto` module (HMAC-SHA256, constant-time
// compare) against `process.env.STRIPE_WEBHOOK_SECRET` — same scheme:
// header = "t=<unix-seconds>,v1=<hex hmac>", signed payload = "<t>.<rawBody>".
import crypto from 'node:crypto';
import { prisma } from '../db.js';
import { computeSplit } from '../lib/stripe.js';

function verifyStripeSignature(rawBody, signature, secret) {
  const parts = String(signature || '').split(',').reduce((acc, p) => {
    const [k, v] = p.split('=');
    if (k && v) acc[k.trim()] = v.trim();
    return acc;
  }, {});

  const timestamp = parts['t'];
  const v1Signature = parts['v1'];
  if (!timestamp || !v1Signature) throw new Error('Invalid signature header');

  const age = Math.floor(Date.now() / 1000) - parseInt(timestamp, 10);
  if (age > 300 || age < -300) throw new Error('Signature timestamp out of range');

  const signedPayload = `${timestamp}.${rawBody}`;
  const computed = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');

  const computedBuf = Buffer.from(computed, 'hex');
  const givenBuf = Buffer.from(v1Signature, 'hex');
  if (
    computedBuf.length !== givenBuf.length ||
    !crypto.timingSafeEqual(computedBuf, givenBuf)
  ) {
    throw new Error('Invalid signature');
  }
  return JSON.parse(rawBody);
}

export default async function handler({ req, res }) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('STRIPE_WEBHOOK_SECRET not configured');
    res.status(500).json({ error: 'Webhook secret not configured' });
    return;
  }

  const signature = req.headers['stripe-signature'] || '';
  // req.body is a raw Buffer on this route (see index.js's express.raw mount).
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');

  let event;
  try {
    event = verifyStripeSignature(rawBody, signature, webhookSecret);
  } catch (e) {
    console.error('Signature verification failed:', e.message);
    res.status(400).json({ error: 'Invalid signature' });
    return;
  }

  if (event.type !== 'checkout.session.completed') {
    return { received: true, ignored: event.type };
  }

  const session = event.data?.object || {};
  const metadata = session.metadata || {};
  const templateId = metadata.template_id;
  const buyerId = metadata.buyer_id || session.client_reference_id;
  const sellerId = metadata.seller_id || '';
  const templateName = metadata.template_name || '';

  if (!templateId || !buyerId) {
    console.error('Webhook missing template_id or buyer_id in metadata', metadata);
    res.status(400).json({ error: 'Missing metadata' });
    return;
  }

  const amount = (session.amount_total || 0) / 100;
  const { platformCut, sellerCut } = computeSplit(amount);

  // Idempotency: skip if this session was already recorded
  const existing = await prisma.purchase.findFirst({ where: { stripe_session_id: session.id } });
  if (!existing) {
    // Purchase.created_by_id is a hard FK to User, unlike buyer_id (a loose
    // display string the original could leave as 'anonymous'). This
    // shouldn't happen in practice — createTemplateCheckout now requires a
    // logged-in buyer and always sets a real buyer_id — but webhooks have
    // no authenticated request user to fall back on if it ever does, so
    // skip creating the row rather than crash the webhook (Stripe retries
    // on non-2xx, and downloadTemplate's fallback path, which runs in an
    // authenticated request, will create the Purchase instead).
    const buyerIsRealUser = buyerId && buyerId !== 'anonymous';
    if (buyerIsRealUser) {
      try {
        await prisma.purchase.create({
          data: {
            created_by_id: buyerId,
            template_id: templateId,
            template_name: templateName,
            buyer_id: buyerId,
            buyer_email: session.customer_details?.email || session.customer_email || '',
            seller_id: sellerId,
            amount,
            platform_cut: platformCut,
            seller_cut: sellerCut,
            stripe_session_id: session.id,
            status: 'paid',
          },
        });
        // Bump the template's install_count, matching downloadTemplate's
        // non-critical increment on the same event (paid purchase).
        await prisma.template.updateMany({ where: { id: templateId }, data: { install_count: { increment: 1 } } });
        console.log(`Purchase recorded: template=${templateId} buyer=${buyerId} amount=${amount} platform=${platformCut} seller=${sellerCut}`);
      } catch (e) {
        console.error('stripeWebhook: Purchase create failed:', e.message);
      }
    } else {
      console.warn(`stripeWebhook: anonymous buyer for template=${templateId} session=${session.id} — Purchase row deferred to downloadTemplate's authenticated fallback`);
    }
  }

  return { received: true };
}
