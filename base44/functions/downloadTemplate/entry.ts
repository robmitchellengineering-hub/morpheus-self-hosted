import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { stripeFetch, computeSplit } from '../../shared/stripeUtils.ts';

// Public endpoint — no auth required.
// Verifies a Stripe checkout session was paid, then releases the template files
// so the buyer can download their purchase. Used by the public store success page.
//
// Race condition handling: the Stripe redirect may arrive before the webhook
// processes. If no Purchase record exists yet, we verify the session directly
// with the Stripe API and release files immediately.

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const { sessionId, templateId } = body;
    if (!sessionId || !templateId) return Response.json({ error: 'sessionId and templateId required' }, { status: 400 });

    // Fast path: Purchase record already exists (webhook processed)
    const purchases = await base44.asServiceRole.entities.Purchase.filter({ stripe_session_id: sessionId, status: 'paid' });
    let purchase = purchases[0];

    // Fallback: webhook hasn't processed yet — verify directly with Stripe
    if (!purchase) {
      let session: any;
      try {
        session = await stripeFetch(`/checkout/sessions/${sessionId}`);
      } catch (e) {
        console.error('downloadTemplate: Stripe session lookup failed:', e.message);
        return Response.json({ error: 'Could not verify payment. Please try again in a moment.' }, { status: 403 });
      }

      if (session.payment_status !== 'paid') {
        return Response.json({ error: 'Payment not completed' }, { status: 403 });
      }

      const metadata = session.metadata || {};
      const sessionTemplateId = metadata.template_id || templateId;
      if (sessionTemplateId !== templateId) {
        return Response.json({ error: 'Purchase does not match this template' }, { status: 403 });
      }

      // Create the Purchase record now (webhook may still arrive later — idempotency check handles that)
      const amount = (session.amount_total || 0) / 100;
      const { platformCut, sellerCut } = computeSplit(amount);
      try {
        purchase = await base44.asServiceRole.entities.Purchase.create({
          template_id: templateId,
          template_name: metadata.template_name || '',
          buyer_id: metadata.buyer_id || 'anonymous',
          buyer_email: session.customer_details?.email || session.customer_email || '',
          seller_id: metadata.seller_id || '',
          amount,
          platform_cut: platformCut,
          seller_cut: sellerCut,
          stripe_session_id: session.id,
          status: 'paid'
        });
        console.log(`Purchase recorded (download fallback): template=${templateId} session=${session.id}`);
      } catch (e) {
        // If create fails (e.g. duplicate), the webhook already created it — proceed
        console.error('downloadTemplate: Purchase create failed (may be duplicate):', e.message);
      }
    } else {
      if (purchase.template_id !== templateId) {
        return Response.json({ error: 'Purchase does not match this template' }, { status: 403 });
      }
    }

    const template = await base44.asServiceRole.entities.Template.get(templateId);
    if (!template) return Response.json({ error: 'Template not found' }, { status: 404 });

    // Increment install count (non-critical)
    try {
      await base44.asServiceRole.entities.Template.update(templateId, {
        install_count: (template.install_count || 0) + 1
      });
    } catch (e) {
      console.error('downloadTemplate: install_count increment failed:', e.message);
    }

    return Response.json({
      files: template.files || '',
      name: template.name,
      compile_target: template.compile_target || 'source'
    });
  } catch (error) {
    console.error('downloadTemplate error:', error?.message || error);
    return Response.json({ error: error?.message || 'Unknown error' }, { status: 500 });
  }
}