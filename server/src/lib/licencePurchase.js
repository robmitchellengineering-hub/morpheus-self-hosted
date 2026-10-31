// licencePurchase.js — the two production doors a licence needs: someone can BUY one, and Stripe's renewal events actually mint.
//
// WHY THIS EXISTS. `valiantLicence.js` could mint, and the SDK could gate, but nothing in production called the mint: there was no licence
// checkout, and the Stripe webhook handled only `checkout.session.completed`, so `invoice.paid` (renewal) and `invoice.payment_failed`
// (grace) were ignored. A monthly licence whose renewal is ignored is a licence that expires and never comes back.
//
// The design follows the SDK's own rules:
//   · fail closed — no price id, no issuer key, no customer: refuse with a sentence a human can act on;
//   · idempotent — the same Stripe event delivered twice must not mint twice, because Stripe retries;
//   · one row per mint in `licences`, so revocation and the admin list have something real to read.
import { licenceForEvent, LICENCE_DAYS, GRACE_DAYS } from './valiantLicence.js';

const PRICE_ENV = 'STRIPE_PRICE_VVS_SEAT';

/** The subscription price for one seat, per month. Absent means the product is not configured — never a default amount. */
export function seatPriceId() {
  return process.env[PRICE_ENV] || null;
}

/** True for the events this module acts on. Everything else stays the caller's business. */
export function handles(eventType) {
  return eventType === 'invoice.paid' || eventType === 'invoice.payment_failed' || eventType === 'customer.subscription.deleted';
}

/**
 * One event in, one decision out — no database, no mail, no network. The webhook calls this and then performs the effects, so the decision
 * can be tested without any of them.
 *
 * `deps.licenceExists(jti)` is the idempotency check: Stripe retries an event, and a retried payment must not double-mint.
 */
export async function decideEvent(event, { keyPem, now = Date.now(), licenceExists } = {}) {
  if (!handles(event?.type)) return { act: 'ignore', why: `not a licence event: ${event?.type}` };

  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data?.object?.id ?? null;
    return { act: 'revoke', subscription: sub, why: 'the subscription stopped, so the licence it paid for is revoked' };
  }

  if (!keyPem) return { act: 'refuse', why: 'VVS_ISSUER_KEY_PEM is not configured, so no licence can be signed' };

  // WHERE TO SEND IT. The claims name the Stripe customer, not an address, so the address must come from the event and travel with the
  // decision — otherwise a mint succeeds and nobody ever receives the licence.
  const o = event?.data?.object ?? {};
  const to = o.customer_email || o.customer_details?.email || null;
  // WHAT MAKES A RETRY A RETRY. The jti is random per mint, so it can never be the idempotency key: Stripe re-delivers the same event and a
  // jti check would mint a second licence every time. The event id is stable across retries, so it is what the store is asked about and
  // what the row records.
  const eventKey = o.id ?? event?.id ?? null;
  // The subscription is what a cancellation names, so the row carries it: without it, `customer.subscription.deleted` has no row to revoke.
  const subscription = o.subscription ?? (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed' ? null : o.id ?? null);

  const r = licenceForEvent(event, { keyPem, now });
  if (!r.minted) return { act: 'refuse', why: r.why ?? 'the event did not produce a licence' };

  // IDEMPOTENCY IS BY EVENT, not by time: Stripe retries with the same event id, so a row already minted for this event means the work is
  // done. The jti is what the row and the licence share.
  if (typeof licenceExists === 'function' && eventKey && await licenceExists(eventKey)) {
    return { act: 'duplicate', jti: r.claims.jti, eventKey, why: `this event (${eventKey}) has already minted a licence` };
  }
  return { act: 'mint', licence: r.licence, claims: r.claims, mail: r.mail, grace: !!r.claims.grace, to, eventKey, subscription };
}

/** The row shape `licences` expects (raw SQL — the table has no Prisma model). */
export function licenceRow(claims, { sessionId = null, note = null } = {}) {
  return {
    jti: claims.jti,
    plan: claims.plan,
    seats: claims.seats ?? 1,
    kid: claims.kid ?? null,
    issued_at: new Date(claims.iat * 1000).toISOString(),
    expires_at: new Date(claims.exp * 1000).toISOString(),
    stripe_session_id: sessionId,   // for an invoice event this is the EVENT id: it is what makes a retry recognisable

    note: note ?? (claims.grace ? `grace ${GRACE_DAYS} days after a failed payment` : `${LICENCE_DAYS} days`),
  };
}

/**
 * The effects for one decision, with the database and mailer injected so both can be faked in a test. Returns what happened, never throws
 * on a mail failure: a licence that was minted and stored must not be reported as refused because the email bounced.
 */
export async function applyDecision(decision, deps) {
  // THE MAILER IS INJECTED, never imported. A guard in this repo may not reach a package, and `mailer.js` pulls in nodemailer — so importing
  // it here would make every check that touches this module un-runnable in the no-install job. No mailer means no mail, and the result says so.
  const { storeLicence, mailer = null, to = null } = deps ?? {};
  if (decision.act === 'ignore' || decision.act === 'refuse' || decision.act === 'duplicate') {
    return { ...decision, stored: false, mailed: false };
  }
  if (decision.act === 'revoke') {
    const revoked = typeof deps?.revokeLicence === 'function' ? await deps.revokeLicence(decision.subscription) : 0;
    return { ...decision, revoked };
  }
  const note = decision.subscription ? `sub:${decision.subscription}` : null;
  const stored = typeof storeLicence === 'function'
    ? await storeLicence(licenceRow(decision.claims, { sessionId: decision.eventKey ?? null, note }))
    : false;
  let mailed = false;
  let mailWhy = null;
  const address = to ?? decision.to ?? decision.claims.email ?? null;
  if (address && decision.mail?.mail && typeof mailer === 'function') {
    try {
      await mailer({ to: address, subject: decision.mail.mail.subject, text: decision.mail.mail.text });
      mailed = true;
    } catch (e) { mailWhy = e.message; }
  } else if (address && decision.mail?.mail) {
    mailWhy = 'no mailer was provided';
  }
  return { ...decision, stored, mailed, ...(mailWhy ? { mailWhy } : {}) };
}
