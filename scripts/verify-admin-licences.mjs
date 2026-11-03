#!/usr/bin/env node
// verify-admin-licences.mjs — the rules of the operator's licence register, proven without a database.
//
// WHAT IT PROTECTS. This is the one screen that reads every account's licence. Three things must be true and are easy to
// lose in a refactor: only an admin may ask (401/403), a row's state is derived and never stored, and the owner fields are
// an allow-list (H16 — an admin read is a disclosure decision, not a convenience).
//
// WHY IT IMPORTS A PURE MODULE. The guards job installs nothing, so anything reaching Prisma cannot run here. The handler
// is a query; the rules live in licenceRegister.js, and those are what this proves.
import { stateOf, assertAdmin, normaliseQuery, whereFor, searchFor, ownerView, summarise, rowView, STATE, MAX_LIMIT, DEFAULT_LIMIT } from '../server/src/lib/licenceRegister.js';

let wrong = 0;
const check = (name, ok, detail = '') => {
  if (!ok) wrong++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n          ${detail}`}`);
};
const throws = (fn) => { try { fn(); return null; } catch (e) { return e; } };

const now = Date.parse('2026-11-03T00:00:00Z');
const day = 86_400_000;

// ── state is derived, and a row without an expiry is not active
check('a live row is active',
  stateOf({ expires_at: new Date(now + 30 * day), revoked_at: null }, now) === STATE.ACTIVE);
check('a past expiry is expired',
  stateOf({ expires_at: new Date(now - day), revoked_at: null }, now) === STATE.EXPIRED);
check('revocation wins over a future expiry',
  stateOf({ expires_at: new Date(now + 30 * day), revoked_at: new Date(now - day) }, now) === STATE.REVOKED);
check('a row with no expiry is NOT active — it is expired',
  stateOf({ expires_at: null, revoked_at: null }, now) === STATE.EXPIRED);

// ── only an admin may look
{
  const none = throws(() => assertAdmin(null));
  check('no session is refused with 401', none && none.status === 401);
  const user = throws(() => assertAdmin({ id: 'u1', role: 'user' }));
  check('a signed-in non-admin is refused with 403', user && user.status === 403);
  check('an admin is allowed', assertAdmin({ id: 'u2', role: 'admin' }) === true);
}

// ── the query is clamped, and an unknown state is dropped rather than ignored
{
  const q = normaliseQuery({ q: '  bob@example.com  ', state: 'revoked', limit: '9999', offset: '-5' });
  check('the search is trimmed and clamped to 120 chars', q.q === 'bob@example.com' && normaliseQuery({ q: 'x'.repeat(500) }).q.length === 120);
  check('limit is clamped to the maximum', q.limit === MAX_LIMIT);
  check('a missing limit takes the default', normaliseQuery({}).limit === DEFAULT_LIMIT);
  check('a negative offset becomes 0', q.offset === 0);
  check('an unknown state is dropped, not passed through', normaliseQuery({ state: 'BOGUS' }).state === null);
}

// ── the filters the handler uses
check('active filters on a future expiry and no revocation',
  JSON.stringify(whereFor(STATE.ACTIVE, new Date(now))) === JSON.stringify({ revoked_at: null, expires_at: { gt: new Date(now) } }));
check('revoked filters on a revocation, whatever the expiry',
  JSON.stringify(whereFor(STATE.REVOKED)) === JSON.stringify({ revoked_at: { not: null } }));
check('no state means no extra filter', JSON.stringify(whereFor(null)) === '{}');
check('no search means no filter', JSON.stringify(searchFor('')) === '{}');
{
  const s = searchFor('abc');
  check('a search covers the jti and the account email', /jti/.test(JSON.stringify(s)) && /email/.test(JSON.stringify(s)));
}

// ── the disclosure allow-list: an owner carries three fields and nothing else
{
  const owner = ownerView({ id: 'u1', email: 'a@b.c', full_name: 'A', password_hash: 'SECRET', google_id: 'g-1', otp_code: '123456' });
  check('the owner view has exactly id, email and name', JSON.stringify(Object.keys(owner).sort()) === JSON.stringify(['email', 'id', 'name']));
  check('…and no hash, OAuth id or OTP can reach a browser', !/SECRET|g-1|123456/.test(JSON.stringify(owner)));

  const row = rowView({
    jti: 'lic_1', plan: 'team', seats: 3, kid: 'vvs-2026-11',
    issued_at: new Date(now - day), expires_at: new Date(now + day), revoked_at: null, note: null,
    user: { id: 'u1', email: 'a@b.c', full_name: 'A', password_hash: 'SECRET' },
  }, now);
  check('a register row carries the verdict, not a rule', row.state === STATE.ACTIVE);
  check('…and the row itself leaks nothing from User', !/SECRET/.test(JSON.stringify(row)));
}

// ── the summary counts what is shown, and never renames a state
{
  const rows = [
    { expires_at: new Date(now + day), revoked_at: null },
    { expires_at: new Date(now - day), revoked_at: null },
    { expires_at: new Date(now + day), revoked_at: new Date(now) },
  ];
  const s = summarise(rows, now);
  check('the summary counts each state once', s.active === 1 && s.expired === 1 && s.revoked === 1 && s.shown === 3);
  check('an empty register summarises to zeroes, not nulls', summarise([], now).shown === 0);
}

console.log(wrong === 0
  ? '\nthe register is admin-only, derives its states, and cannot leak a field it was not given\n'
  : `\n${wrong} case(s) failed\n`);
process.exit(wrong ? 1 : 0);
