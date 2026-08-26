// Ported from base44/functions/downloadTemplate/entry.ts.
//
// Not in PUBLIC_FUNCTIONS (routes/functions.routes.js), so the dispatcher
// requires auth to reach this handler — a confirmed, deliberate difference
// from the original (which was a fully public endpoint; anonymous buyers
// could purchase and download without an account). Requiring an account
// here is intentional for this deployment (better fraud/support/refund
// handling at scale), not an oversight. `createTemplateCheckout` now always
// attributes the purchase to the verified, logged-in buyer, so the
// 'anonymous' buyer_id case below is a defensive fallback for old/duplicate
// sessions rather than a supported flow.
//
// Race condition handling: the Stripe redirect may arrive before the
// webhook processes. If no Purchase record exists yet, we verify the
// session directly with the Stripe API and release the files immediately.
//
// Unlike the original (which returned the template's files as raw JSON for
// the frontend to zip client-side), this port builds the ZIP server-side
// with jszip and streams it back as `application/zip`, per this port's
// download contract.
import JSZip from 'jszip';
import { prisma } from '../db.js';
import { stripeFetch, computeSplit } from '../lib/stripe.js';

export default async function handler({ user, body, res }) {
  const { sessionId, templateId } = body || {};
  if (!sessionId || !templateId) throw Object.assign(new Error('sessionId and templateId required'), { status: 400 });

  // Fast path: Purchase record already exists (webhook processed)
  let purchase = await prisma.purchase.findFirst({ where: { stripe_session_id: sessionId, status: 'paid' } });

  // Fallback: webhook hasn't processed yet — verify directly with Stripe
  if (!purchase) {
    let session;
    try {
      session = await stripeFetch(`/checkout/sessions/${sessionId}`);
    } catch (e) {
      console.error('downloadTemplate: Stripe session lookup failed:', e.message);
      throw Object.assign(new Error('Could not verify payment. Please try again in a moment.'), { status: 403 });
    }

    if (session.payment_status !== 'paid') {
      throw Object.assign(new Error('Payment not completed'), { status: 403 });
    }

    const metadata = session.metadata || {};
    const sessionTemplateId = metadata.template_id || templateId;
    if (sessionTemplateId !== templateId) {
      throw Object.assign(new Error('Purchase does not match this template'), { status: 403 });
    }

    // Create the Purchase record now (webhook may still arrive later — idempotency check handles that)
    const amount = (session.amount_total || 0) / 100;
    const { platformCut, sellerCut } = computeSplit(amount);
    try {
      // Purchase.created_by_id is a hard FK to User (unlike buyer_id, which
      // is a loose display string the original left as 'anonymous' for
      // unauthenticated buyers). This route requires auth (it isn't in
      // PUBLIC_FUNCTIONS), so `user` is always the real, currently
      // authenticated buyer — use it whenever the session metadata doesn't
      // name a real user id, so the FK constraint is always satisfiable.
      const metaBuyerId = metadata.buyer_id && metadata.buyer_id !== 'anonymous' ? metadata.buyer_id : null;
      purchase = await prisma.purchase.create({
        data: {
          created_by_id: metaBuyerId || user.id,
          template_id: templateId,
          template_name: metadata.template_name || '',
          buyer_id: metadata.buyer_id || 'anonymous',
          buyer_email: session.customer_details?.email || session.customer_email || '',
          seller_id: metadata.seller_id || '',
          amount,
          platform_cut: platformCut,
          seller_cut: sellerCut,
          stripe_session_id: session.id,
          status: 'paid',
        },
      });
      console.log(`Purchase recorded (download fallback): template=${templateId} session=${session.id}`);
    } catch (e) {
      // If create fails (e.g. duplicate), the webhook already created it — proceed
      console.error('downloadTemplate: Purchase create failed (may be duplicate):', e.message);
    }
  } else if (purchase.template_id !== templateId) {
    throw Object.assign(new Error('Purchase does not match this template'), { status: 403 });
  }

  const template = await prisma.template.findUnique({ where: { id: templateId } });
  if (!template) throw Object.assign(new Error('Template not found'), { status: 404 });

  // Increment install count (non-critical)
  try {
    await prisma.template.update({ where: { id: templateId }, data: { install_count: (template.install_count || 0) + 1 } });
  } catch (e) {
    console.error('downloadTemplate: install_count increment failed:', e.message);
  }

  let files = [];
  try {
    files = JSON.parse(template.files || '[]');
  } catch {
    files = [];
  }

  const zip = new JSZip();
  for (const f of files) {
    if (!f?.path) continue;
    zip.file(f.path, f.content || '');
  }
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });

  const safeName = (template.name || 'template').replace(/[^a-zA-Z0-9._-]/g, '_');
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="${safeName}.zip"`);
  res.send(buffer);
}
