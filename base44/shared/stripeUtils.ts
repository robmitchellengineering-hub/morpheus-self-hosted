const STRIPE_API = 'https://api.stripe.com/v1';

export function getStripeKey(): string {
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) throw new Error('STRIPE_SECRET_KEY not configured');
  return key;
}

export async function stripeFetch(path: string, init: RequestInit = {}): Promise<any> {
  const key = getStripeKey();
  const res = await fetch(`${STRIPE_API}${path}`, {
    ...init,
    headers: {
      'Authorization': `Bearer ${key}`,
      'Stripe-Version': '2025-10-29.clover',
      ...(init.headers || {})
    }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Stripe API error: ${res.status}`);
  return data;
}

export function encodeForm(params: Record<string, any>): string {
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

export const PLATFORM_COMMISSION = 0.20;

export function computeSplit(amount: number): { platformCut: number; sellerCut: number } {
  const platformCut = Math.round(amount * PLATFORM_COMMISSION * 100) / 100;
  return { platformCut, sellerCut: Math.round((amount - platformCut) * 100) / 100 };
}