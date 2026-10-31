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
import { licenceForEvent } from '../lib/valiantLicence.js';
import * as licencePurchase from '../lib/licencePurchase.js';
import { issuerKeyPem } from '../lib/licenceKey.js';
import { sendMail } from '../lib/mailer.js';

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

/**
 * Mint the licence for a verified event and mail it to the customer. Never throws: a mail failure must not make Stripe
 * retry a webhook that has already recorded the subscription, and a missing key must be loud in the log, not silent.
 */
/**
 * The ids this issuer has revoked, newest first, capped so a licence stays small. `revoked_at` is the only place a
 * revocation is recorded, so this is the single source for every carrier.
 */
async function revokedJtis(limit = 200) {
  const rows = await prisma.licence.findMany({
    where: { revoked_at: { not: null } },
    select: { jti: true },
    orderBy: { revoked_at: 'desc' },
    take: limit,
  });
  return rows.map((r) => r.jti).filter(Boolean);
}

async function issueLicence(event, { reason, to = null } = {}) {
  const keyPem = issuerKeyPem();   // either name — see lib/licenceKey.js
  // THE RENEWAL IS ALSO THE REVOCATION UPDATE (Rob, 2026-10-30). Every licence this service mints carries the list of
  // revoked ids, so a customer's machine learns it at renewal with no endpoint to run and no phone-home from the SDK. A
  // lookup that fails must not stop the licence: the customer gets one without the list rather than nothing at all.
  let revocations = [];
  try {
    revocations = await revokedJtis(event);
  } catch (e) {
    console.error(`valiant revocation list unavailable (${reason}): ${e.message} — minting without it`);
  }
  const r = licenceForEvent(event, { keyPem, to, revocations });
  if (!r.minted) {
    console.error(`valiant licence not minted (${reason}, ${event.type}): ${r.why}`);
    return r;
  }
  console.log(`valiant licence minted (${reason}): jti=${r.claims.jti} seats=${r.claims.seats} exp=${new Date(r.claims.exp * 1000).toISOString().slice(0, 10)}`);
  if (!r.mail?.ok) {
    console.error(`valiant licence NOT delivered (${reason}): ${r.mail?.why}`);
    return r;
  }
  try {
    const sent = await sendMail(r.mail.mail);
    if (!sent?.sent) console.log(`valiant licence mail (${reason}) not sent over SMTP — see [mailer] above for the body`);
  } catch (e) {
    console.error(`valiant licence mail failed (${reason}): ${e.message}`);
  }
  return r;
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

  // Subscription lifecycle (Valiant Verification). The checkout branch below
  // fires once, at purchase; seat changes and cancellation arrive as these
  // events on the same subscription. Rows are matched by Stripe subscription
  // id, so a subscription this system does not know about is a no-op.
  // THE LICENCE LIVES ON BILLING EVENTS, NOT ON THE CHECKOUT. A 7-day licence is renewed by every paid invoice and by
  // nothing else: stop paying, no renewal is minted, and the SDK refuses inside a week. Deliberately placed before the
  // checkout branch so a renewal is handled whatever else the event carries.
  if (event.type === 'invoice.paid' || event.type === 'invoice.payment_succeeded') {
    await issueLicence(event, { reason: 'renewal' });
    return { received: true, licence: 'renewed' };
  }
  if (event.type === 'invoice.payment_failed' || event.type === 'customer.subscription.paused') {
    // NOT PAID: mint nothing, and say so in the log so an operator can see the subscription slipping before the licence
    // runs out. The row is still updated below so the registry shows past_due.
    const notice = licenceForEvent(event, { keyPem: null });
    console.log(`valiant licence NOT renewed (${event.type}): ${notice.why}`);
  }

  if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
    const sub = event.data?.object || {};
    const seats = Number(sub.items?.data?.[0]?.quantity) || 1;
    try {
      await prisma.verificationSubscription.updateMany({
        where: { stripe_subscription_id: sub.id },
        data: {
          status: event.type === 'customer.subscription.deleted' ? 'canceled' : (sub.status || 'active'),
          seats,
          current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000) : undefined,
        },
      });
    } catch (e) {
      console.error('stripeWebhook: subscription update failed:', e.message);
    }
    return { received: true };
  }

  // ── THE LICENCE DOORS ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  // A monthly licence is sold as a Stripe subscription, so what mints it is `invoice.paid` (the first and every renewal) and what grants
  // grace is `invoice.payment_failed`. Neither was handled: the webhook ignored every event except `checkout.session.completed`, so a
  // licence would have been sold and never issued, and a renewal would never have arrived.
  if (licencePurchase.handles(event.type)) {
    try {
      const decision = await licencePurchase.decideEvent(event, {
        keyPem: issuerKeyPem(),
        // A retried event must not mint a second licence: the event id is recorded on the row that the first delivery created.
        licenceExists: async (eventKey) => {
          const rows = await prisma.$queryRawUnsafe('select 1 from licences where stripe_session_id = $1 limit 1', eventKey);
          return Array.isArray(rows) && rows.length > 0;
        },
      });
      const settled = await licencePurchase.applyDecision(decision, {
        storeLicence: async (row) => {
          await prisma.$executeRawUnsafe(
            'insert into licences (jti, plan, seats, kid, issued_at, expires_at, stripe_session_id, note) values ($1,$2,$3,$4,$5,$6,$7,$8)',
            row.jti, row.plan, row.seats, row.kid, row.issued_at, row.expires_at, row.stripe_session_id, row.note,
          );
          return true;
        },
        mailer: sendMail,
        revokeLicence: async (subscription) => {
          if (!subscription) return 0;
          const r2 = await prisma.$executeRawUnsafe('update licences set revoked_at = now() where revoked_at is null and note like $1', `%sub:${subscription}%`);
          return Number(r2) || 0;
        },
      });
      console.log(`licence: ${settled.act}${settled.jti ? ` jti=${settled.jti}` : ''}${settled.why ? ` (${settled.why})` : ''}`);
      return { received: true, licence: { act: settled.act, stored: !!settled.stored, mailed: !!settled.mailed } };
    } catch (e) {
      // A licence that could not be minted must not report success: Stripe would stop retrying and the buyer would have paid for nothing.
      console.error('stripeWebhook: licence handling failed:', e.message);
      res.status(500).json({ error: 'licence handling failed' });
      return;
    }
  }

  if (event.type !== 'checkout.session.completed') {
    return { received: true, ignored: event.type };
  }

  const session = event.data?.object || {};
  const metadata = session.metadata || {};

  // A LICENCE CHECKOUT COMPLETING IS NOT A MINT. The subscription's first `invoice.paid` mints, and it arrives separately — so this event is
  // acknowledged and nothing else: falling through to the marketplace purchases below would try to read template fields it does not have.
  if (metadata.type === 'vvs_licence') {
    return { received: true, licence: { checkout: 'completed', minted: false, note: 'the invoice.paid event mints the licence' } };
  }

  // Donations (landing page's "KEEP MORPHEUS ALIVE" widget) have no
  // template/buyer — branch off before the marketplace-purchase checks
  // below, which require both. New addition, not part of the base44 port.
  if (metadata.type === 'donation') {
    const amount = (session.amount_total || 0) / 100;
    const existingDonation = await prisma.donation.findFirst({ where: { stripe_session_id: session.id } });
    if (!existingDonation) {
      try {
        await prisma.donation.create({
          data: {
            amount,
            donor_email: session.customer_details?.email || session.customer_email || null,
            stripe_session_id: session.id,
            status: 'paid',
          },
        });
        console.log(`Donation recorded: session=${session.id} amount=${amount}`);
      } catch (e) {
        console.error('stripeWebhook: Donation create failed:', e.message);
      }
    }
    return { received: true };
  }

  // Token-block purchases (Step 6, 2026-09-01) — also branch off before the
  // marketplace-purchase checks below, which require template/buyer fields
  // this flow doesn't have. Credits the buyer's account and records the
  // ledger row in one transaction so a crash between the two can't leave
  // credits granted without a matching CreditTransaction, or vice versa.
  if (metadata.type === 'token_purchase') {
    const userId = metadata.user_id || session.client_reference_id;
    const credits = Number(metadata.credits);
    const intendedNetUsd = Number(metadata.intended_net_usd) || 0;
    const isFirstPurchase = metadata.is_first_purchase === 'true';
    const amount = (session.amount_total || 0) / 100;

    if (!userId || !Number.isFinite(credits) || credits <= 0) {
      console.error('stripeWebhook: token_purchase missing/invalid metadata', metadata);
      res.status(400).json({ error: 'Missing metadata' });
      return;
    }

    const existingTxn = await prisma.creditTransaction.findFirst({ where: { stripe_session_id: session.id } });
    if (!existingTxn) {
      try {
        await prisma.$transaction([
          prisma.creditTransaction.create({
            data: {
              created_by_id: userId,
              credits,
              amount_usd: amount,
              intended_net_usd: intendedNetUsd,
              stripe_session_id: session.id,
              status: 'paid',
              is_first_purchase: isFirstPurchase,
            },
          }),
          prisma.user.update({
            where: { id: userId },
            data: { credit_balance: { increment: credits } },
          }),
        ]);
        console.log(`Token purchase recorded: user=${userId} credits=${credits} amount=${amount} firstPurchase=${isFirstPurchase}`);
      } catch (e) {
        console.error('stripeWebhook: CreditTransaction create failed:', e.message);
      }
    }
    return { received: true };
  }

  // Valiant Verification subscription (VDS certification). The package and
  // head count ride in the session metadata; the Stripe subscription id is on
  // the session. Recorded so the registry knows who is paying and how many
  // seats, instead of reconstructing it from Stripe's dashboard by hand.
  if (metadata.type === 'valiant_verification') {
    const subId = session.subscription;
    const seats = Number(metadata.seats) || 1;
    const pkg = metadata.package || 'unknown';
    if (!subId) {
      // Stripe sends a string id for a subscription-mode session; a missing
      // one means the session was not subscription-mode. Do not create a row
      // that can never be updated.
      console.error('stripeWebhook: valiant_verification without subscription id', session.id);
      return { received: true };
    }
    try {
      await prisma.verificationSubscription.upsert({
        where: { stripe_subscription_id: subId },
        update: {
          package: pkg,
          seats,
          status: 'active',
          stripe_customer_id: session.customer || null,
          customer_email: session.customer_details?.email || null,
        },
        create: {
          stripe_subscription_id: subId,
          stripe_customer_id: session.customer || null,
          package: pkg,
          seats,
          status: 'active',
          customer_email: session.customer_details?.email || null,
        },
      });
      console.log(`VDS subscription recorded: sub=${subId} package=${pkg} seats=${seats}`);
      // The first licence, on the purchase itself: the customer should not have to wait for the next invoice.
      await issueLicence(event, { reason: 'first', to: session.customer_details?.email || null });
    } catch (e) {
      console.error('stripeWebhook: VerificationSubscription upsert failed:', e.message);
    }
    return { received: true };
  }

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
        // NOTE: intentionally NOT bumping install_count here. An earlier
        // pass added an increment on this same event, believing it matched
        // downloadTemplate's own increment — but that made it additive, not
        // duplicative-in-a-good-way: a single paid purchase (webhook fires,
        // then the buyer's success page calls downloadTemplate to fetch the
        // zip) was counting as 2 installs. The original base44 webhook never
        // touched Template.install_count at all — downloadTemplate was
        // always the sole source of truth for that counter — so this keeps
        // it that way rather than double-counting every paid sale.
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
