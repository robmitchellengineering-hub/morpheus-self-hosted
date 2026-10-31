// valiantLicence.js — mint a short Valiant licence when Stripe says the subscription is paid, and mint nothing when it
// is not.
//
// Rob, 2026-10-27: licences live 7 days and the renewal goes to the Stripe customer; "if those payments stop I need the
// SDK to stop." The SDK verifies licences OFFLINE, so liveness is expressed as TIME: a 7-day licence renewed only while
// the subscription pays. Stop paying and the last licence runs out inside a week — `valiant gate` then refuses with
// "licence expired N day(s) ago" and exit 2.
//
// This is a PORT of valiant-verification-sdk's src/stripe-renew.mjs (main 85e31f9), not an import: the server cannot
// reach that repo at run time. The signing convention is byte-identical to tools/mint-licence.mjs there, so a licence
// minted here verifies in any shipped SDK build.
import crypto from 'node:crypto';

// MONTHLY, BECAUSE THAT IS WHAT IS PAID FOR (Rob, 2026-10-30). A subscription bills monthly, so the licence it mints lasts
// the billing period; a customer is never asked to renew something they have already paid for.
export const LICENCE_DAYS = 30;
/** The grace a failed payment buys: long enough for a card change, short enough to matter. */
export const GRACE_DAYS = 7;
/** One CI runner per seat, so five seats allow five runners (Rob, 2026-11-02). The SDK already mints this; this issuer did not, so a
 *  licence from here stated only machines and the runner allowance existed by accident, as the SDK's fallback. */
export const RUNNERS_PER_SEAT = 1;

const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Events that keep a licence alive, which grant GRACE, and which must NOT mint one. Named explicitly, never defaulted. */
export const RENEWING = new Set(['invoice.paid', 'invoice.payment_succeeded', 'customer.subscription.updated', 'customer.subscription.created']);
/**
 * A FAILED PAYMENT IS NOT AN INSTANT CUT-OFF (Rob, 2026-10-30): "if someones payment fails they dont instantly loose service
 * they have 7 days to pay before it shuts down". The failed payment mints a deliberate, bounded grace licence — a declined
 * card is not an outage — and when that expires, nothing more is minted.
 */
export const GRACE_TRIGGER = 'invoice.payment_failed';
export const STOPPING = new Set(['customer.subscription.deleted', 'customer.subscription.paused', 'charge.refunded']);

export function decide(event) {
  const type = event?.type;
  if (RENEWING.has(type)) return { renew: true, why: type };
  if (type === GRACE_TRIGGER) return { renew: true, grace: true, days: GRACE_DAYS, why: `${type} — the payment failed, so a ${GRACE_DAYS}-day grace licence is minted` };
  if (STOPPING.has(type)) return { renew: false, stop: true, why: `${type} — not paid; no licence is minted and the last one is left to expire` };
  return { renew: false, why: `${type ?? '(no type)'} is not a billing event this service acts on` };
}

/** Seats come from what was bought (the Stripe quantity), so a licence matches the subscription rather than guessing. */
export function claimsFor(event, { days = LICENCE_DAYS, grace = false, revocations = [], now = Date.now() } = {}) {
  const o = event?.data?.object ?? {};
  const account = o.customer ?? o.customer_email ?? o.subscription ?? null;
  if (!account) return { ok: false, why: 'the event names no customer, so a licence cannot be tied to an account' };
  const quantity = o.lines?.data?.[0]?.quantity ?? o.quantity ?? o.items?.data?.[0]?.quantity ?? 1;
  const t = Math.floor(now / 1000);
  return {
    ok: true,
    claims: {
      v: 1,
      sub: String(account),
      plan: quantity > 1 ? 'team' : 'solo',
      seats: Number(quantity) || 1,
      runners: Math.max(1, (Number(quantity) || 1) * RUNNERS_PER_SEAT),
      jti: `lic_${t.toString(36)}_${crypto.randomBytes(4).toString('hex')}`,
      iat: t,
      exp: t + Math.round(days * 86_400),
      src: 'stripe',
      // THE KEY ID, so a verifier with a keyring can pick the right key. Omitting it made `valiant licence --status` refuse a licence
      // this service had just minted — "several signing keys but the licence names no key id" — which reads as a bad licence rather
      // than an incomplete claim. `signLicence` signs with VVS_ISSUER_KEY_PEM, so the id must name that key.
      kid: process.env.VVS_KID || 'vvs-2026-10',
      // A grace licence is labelled, so support can tell "we granted you a week" from "you paid".
      ...(grace ? { grace: true } : {}),
      ...(Array.isArray(revocations) && revocations.length ? { revocations } : {}),
      event: event.id ?? null,
    },
  };
}

/** Sign exactly as the SDK's minter does: vvs1.<base64url(claims)>.<base64url(sig over the raw claims bytes)>. */
export function mintLicence(claims, keyPem) {
  const key = crypto.createPrivateKey(keyPem);
  const payload = Buffer.from(JSON.stringify(claims));
  return `vvs1.${b64url(payload)}.${b64url(crypto.sign(null, payload, key))}`;
}

export function customerEmail(event) {
  const o = event?.data?.object ?? {};
  return o.customer_email ?? o.receipt_email ?? o.customer_details?.email ?? o.email ?? null;
}

/** The message the customer receives. An address is never invented: no email in the event means no message. */
export function renewalMail({ event, licence, claims, to = null }) {
  const address = to ?? customerEmail(event);
  if (!address) return { ok: false, why: 'no customer email on the event or the subscription — the licence was minted but nobody can be told' };
  const days = Math.max(1, Math.round((claims.exp - claims.iat) / 86_400));
  const expires = new Date(claims.exp * 1000).toISOString().slice(0, 10);
  const text = [
    'Your Valiant licence has been renewed.',
    '',
    `Account:   ${claims.sub}`,
    `Plan:      ${claims.plan}${claims.seats ? ` (${claims.seats} seat${claims.seats === 1 ? '' : 's'})` : ''}`,
    `Licence:   ${claims.jti}`,
    `Valid for: ${days} days — until ${expires}`,
    '',
    'Install it on each machine (the file is attached):',
    '',
    `  valiant licence --file ${claims.jti}.licence`,
    '',
    'Then check it with:  valiant licence --status',
    '',
    'It verifies offline, with no account and no network call.',
    '',
    'This licence is short-lived on purpose: it renews while your subscription is paid, and stops when it is not.',
  ].join('\n');
  return {
    ok: true,
    mail: {
      to: address,
      subject: `Valiant licence renewed — valid until ${expires}`,
      text,
      attachments: [{ filename: `${claims.jti}.licence`, content: `${licence}\n` }],
    },
  };
}

/**
 * The whole decision for one verified Stripe event: mint + mail on a paid event, nothing on a stopping one.
 * `keyPem` absent means the issuer key is not configured — the caller is told, and NO half-licence is invented.
 */
export function licenceForEvent(event, { keyPem, days = LICENCE_DAYS, to = null, revocations = [], now = Date.now() } = {}) {
  const d = decide(event);
  if (!d.renew) return { minted: false, stopped: !!d.stop, why: d.why };
  if (!keyPem) return { minted: false, why: 'VALIANT_ISSUER_KEY is not configured, so no licence can be signed' };
  // A GRACE MINT USES ITS OWN TERM. Reusing the paid term here would give a failed payment another full month.
  const term = d.grace ? d.days : days;
  // THE RENEWAL IS ALSO THE REVOCATION UPDATE: the list rides on the licence so it reaches machines that will never call
  // an endpoint. Bounded by the caller — a licence that is all list is a licence nobody can paste.
  const c = claimsFor(event, { days: term, grace: !!d.grace, revocations, now });
  if (!c.ok) return { minted: false, why: c.why };
  const licence = mintLicence(c.claims, keyPem);
  const mail = renewalMail({ event, licence, claims: c.claims, to });
  return { minted: true, claims: c.claims, licence, mail };
}
