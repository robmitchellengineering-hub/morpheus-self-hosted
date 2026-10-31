#!/usr/bin/env node
// verify-licence-check.mjs — the public check answers three questions, and fails CLOSED.
//
// No database: the shape and the crypto are separate modules precisely so this runs in the no-install guards job. The endpoint's
// database behaviour (a revocation is reported, an unreadable list is not reported as "fine") is asserted by reading its source,
// which is the honest limit of a text-shaped guard.
import { normalizeCheckBody, peekClaims, checkReply, MAX_TOKEN } from '../server/src/lib/licenceCheckShape.js';
import { verifyToken } from '../server/src/lib/licenceVerify.js';
import { signLicence } from '../server/src/lib/licenceKey.js';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
let wrong = 0;
const check = (n, ok, detail = '') => { if (!ok) wrong++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${ok || !detail ? '' : `\n          ${detail}`}`); };

// a throwaway issuer whose PUBLIC half we point the verifier at — the shipped key signs nothing here.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
process.env.VALIANT_LICENCE_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'pem' });
const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const now = Math.floor(Date.now() / 1000);
const claims = (o = {}) => ({ v: 1, sub: 'acct_1', plan: 'solo', seats: 1, runners: 1, iat: now - 60, exp: now + 86400, kid: 'vvs-test', jti: 'lic_check_1', ...o });

// ── shape
{
  check('a real token shape is accepted', normalizeCheckBody({ licence: 'vvs1.aaa.bbb' }).ok === true);
  check('an empty body is refused with a reason', normalizeCheckBody({}).why === 'no licence given');
  check('an oversized token is refused before parsing', normalizeCheckBody({ licence: `vvs1.${'a'.repeat(MAX_TOKEN)}.x` }).why.includes('longer than'));
  check('a token that is not ours is refused by name', normalizeCheckBody({ licence: 'abc.def.ghi' }).why.includes('not a licence'));
  check('two parts is not a token', normalizeCheckBody({ licence: 'vvs1.aaa' }).why.includes('three dot-separated'));
  check('claims can be peeked without trusting them', peekClaims('vvs1.' + Buffer.from(JSON.stringify({ jti: 'x' })).toString('base64url') + '.sig').claims.jti === 'x');
}

// ── crypto
{
  const token = signLicence(claims(), keyPem);
  const v = verifyToken(token, now);
  check('a signed licence verifies', v.ok === true && v.claims.jti === 'lic_check_1');
  check('an edited licence is refused', verifyToken(token.slice(0, -3) + 'AAA', now).ok === false);
  check('…and says so without echoing the token', !verifyToken(token.slice(0, -3) + 'AAA', now).why.includes('vvs1.'));
  check('an expired licence is refused, and says how long ago', verifyToken(signLicence(claims({ exp: now - 2 * 86400 }), keyPem), now).why.includes('expired 2 day'));
  check('a token signed by another key is refused', (() => {
    const other = generateKeyPairSync('ed25519');
    const forged = signLicence(claims(), other.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    return verifyToken(forged, now).ok === false;
  })());
  check('no public key at all refuses rather than assuming', (() => {
    const saved = process.env.VALIANT_LICENCE_PUBLIC_KEY;
    process.env.VALIANT_LICENCE_PUBLIC_KEY = '';
    const r = verifyToken(signLicence(claims(), keyPem), now);
    process.env.VALIANT_LICENCE_PUBLIC_KEY = saved;
    return r.ok === false;
  })());
}

// ── the reply the SDK reads
{
  const good = checkReply({ valid: true, claims: claims() });
  check('a valid reply names the jti and the term', good.valid === true && good.jti === 'lic_check_1' && good.exp === claims().exp);
  const bad = checkReply({ valid: false, why: 'expired' });
  check('a refusal carries a reason and no claims', bad.valid === false && bad.why === 'expired' && bad.jti === undefined);
  check('a revoked reply says revoked, not merely invalid', checkReply({ valid: false, revoked: true, why: 'x' }).revoked === true);
}

// ── the endpoint's decisions, by reading it
{
  const src = readFileSync(join(HERE, '..', 'server', 'src', 'functions', 'licenceCheck.js'), 'utf8');
  // The decision moved to lib/licenceDecision.js so it can be exercised without prisma; these read THAT file, and the endpoint is pinned to
  // delegating to it — otherwise "the check fails closed" could be true of a module nobody calls.
  const decisionSrc = readFileSync(join(HERE, '..', 'server/src/lib/licenceDecision.js'), 'utf8');
  const endpointSrc = readFileSync(join(HERE, '..', 'server/src/functions/licenceCheck.js'), 'utf8');
  check('the decision reads a revocation from the database', /revoked_at/.test(decisionSrc) && /revoked/.test(decisionSrc));
  check('…and an unreadable list is NOT reported as valid', /could not be read/.test(decisionSrc));
  check('…using the shape module rather than its own parsing', /normalizeCheckBody/.test(decisionSrc));
  check('…and the public endpoint delegates to it', /decideCheck/.test(endpointSrc));
}


// ── the database is the only fact the token cannot carry, so its failure must be executable
{
  const { lookupRevocation } = await import('../server/src/lib/licenceDecision.js');
  const ok = await lookupRevocation('j1', { $queryRaw: async () => [{ revoked_at: null }] });
  check('a licence with no revocation row reads as not revoked', ok === false);
  const revoked = await lookupRevocation('j1', { $queryRaw: async () => [{ revoked_at: new Date() }] });
  check('…and a revoked_at reads as revoked', revoked === true);
  let threw = false;
  try { await lookupRevocation('j1', { $queryRaw: async () => { throw new Error('connection terminated'); } }); } catch { threw = true; }
  check('an unreadable database THROWS, so the endpoint can answer "could not be read"', threw);
}


// ── and the ENDPOINT, not just the lookup, fails closed when the database does not answer
{
  const { decideCheck } = await import('../server/src/lib/licenceDecision.js');
  const token = signLicence(claims({ kid: 'vvs-test' }), keyPem);
  const reply = await decideCheck({ body: { licence: token }, db: { $queryRaw: async () => { throw new Error('connection terminated'); } } });
  check('an unreadable database is NOT reported as valid', reply.valid === false, JSON.stringify(reply).slice(0, 160));
  check('…and the reason names the list that could not be read', /could not be read/.test(reply.why ?? ''), `why=${reply.why}`);
  check('…while a readable, unrevoked licence is valid', (await decideCheck({ body: { licence: token }, db: { $queryRaw: async () => [{ revoked_at: null }] } })).valid === true);
}

console.log(`\n${wrong === 0 ? 'the public check verifies, reports revocation, and fails closed' : `${wrong} case(s) wrong — fix before merging`}\n`);
process.exit(wrong === 0 ? 0 : 1);
