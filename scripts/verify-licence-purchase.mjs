#!/usr/bin/env node
// verify-licence-purchase.mjs — the two doors exist, are idempotent, and refuse for a stated reason.
//
// The chain test (licence-chain-e2e.mjs) proves a minted licence opens a gate. This proves the *other* half: that Stripe's renewal events
// actually mint, that a retried event does not mint twice, and that every missing prerequisite refuses with a sentence instead of
// producing half a licence. No Stripe account, no network, no mail: the mailer and the store are injected.
import { generateKeyPairSync } from 'node:crypto';
import { decideEvent, applyDecision, handles, seatPriceId, licenceRow } from '../server/src/lib/licencePurchase.js';
import { LICENCE_DAYS, GRACE_DAYS } from '../server/src/lib/valiantLicence.js';

let wrong = 0;
const check = (name, ok, detail = '') => {
  if (!ok) wrong++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n          ${detail}`}`);
};

const keyPem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
const paid = (q = 1, id = 'evt_1') => ({ id, type: 'invoice.paid', data: { object: { customer: 'cus_1', customer_email: 'buyer@example.com', lines: { data: [{ quantity: q }] } } } });
const failed = (q = 1, id = 'evt_2') => ({ id, type: 'invoice.payment_failed', data: { object: { customer: 'cus_1', customer_email: 'buyer@example.com', lines: { data: [{ quantity: q }] } } } });

// ── which events this module owns
{
  check('a paid invoice is ours', handles('invoice.paid'));
  check('a failed payment is ours', handles('invoice.payment_failed'));
  check('a cancelled subscription is ours', handles('customer.subscription.deleted'));
  check('an unrelated event is ignored with a reason', (await decideEvent({ type: 'charge.succeeded' })).act === 'ignore');
}

// ── a paid invoice mints a month, and stores one row
{
  const d = await decideEvent(paid(1), { keyPem });
  check('a paid invoice mints', d.act === 'mint' && typeof d.licence === 'string' && d.licence.startsWith('vvs1.'));
  check(`…for ${LICENCE_DAYS} days`, Math.round((d.claims.exp - d.claims.iat) / 86_400) === LICENCE_DAYS);
  check('…with one seat and one runner', d.claims.seats === 1 && d.claims.runners === 1);
  check('…and it is not marked as grace', !d.grace);
  const row = licenceRow(d.claims);
  check('the row names the licence, plan and expiry', row.jti === d.claims.jti && row.plan === 'solo' && typeof row.expires_at === 'string');
}

// ── a retried event does not mint twice
{
  const first = await decideEvent(paid(1), { keyPem });
  // A retry carries the SAME event id, which is the key — the jti is random per mint and can never match a retry.
  const again = await decideEvent(paid(1, 'evt_1'), { keyPem, licenceExists: (key2) => key2 === first.eventKey });
  // A retry arrives with a NEW event id but the same customer, so the idempotency key is what the store already holds. If the store has no
  // row, a second event legitimately mints a new licence — that is a second payment, not a duplicate.
  check('a licence the store already holds is not minted again', again.act === 'duplicate', again.why);
  const fresh = await decideEvent(paid(1, 'evt_2'), { keyPem, licenceExists: () => false });
  check('…while a genuinely new event still mints', fresh.act === 'mint');
}

// ── a failed payment buys grace, not a month
{
  const d = await decideEvent(failed(1), { keyPem });
  check(`a failed payment mints ${GRACE_DAYS} days`, d.act === 'mint' && Math.round((d.claims.exp - d.claims.iat) / 86_400) === GRACE_DAYS);
  check('…labelled as grace', d.grace === true && d.claims.grace === true);
  check('…and the row says why', /grace/i.test(licenceRow(d.claims).note ?? ''));
}

// ── every missing prerequisite refuses, and says which
{
  const noKey = await decideEvent(paid(), { keyPem: null });
  check('no issuer key refuses with a sentence', noKey.act === 'refuse' && /ISS?UER_KEY_PEM/i.test(noKey.why), noKey.why);
  const noCustomer = await decideEvent({ id: 'e', type: 'invoice.paid', data: { object: { lines: { data: [{ quantity: 1 }] } } } }, { keyPem });
  check('an event naming no customer refuses', noCustomer.act === 'refuse' && /customer/i.test(noCustomer.why), noCustomer.why);
  const saved = process.env.STRIPE_PRICE_VVS_SEAT;
  delete process.env.STRIPE_PRICE_VVS_SEAT;
  check('an unconfigured price is not a default amount', seatPriceId() === null);
  if (saved) process.env.STRIPE_PRICE_VVS_SEAT = saved;
}

// ── the effects: one row stored, one mail sent, and a mail failure does not undo a mint
{
  const d = await decideEvent(paid(), { keyPem });
  const stored = [];
  const mails = [];
  const res = await applyDecision(d, { storeLicence: async (row) => { stored.push(row); return true; }, mailer: async (m) => { mails.push(m); } });
  check('the mint stores exactly one row', stored.length === 1 && res.stored === true);
  check('…records the event that minted it, so a retry is recognisable', stored[0].stripe_session_id === d.eventKey);
  check('…and mails the buyer the licence', mails.length === 1 && /vvs1\.|valiant licence/i.test(mails[0].text), mails[0]?.text?.slice(0, 80) ?? 'no mail');
  const bad = await applyDecision(await decideEvent(paid(2), { keyPem }), { storeLicence: async () => true, mailer: async () => { throw new Error('smtp down'); } });
  check('a mail failure does not undo the mint', bad.stored === true && bad.mailed === false && /smtp down/.test(bad.mailWhy ?? ''));
  const dup = await applyDecision(await decideEvent(paid(3), { keyPem, licenceExists: () => true }), { storeLicence: async () => { throw new Error('must not store'); } });
  check('a duplicate is not stored again', dup.stored === false && dup.act === 'duplicate');
}

// ── a cancelled subscription revokes
{
  const d = await decideEvent({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_1' } } });
  check('a cancelled subscription is a revocation', d.act === 'revoke' && d.subscription === 'sub_1');
  const res = await applyDecision(d, { revokeLicence: async (sub) => (sub === 'sub_1' ? 1 : 0) });
  check('…and the revocation reports what it touched', res.revoked === 1);
}

console.log(`\n${wrong === 0 ? 'the purchase doors hold: paid mints, failed pays grace, retries do not double-mint, every gap refuses' : `${wrong} case(s) wrong`}\n`);
process.exit(wrong === 0 ? 0 : 1);
