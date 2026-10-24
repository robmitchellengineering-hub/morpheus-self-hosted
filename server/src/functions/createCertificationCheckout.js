// VDS certification checkout — the paid tier flow for the Valiant Verification
// Systems programme. PUBLIC function: a prospective client is not a signed-in
// Morpheus user, exactly like createDonationCheckout.
//
// Prices come from the Valiant Verification licensing tier guide
// (staging/valiant-verification-licensing.md), not invented here:
//   Layer 1  Spec                       free (open)
//   Layer 2  SDK                        $25 / dev / month, $49 enterprise
//   Layer 3  Guard + hazard corpus      $500 / month, $1,500 enterprise
// The first 10 design partners are free for 12 months (offered off-checkout).
//
// Reuses the marketplace's existing Stripe account/keys (STRIPE_SECRET_KEY,
// STRIPE_WEBHOOK_SECRET) — same confirmed decision as the donation and token
// flows. Prices live server-side only: the client sends WHICH package and
// how many seats, never an amount, so a tampered request cannot underpay.
import { stripeFetch, encodeForm } from '../lib/stripe.js';

// unit = cents per unit (per seat for the SDK, per month for the corpus).
const PACKAGES = {
  sdk: {
    name: 'Valiant Verification SDK — Standard',
    desc: '$25 / developer / month — the enforcement engine: runner, mutation prover, incident→rule→guard loop, reviewer-on-a-different-model.',
    unit: 2500,
    perSeat: true,
  },
  sdk_ent: {
    name: 'Valiant Verification SDK — Enterprise',
    desc: '$49 / developer / month — SSO, priority support and an SLA on top of the Standard SDK.',
    unit: 4900,
    perSeat: true,
  },
  corpus: {
    name: 'Guard + Hazard Corpus — Standard',
    desc: '$500 / month — the living feed of mutation-tested guards and the hazard ledger, updated as incidents land.',
    unit: 50000,
    perSeat: false,
  },
  corpus_ent: {
    name: 'Guard + Hazard Corpus — Enterprise',
    desc: '$1,500 / month — regulatory mappings, priority ingestion, and the Certified badge audit.',
    unit: 150000,
    perSeat: false,
  },
};

const MAX_SEATS = 5000;

export default async function handler({ body }) {
  const { package: pkg, seats, customerEmail, successUrl, cancelUrl } = body || {};
  const p = PACKAGES[pkg];
  if (!p) {
    throw Object.assign(
      new Error(`Unknown package "${pkg}". One of: ${Object.keys(PACKAGES).join(', ')}`),
      { status: 400 },
    );
  }
  if (!successUrl || !cancelUrl) {
    throw Object.assign(new Error('successUrl and cancelUrl required'), { status: 400 });
  }

  // Seats are only meaningful for the per-developer SDK; the corpus is flat.
  let quantity = 1;
  if (p.perSeat) {
    const n = Number(seats);
    if (!Number.isInteger(n) || n < 1 || n > MAX_SEATS) {
      throw Object.assign(new Error(`seats must be an integer 1..${MAX_SEATS}`), { status: 400 });
    }
    quantity = n;
  }

  const appId = process.env.BASE44_APP_ID || '';

  const session = await stripeFetch('/checkout/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: encodeForm({
      mode: 'subscription',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][product_data][name]': p.name,
      'line_items[0][price_data][product_data][description]': p.desc,
      'line_items[0][price_data][recurring][interval]': 'month',
      'line_items[0][price_data][unit_amount]': p.unit,
      'line_items[0][quantity]': quantity,
      success_url: successUrl,
      cancel_url: cancelUrl,
      customer_email: customerEmail || undefined,
      metadata: {
        base44_app_id: appId,
        type: 'valiant_verification',
        package: pkg,
        seats: quantity,
      },
    }),
  });

  return { url: session.url };
}
