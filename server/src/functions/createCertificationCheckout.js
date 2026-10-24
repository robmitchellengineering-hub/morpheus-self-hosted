// VDS certification checkout — the paid audit / deposit flow for the
// Valiant Verification Systems certification program
// (vvs.morpheus.nz/certification). PUBLIC function: a prospective client is
// not a signed-in Morpheus user, exactly like createDonationCheckout.
//
// Reuses the marketplace's existing Stripe account/keys (STRIPE_SECRET_KEY,
// STRIPE_WEBHOOK_SECRET) rather than a second account — same confirmed
// decision as the donation and token flows. There is no persisted Stripe
// Price id for a certification package, so the line item is built inline
// with `price_data`, mirroring createDonationCheckout.js.
//
// The package prices live server-side only: the client sends WHICH package
// it wants, never an amount. An unknown package throws, so a tampered
// request cannot buy an audit below its real price.
import { stripeFetch, encodeForm } from '../lib/stripe.js';

const PACKAGES = {
  audit: {
    name: 'VDS Certification Audit — L3',
    usd: 12000,
    desc: 'A full conformance audit of one model/version: the signed report and the public registry entry.',
  },
  deposit: {
    name: 'VDS Audit Deposit',
    usd: 2500,
    desc: 'Reserves the audit; credited toward the full certification fee.',
  },
  reaudit: {
    name: 'VDS Annual Re-audit',
    usd: 7500,
    desc: 'The annual re-audit of an already-certified version.',
  },
};

export default async function handler({ body }) {
  const { package: pkg = 'deposit', customerEmail, successUrl, cancelUrl } = body || {};
  const p = PACKAGES[pkg];
  if (!p) {
    throw Object.assign(new Error(`Unknown certification package "${pkg}"`), { status: 400 });
  }
  if (!successUrl || !cancelUrl) {
    throw Object.assign(new Error('successUrl and cancelUrl required'), { status: 400 });
  }

  const appId = process.env.BASE44_APP_ID || '';

  const session = await stripeFetch('/checkout/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: encodeForm({
      mode: 'payment',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][product_data][name]': p.name,
      'line_items[0][price_data][product_data][description]': p.desc,
      'line_items[0][price_data][unit_amount]': Math.round(p.usd * 100),
      'line_items[0][quantity]': 1,
      success_url: successUrl,
      cancel_url: cancelUrl,
      customer_email: customerEmail || undefined,
      metadata: {
        base44_app_id: appId,
        type: 'vds_certification',
        package: pkg,
        usd: p.usd,
      },
    }),
  });

  return { url: session.url };
}
