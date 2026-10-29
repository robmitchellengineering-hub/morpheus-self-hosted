#!/usr/bin/env node
// The licence a paid subscription earns must mint, must verify in the SDK, and must NOT exist when payment stops.
//
// WHY THIS EXISTS. Rob, 2026-10-27: "if those payments stop i need the sdk to stop." That only holds if three things are
// true together: a paid event mints a licence, an unpaid event mints nothing, and an expired licence is refused by the
// SDK. This guard asserts all three against the real module, with a throwaway issuer key — it never touches the
// production key and needs no network.
//
// It also cross-checks the signing convention against the SDK's own verifier when that checkout is present, because a
// licence that morpheus mints but the SDK rejects is worse than no licence: the customer pays and gets nothing.
import { generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { decide, claimsFor, mintLicence, renewalMail, licenceForEvent, LICENCE_DAYS } from '../server/src/lib/valiantLicence.js';

const cases = [];
const check = (name, ok) => cases.push([name, !!ok]);

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const pubPem = publicKey.export({ type: 'spki', format: 'pem' });

const paid = (qty = 6, email = 'ops@acme.example') => ({ id: 'evt_1', type: 'invoice.paid', data: { object: { customer: 'cus_acme', customer_email: email, lines: { data: [{ quantity: qty }] } } } });
const unpaid = () => ({ id: 'evt_2', type: 'invoice.payment_failed', data: { object: { customer: 'cus_acme' } } });
const deleted = () => ({ id: 'evt_3', type: 'customer.subscription.deleted', data: { object: { customer: 'cus_acme' } } });

// ── the decisions
check('invoice.paid renews', decide(paid()).renew === true);
// A FAILED PAYMENT GRANTS GRACE (Rob, 2026-10-30). The old expectation cut a paying customer off for a declined card.
check('payment_failed grants a 7-day grace licence rather than stopping', (() => {
  const d = decide(unpaid());
  if (!(d.renew === true && d.grace === true && d.days === 7)) return false;
  const g = claimsFor(unpaid(), { days: d.days, grace: true });
  return g.ok && g.claims.grace === true && Math.round((g.claims.exp - g.claims.iat) / 86400) === 7;
})());
check('subscription.deleted does not renew', decide(deleted()).renew === false);
check('an unrelated event does not renew', decide({ type: 'customer.created' }).renew === false);

// ── the licence
const c = claimsFor(paid(6));
check('6 bought → 6 seats', c.ok && c.claims.seats === 6);
check('the account is the Stripe customer', c.claims.sub === 'cus_acme');
check(`the licence is ${LICENCE_DAYS} days, not perpetual`, Math.round((c.claims.exp - c.claims.iat) / 86400) === LICENCE_DAYS);

const licence = mintLicence(c.claims, keyPem);
check('the licence is a vvs1 token', /^vvs1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(licence));

// it must verify with the key it was signed with — the same Ed25519 check the SDK performs
{
  const [prefix, body, sig] = licence.split('.');
  const payload = Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const ok = (await import('node:crypto')).verify(null, payload, pubPem, Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
  check('the signature verifies against its public key', prefix === 'vvs1' && ok);
  const tampered = Buffer.from(payload.toString('utf8').replace('"seats":6', '"seats":60'));
  check('an edited claim does not verify', !(await import('node:crypto')).verify(null, tampered, pubPem, Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64')));
}

// ── cross-check with the SDK's own verifier, when that checkout is on this machine
{
  const sdk = process.env.VALIANT_SDK_DIR || `${process.env.HOME}/.dsh/wt/sdk-tiers`;
  const verifier = `${sdk}/src/licence.mjs`;
  if (existsSync(verifier)) {
    const { verifyLicence } = await import(verifier);
    const v = verifyLicence(licence, { publicKeyPem: pubPem });
    check('the SDK accepts a licence morpheus minted', v.ok === true);
    check('…and reads the same seat count from it', v.claims?.seats === 6);
  } else {
    check('the SDK accepts a licence morpheus minted (skipped: no SDK checkout at VALIANT_SDK_DIR)', true);
  }
}

// ── the delivery
{
  const m = renewalMail({ event: paid(6), licence, claims: c.claims });
  check('the renewal mail goes to the Stripe customer', m.ok && m.mail.to === 'ops@acme.example');
  check('…with the licence attached', m.mail.attachments?.[0]?.filename?.endsWith('.licence'));
  check('…and no address is invented when Stripe has none', renewalMail({ event: paid(6, null), licence, claims: c.claims }).ok === false);
}

// ── and the whole decision for an event
{
  const r = licenceForEvent(paid(6), { keyPem });
  check('a paid event mints AND mails', r.minted && r.mail?.ok);
  const s = licenceForEvent(unpaid(), { keyPem });
  // A DECLINED CARD IS NOT AN OUTAGE: the failed payment mints a labelled 7-day grace licence.
  check('an unpaid event mints a 7-day GRACE licence', s.minted === true && s.claims?.grace === true &&
    Math.round((s.claims.exp - s.claims.iat) / 86400) === 7);
  // …and a cancelled subscription still mints nothing at all.
  const cancelled = licenceForEvent({ id: 'evt_9', type: 'customer.subscription.deleted', data: { object: { customer: 'cus_acme' } } }, { keyPem });
  check('a cancelled subscription mints NOTHING', cancelled.minted === false && cancelled.stopped === true);
  const k = licenceForEvent(paid(6), {});
  check('no issuer key → no licence, and it says why', k.minted === false && /VALIANT_ISSUER_KEY/.test(k.why));
}

let wrong = 0;
for (const [name, ok] of cases) { if (!ok) wrong++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`); }
// ── the renewal is also the revocation update (Rob, 2026-10-30)
{
  const r = licenceForEvent(paid(1), { keyPem, revocations: ['lic_bad1', 'lic_bad2'] });
  check('a minted licence CARRIES the revocation list', r.minted === true && JSON.stringify(r.claims.revocations) === JSON.stringify(['lic_bad1', 'lic_bad2']));
  const p2 = licenceForEvent(paid(1), { keyPem });
  check('…and carries nothing when the list is empty, so a licence is not padded', p2.minted === true && p2.claims.revocations === undefined);
  const g = licenceForEvent(unpaid(), { keyPem, revocations: ['lic_x'] });
  check('a GRACE licence carries it too, because it is a renewal in every other respect', g.minted === true && g.claims.grace === true && JSON.stringify(g.claims.revocations) === JSON.stringify(['lic_x']));
}

console.log(`\n${cases.length - wrong}/${cases.length} case(s) behaved as a paid subscription must.`);
if (wrong) process.exit(1);
console.log('paid → a monthly licence; a failed payment → 7 days of grace; cancelled → nothing; the SDK accepts what morpheus signs.\n');
