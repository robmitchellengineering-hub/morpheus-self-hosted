// Ported from base44/shared/stripeUtils.ts.
//
// The original is a thin fetch-based wrapper around the raw Stripe REST API
// (it does NOT use the `stripe` npm SDK, despite that package being present
// in server/package.json for other uses) — `stripeFetch` + `encodeForm` are
// generic helpers that base44/functions/{createTemplateCheckout,
// publishTemplate,downloadTemplate,stripeWebhook}/entry.ts call directly by
// name. Ported verbatim (Deno.env.get → process.env) so those functions'
// ports can keep calling stripeFetch/encodeForm/computeSplit unchanged.
const STRIPE_API = 'https://api.stripe.com/v1';

export function getStripeKey() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY not configured');
  return key;
}

export async function stripeFetch(path, init = {}) {
  const key = getStripeKey();
  const res = await fetch(`${STRIPE_API}${path}`, {
    ...init,
    headers: {
      'Authorization': `Bearer ${key}`,
      'Stripe-Version': '2025-10-29.clover',
      ...(init.headers || {}),
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Stripe API error: ${res.status}`);
  return data;
}

export function encodeForm(params) {
  const url = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (typeof item === 'object' && item !== null) {
          for (const [sk, sv] of Object.entries(item)) {
            if (sv === undefined || sv === null) continue;
            url.append(`${k}[${i}][${sk}]`, String(sv));
          }
        } else {
          url.append(`${k}[${i}]`, String(item));
        }
      });
    } else if (typeof v === 'object' && v !== null) {
      for (const [sk, sv] of Object.entries(v)) {
        if (sv === undefined || sv === null) continue;
        url.append(`${k}[${sk}]`, String(sv));
      }
    } else {
      url.append(k, String(v));
    }
  }
  return url.toString();
}

// Original hardcoded PLATFORM_COMMISSION = 0.20 with no way to configure it.
// server/.env.example already documents MARKETPLACE_PLATFORM_CUT_PCT=20 for
// self-hosters who want a different split, so we read it here — falling back
// to 0.20 (the original's exact hardcoded value) whenever it's unset or
// invalid, which reproduces the original's behavior by default.
function resolvePlatformCommission() {
  const pct = Number(process.env.MARKETPLACE_PLATFORM_CUT_PCT);
  if (Number.isFinite(pct) && pct >= 0 && pct <= 100) return pct / 100;
  return 0.20;
}

export const PLATFORM_COMMISSION = resolvePlatformCommission();

export function computeSplit(amount) {
  const platformCut = Math.round(amount * PLATFORM_COMMISSION * 100) / 100;
  return { platformCut, sellerCut: Math.round((amount - platformCut) * 100) / 100 };
}
